/**
 * Browser-paste OAuth login and token refresh.
 *
 * The user signs in to Skylight in their own browser, then pastes the final
 * https://ourskylight.com/welcome?code=... URL back into the CLI. The password
 * never reaches this process. The authorization code is bound to a PKCE
 * verifier and a random state value that are kept in a short-lived, 0600
 * "pending login" file between the two CLI steps.
 *
 * Design informed by kamilio/skylight-calendar-agent (MIT); see
 * THIRD_PARTY_NOTICES.md. Unlike that project's flow, this one uses PKCE (S256)
 * and verifies the returned state against the pending login.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { SKYLIGHT_BASE_URL, SKYLIGHT_WEB_APP_URL } from "./constants.js";

export const OAUTH_CLIENT_ID = "skylight-mobile";
const SCOPE = "everything";
const REDIRECT_URI = `${SKYLIGHT_WEB_APP_URL}/welcome`;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_FIELD_LENGTH = 8_192;
const DEFAULT_EXPIRES_IN_S = 3_600;

/** How long a pending login stays valid between `auth login` and `auth complete`. */
export const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;

/** Refresh this long before the access token actually expires. */
export const EXPIRY_SKEW_MS = 60 * 1000;

export interface StoredCredential {
  version: 1;
  type: "oauth";
  accessToken: string;
  refreshToken: string;
  /** Stable per-install device id; sent with every token request. */
  fingerprint: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface PendingLogin {
  state: string;
  codeVerifier: string;
  fingerprint: string;
  createdAt: number;
}

/** Why a login step failed, for callers that write their own message (the library setup entry). */
export type OAuthErrorKind = "expired" | "bad_url" | "state" | "token";

export class OAuthError extends Error {
  readonly kind: OAuthErrorKind;
  constructor(message: string, kind: OAuthErrorKind = "token") {
    super(message);
    this.name = "OAuthError";
    this.kind = kind;
  }
}

type FetchLike = typeof fetch;

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function deviceMetadata(fingerprint: string): Record<string, string> {
  const hardware =
    process.platform === "darwin"
      ? "Macintosh"
      : process.platform === "win32"
        ? "Windows"
        : process.platform === "linux"
          ? "Linux"
          : process.platform;
  return {
    skylight_api_client_device_fingerprint: fingerprint,
    skylight_api_client_device_platform: "web",
    skylight_api_client_device_name: "unknown",
    skylight_api_client_device_os_version: "unknown",
    skylight_api_client_device_app_version: "unknown",
    skylight_api_client_device_hardware: hardware,
  };
}

/** The S256 challenge for a verifier. */
export function codeChallengeFor(codeVerifier: string): string {
  return base64url(createHash("sha256").update(codeVerifier).digest());
}

/** Fresh PKCE verifier, state and device fingerprint for a new login. */
export function newPendingLogin(now: number = Date.now(), overrides: Partial<Pick<PendingLogin, "state" | "fingerprint">> = {}): PendingLogin {
  return {
    state: overrides.state ?? randomBytes(16).toString("hex"),
    codeVerifier: base64url(randomBytes(32)),
    fingerprint: overrides.fingerprint ?? randomUUID(),
    createdAt: now,
  };
}

/** The Skylight authorize URL for a pending login. */
export function authorizeUrlFor(pending: PendingLogin): string {
  const url = new URL("/oauth/authorize", SKYLIGHT_BASE_URL);
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", pending.state);
  url.searchParams.set("code_challenge", codeChallengeFor(pending.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("skylight_api_client_device_fingerprint", pending.fingerprint);
  return url.toString();
}

/**
 * Start a login: returns the URL the user must open in their browser and the
 * pending-login record the caller must persist until `completeBrowserLogin`.
 */
export function beginBrowserLogin(
  now: number = Date.now(),
  overrides: Partial<Pick<PendingLogin, "state" | "fingerprint">> = {}
): { loginUrl: string; pending: PendingLogin } {
  const pending = newPendingLogin(now, overrides);
  return { loginUrl: authorizeUrlFor(pending), pending };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Extract and validate the authorization code from the pasted callback URL. */
export function parseCallbackUrl(callbackUrl: string, pending: PendingLogin, now: number = Date.now()): string {
  if (now - pending.createdAt > PENDING_LOGIN_TTL_MS) {
    throw new OAuthError("The login attempt expired. Run `skylight-mcp auth login` again.", "expired");
  }

  let callback: URL;
  try {
    callback = new URL(callbackUrl.trim());
  } catch {
    throw new OAuthError("Paste the complete URL shown in your browser after signing in.", "bad_url");
  }

  const expected = new URL(REDIRECT_URI);
  if (callback.protocol !== "https:" || callback.hostname !== expected.hostname || callback.pathname !== expected.pathname) {
    throw new OAuthError(`The URL must start with ${REDIRECT_URI}.`, "bad_url");
  }

  const error = callback.searchParams.get("error");
  if (error) {
    throw new OAuthError(`Skylight returned an error during sign-in: ${error.slice(0, 100)}`, "bad_url");
  }

  const code = callback.searchParams.get("code");
  const state = callback.searchParams.get("state");
  if (!code || !state) {
    throw new OAuthError("The URL did not contain a code and state. Run `skylight-mcp auth login` again.", "bad_url");
  }
  if (code.length > MAX_FIELD_LENGTH || state.length > MAX_FIELD_LENGTH) {
    throw new OAuthError("The URL contained an unexpectedly long value.", "bad_url");
  }
  if (!safeEqual(state, pending.state)) {
    throw new OAuthError("State mismatch: this URL does not belong to the pending login. Run `skylight-mcp auth login` again.", "state");
  }
  return code;
}

async function tokenRequest(
  values: URLSearchParams,
  fingerprint: string,
  fetchImpl: FetchLike,
  now: number
): Promise<StoredCredential> {
  const response = await fetchImpl(`${SKYLIGHT_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: values,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    // Error bodies carry OAuth error codes only; cap length defensively.
    throw new OAuthError(`Skylight token request failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new OAuthError("Skylight token response was not valid JSON.");
  }

  const accessToken = json.access_token ?? json.token;
  if (typeof accessToken !== "string" || accessToken.length === 0 || accessToken.length > MAX_FIELD_LENGTH) {
    throw new OAuthError("Skylight token response did not contain an access token.");
  }
  const refreshToken = json.refresh_token;
  if (typeof refreshToken !== "string" || refreshToken.length === 0 || refreshToken.length > MAX_FIELD_LENGTH) {
    throw new OAuthError("Skylight token response did not contain a refresh token.");
  }
  const expiresIn =
    typeof json.expires_in === "number" && Number.isFinite(json.expires_in) && json.expires_in > 0
      ? json.expires_in
      : DEFAULT_EXPIRES_IN_S;

  return {
    version: 1,
    type: "oauth",
    accessToken,
    refreshToken,
    fingerprint,
    expiresAt: now + Math.floor(expiresIn * 1000),
  };
}

/** Exchange the pasted callback URL for a credential. */
export async function completeBrowserLogin(
  callbackUrl: string,
  pending: PendingLogin,
  fetchImpl: FetchLike = fetch,
  now: number = Date.now()
): Promise<StoredCredential> {
  const code = parseCallbackUrl(callbackUrl, pending, now);
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OAUTH_CLIENT_ID,
      scope: SCOPE,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: pending.codeVerifier,
      ...deviceMetadata(pending.fingerprint),
    }),
    pending.fingerprint,
    fetchImpl,
    now
  );
}

/** Use the refresh token to obtain a new credential. Refresh tokens rotate. */
export async function refreshCredential(
  credential: StoredCredential,
  fetchImpl: FetchLike = fetch,
  now: number = Date.now()
): Promise<StoredCredential> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OAUTH_CLIENT_ID,
      refresh_token: credential.refreshToken,
      ...deviceMetadata(credential.fingerprint),
    }),
    credential.fingerprint,
    fetchImpl,
    now
  );
}

export function isExpired(credential: StoredCredential, now: number = Date.now()): boolean {
  return credential.expiresAt - EXPIRY_SKEW_MS <= now;
}

export function parseStoredCredential(value: unknown): StoredCredential | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<StoredCredential>;
  if (
    record.version !== 1 ||
    record.type !== "oauth" ||
    typeof record.accessToken !== "string" ||
    typeof record.refreshToken !== "string" ||
    typeof record.fingerprint !== "string" ||
    typeof record.expiresAt !== "number" ||
    !Number.isFinite(record.expiresAt)
  ) {
    return null;
  }
  return record as StoredCredential;
}
