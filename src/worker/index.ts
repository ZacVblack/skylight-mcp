/**
 * Cloudflare Worker: remote MCP server for Skylight, for Claude and Claude Duet.
 *
 * One Worker plays both OAuth roles from @cloudflare/workers-oauth-provider:
 *   - authorization server: Claude registers itself, sends the user to
 *     /authorize, and exchanges codes at /oauth/token
 *   - resource server: /mcp accepts the tokens it issued
 *
 * Signing in to Skylight is the same browser-paste flow as the local CLI, but
 * the PKCE verifier lives in the provider's upstream transaction (bound to
 * the browser by a __Host- cookie) instead of a file. The Skylight tokens are
 * stored in the grant's encrypted props; this Worker keeps no other state.
 */

import {
  AuthorizationError,
  OAuthAuthorizationServer,
  OAuthError as ProviderOAuthError,
  OAuthResourceServer,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { timingSafeEqual } from "node:crypto";
import { detectSubscriptionStatus } from "../api/auth.js";
import {
  OAuthError,
  authorizeUrlFor,
  completeBrowserLogin,
  newPendingLogin,
  refreshCredential,
  type PendingLogin,
} from "../api/oauth.js";
import { HOSTED_EFFECTS, handleMcpRequest } from "./mcp.js";
import { consentPage, errorPage, html, landingPage, pastePage, setupPage, versionResponse } from "./pages.js";
import { accessTokenTtlSeconds, isSkylightProps, toCredential, withCredential, type SkylightProps } from "./props.js";

export interface Env {
  OAUTH_KV: KVNamespace;
  /** Public origin of this Worker, e.g. https://skylight-mcp.example.workers.dev */
  WORKER_URL: string;
  /** Secret. Required on the consent page before anyone can link a Skylight account. */
  SETUP_PASSPHRASE: string;
  DEFAULT_TIMEZONE?: string;
}

const SCOPE = "skylight";
const VERSION = "1.11.0";

interface UpstreamData {
  codeVerifier: string;
  fingerprint: string;
  frameId: string;
  timezone: string;
}

interface Servers {
  auth: OAuthAuthorizationServer<Env>;
  resource: OAuthResourceServer<Env, SkylightProps>;
  issuer: string;
  resourceUrl: string;
}

let cached: { key: string; servers: Servers } | null = null;

export function getServers(env: Env): Servers {
  const issuer = new URL(env.WORKER_URL).origin;
  if (cached?.key === issuer) return cached.servers;

  const resourceUrl = `${issuer}/mcp`;
  const auth = new OAuthAuthorizationServer<Env>({
    issuer,
    resources: [resourceUrl],
    scopesSupported: [SCOPE],
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    tokenExchangeCallback: async ({ grantType, props, env }) => {
      if (!isSkylightProps(props)) {
        throw new ProviderOAuthError("invalid_grant", { description: "Grant is missing its Skylight credential" });
      }
      if (grantType === "authorization_code") {
        return { accessTokenTTL: accessTokenTtlSeconds(props) };
      }
      if (grantType === "refresh_token") {
        let next: SkylightProps;
        try {
          next = withCredential(props, await refreshCredential(toCredential(props)));
        } catch (error) {
          if (error instanceof OAuthError && /HTTP 4\d\d/.test(error.message)) {
            // Skylight rejected the refresh token: the user must sign in again.
            throw new ProviderOAuthError("invalid_grant", { description: "Skylight sign-in has expired" });
          }
          throw new ProviderOAuthError("temporarily_unavailable", {
            description: "Skylight could not be reached",
            statusCode: 503,
          });
        }
        void env;
        return { newProps: next, accessTokenProps: next, accessTokenTTL: accessTokenTtlSeconds(next) };
      }
      return undefined;
    },
  });

  const resource = new OAuthResourceServer<Env, SkylightProps>({
    resourceMetadata: {
      resource: resourceUrl,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      resource_name: "Skylight Calendar",
    },
    requiredScopes: [SCOPE],
    validateToken: (env) => (resourceId, token) => auth.validateToken<SkylightProps>(resourceId, token, env),
    handler: {
      fetch(request, _env, ctx) {
        if (!ctx.auth.scope.includes(SCOPE)) {
          return new Response("insufficient_scope", { status: 403 });
        }
        if (!isSkylightProps(ctx.props)) {
          return new Response("Grant is missing its Skylight credential; reconnect.", { status: 401 });
        }
        return handleMcpRequest(request, ctx.props, VERSION);
      },
    },
  });

  const servers = { auth, resource, issuer, resourceUrl };
  cached = { key: issuer, servers };
  return servers;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- /authorize

async function showConsent(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  return html(consentPage(details, consent.handle, { timezone: env.DEFAULT_TIMEZONE ?? "America/New_York" }), consent.headers);
}

async function handleConsent(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");

  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  // The passphrase gate: anyone can reach this page, only the deployer's
  // household should be able to link a Skylight account to it.
  const passphrase = String(form.get("passphrase") ?? "");
  if (!env.SETUP_PASSPHRASE || env.SETUP_PASSPHRASE.length < 12) {
    return errorPage("This server has no setup passphrase configured. Set the SETUP_PASSPHRASE secret.", 503);
  }
  if (!safeEqual(passphrase, env.SETUP_PASSPHRASE)) {
    return errorPage("Wrong setup passphrase.", 403);
  }

  const frameId = String(form.get("frameId") ?? "").trim();
  const timezone = String(form.get("timezone") ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(frameId)) return errorPage("Frame ID must be the number from your Skylight URL.");
  if (!validTimezone(timezone)) return errorPage(`"${timezone}" is not a recognised timezone.`);

  const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });

  // Generate the PKCE verifier now and keep it server-side, bound to this
  // browser by the provider's upstream transaction. The provider picks the
  // state; Skylight will echo it back in the pasted URL.
  const draft = newPendingLogin();
  const data: UpstreamData = { codeVerifier: draft.codeVerifier, fingerprint: draft.fingerprint, frameId, timezone };
  const upstream = await oauth.beginUpstream(approved.request, { data, headers: approved.headers });
  const loginUrl = authorizeUrlFor({ ...draft, state: upstream.state });
  return html(pastePage(loginUrl, upstream.state), upstream.headers);
}

// ------------------------------------------------------------------ /callback

async function handleCallback(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  const form = await request.formData();
  const state = String(form.get("state") ?? "");
  const pastedUrl = String(form.get("url") ?? "");

  // finishUpstream reads `state` from the query string of a provider redirect.
  // Our "provider redirect" is a paste, so present the state the same way,
  // carrying the browser's cookies along for the binding check.
  const resumeUrl = new URL("/callback", env.WORKER_URL);
  resumeUrl.searchParams.set("state", state);
  const resumed = await oauth.finishUpstream<UpstreamData>(new Request(resumeUrl, { headers: request.headers }));

  const pending: PendingLogin = {
    state,
    codeVerifier: resumed.data.codeVerifier,
    fingerprint: resumed.data.fingerprint,
    createdAt: Date.now(), // the provider already enforced its own TTL
  };
  const credential = await completeBrowserLogin(pastedUrl, pending);
  const hasPlus = (await detectSubscriptionStatus(credential.accessToken)) === "plus";

  const props: SkylightProps = withCredential(
    { accessToken: "", refreshToken: "", fingerprint: "", expiresAt: 0, frameId: resumed.data.frameId, timezone: resumed.data.timezone, hasPlus },
    credential
  );
  const { redirectTo } = await oauth.completeAuthorization({
    request: resumed.request,
    userId: `frame-${resumed.data.frameId}`,
    metadata: { linkedAt: new Date().toISOString(), hasPlus },
    scope: [SCOPE],
    props,
  });
  resumed.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: resumed.headers });
}

// -------------------------------------------------------------------- routing

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { auth, resource } = getServers(env);
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/" && request.method === "GET") return landingPage();
      if (path === "/healthz") return new Response("ok");
      if (path === "/version" && request.method === "GET") return versionResponse(VERSION);
      if (path === "/setup" && request.method === "GET") return setupPage(url.origin, env.DEFAULT_TIMEZONE ?? "America/New_York");

      if (path === "/mcp" || path.startsWith("/.well-known/oauth-protected-resource")) {
        return await resource.fetch(request, env, ctx);
      }

      const oauth = auth.getOAuthApi(env);
      if (path === "/authorize" && request.method === "GET") return await showConsent(request, env, oauth);
      if (path === "/authorize" && request.method === "POST") return await handleConsent(request, env, oauth);
      if (path === "/callback" && request.method === "POST") return await handleCallback(request, env, oauth);

      return await auth.fetch(request, env, ctx);
    } catch (error) {
      if (error instanceof AuthorizationError) return errorPage(error.message, 400);
      if (error instanceof OAuthError) return errorPage(error.message, 400);
      console.error("[worker] unhandled", error instanceof Error ? error.message : String(error));
      return errorPage("Internal error.", 500);
    }
  },
};

export { HOSTED_EFFECTS };
