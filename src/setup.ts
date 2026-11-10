/**
 * Setup-only entry (`@davidwoods/skylight-mcp/setup`): the browser-paste sign-in for an
 * importer that keeps its own credential store, such as an app's Durable Object.
 * EXPERIMENTAL, like the main library entry.
 *
 * Kept apart from the read surface on purpose: call it from a setup page only, never from
 * request handling. What an importer can rely on:
 * - No function here returns a token, the PKCE verifier or the authorization code. The
 *   credential is written straight into the store you pass.
 * - PKCE (S256) and the state check are always on. A pending login works once and for ten
 *   minutes.
 * - The only address accepted is the Skylight redirect the person pastes after signing in
 *   (the pinned web origin, path /welcome). Anything else is refused before any request,
 *   and the input is never echoed in an error. The code goes to the pinned API host only.
 * - There is no host, base URL or fetch option.
 * Limit: the library cannot know who is calling. Protect your setup page yourself.
 */
import { SKYLIGHT_WEB_APP_URL } from "./api/constants.js";
import type { CredentialStore } from "./api/credential-types.js";
import {
  OAuthError,
  PENDING_LOGIN_TTL_MS,
  authorizeUrlFor,
  completeBrowserLogin,
  isExpired,
  newPendingLogin,
  type PendingLogin,
} from "./api/oauth.js";

export type { CredentialStore };

/**
 * Where the pending login lives between `beginLogin` and `completeLogin`. The value is an
 * opaque string: store it as given, never log it, and make `take` atomic (return the value
 * and delete it in one step) so a pending login cannot be used twice.
 */
export interface PendingLoginStore {
  save(value: string): Promise<void>;
  take(): Promise<string | null>;
}

export type SetupErrorCode = "bad_options" | "no_pending_login" | "expired" | "bad_redirect_url" | "state_mismatch" | "skylight_refused" | "store_failed";

/** Errors thrown here are plain `Error`s with `name` "SkylightSetupError" and a `code`. */
export interface SkylightSetupError extends Error {
  name: "SkylightSetupError";
  code: SetupErrorCode;
}

const MESSAGES: Record<SetupErrorCode, string> = {
  bad_options: "Invalid options.",
  no_pending_login: "No sign-in is in progress. Start again.",
  expired: "The sign-in attempt expired. Start again.",
  bad_redirect_url: "That is not the Skylight address shown after signing in. Start again and paste the complete address.",
  state_mismatch: "That address belongs to a different sign-in attempt. Start again.",
  skylight_refused: "Skylight did not accept the sign-in. Start again.",
  store_failed: "The sign-in worked but the credential could not be saved. Start again.",
};

function fail(code: SetupErrorCode, detail?: string): never {
  const error = new Error(detail ? `${MESSAGES[code]} ${detail}` : MESSAGES[code]) as SkylightSetupError;
  error.name = "SkylightSetupError";
  error.code = code;
  throw error;
}

function onlyKeys(options: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!options || typeof options !== "object") fail("bad_options", "An options object is required.");
  for (const key of Object.keys(options as object)) {
    if (!allowed.includes(key)) fail("bad_options", `Unknown option "${key}". The API host is fixed and cannot be configured.`);
  }
  return options as Record<string, unknown>;
}

function pendingStore(value: unknown): PendingLoginStore {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || typeof v.save !== "function" || typeof v.take !== "function") {
    fail("bad_options", "pending must be a store with save and take.");
  }
  return value as PendingLoginStore;
}

function credentialStore(value: unknown): CredentialStore {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || typeof v.read !== "function" || typeof v.write !== "function" || typeof v.delete !== "function") {
    fail("bad_options", "credential must be a store with read, write and delete.");
  }
  return value as CredentialStore;
}

function parsePending(raw: string | null): PendingLogin {
  if (raw === null || raw === undefined) fail("no_pending_login");
  let v: Partial<PendingLogin>;
  try {
    v = JSON.parse(raw as string) as Partial<PendingLogin>;
  } catch {
    fail("no_pending_login");
  }
  if (!v || typeof v.state !== "string" || typeof v.codeVerifier !== "string" || typeof v.fingerprint !== "string" || typeof v.createdAt !== "number" || !v.state || !v.codeVerifier) {
    fail("no_pending_login");
  }
  return { state: v.state, codeVerifier: v.codeVerifier, fingerprint: v.fingerprint, createdAt: v.createdAt };
}

/** The pasted address must be the pinned Skylight redirect and nothing else. Never echoed. */
function checkedRedirect(input: unknown): string {
  if (typeof input !== "string" || input.length > 4096) fail("bad_redirect_url");
  let url: URL;
  try {
    url = new URL((input as string).trim());
  } catch {
    fail("bad_redirect_url");
  }
  if (url.origin !== SKYLIGHT_WEB_APP_URL || url.pathname !== "/welcome" || url.username !== "" || url.password !== "") {
    fail("bad_redirect_url");
  }
  return url.toString();
}

/**
 * Start a sign-in. Saves the pending login in your store and returns the address to open in
 * the person's browser. They sign in at Skylight, which then shows an address starting
 * https://ourskylight.com/welcome?code=... ; pass that address to `completeLogin`.
 */
export async function beginLogin(options: { pending: PendingLoginStore }): Promise<{ loginUrl: string; expiresInMinutes: number }> {
  const o = onlyKeys(options, ["pending"]);
  const store = pendingStore(o.pending);
  const pending = newPendingLogin();
  try {
    await store.save(JSON.stringify(pending));
  } catch {
    fail("store_failed", "The pending sign-in could not be saved.");
  }
  return { loginUrl: authorizeUrlFor(pending), expiresInMinutes: PENDING_LOGIN_TTL_MS / 60_000 };
}

/**
 * Finish a sign-in. Takes the pending login (so it cannot be used again, whatever happens
 * next), checks the pasted address, exchanges the code at the pinned API host and writes the
 * credential into your store. Nothing secret is returned. On any failure the credential
 * store is not written.
 */
export async function completeLogin(options: { pending: PendingLoginStore; credential: CredentialStore; redirectUrl: string }): Promise<{ signedIn: true; expiresAt: number }> {
  const o = onlyKeys(options, ["pending", "credential", "redirectUrl"]);
  const pendingFrom = pendingStore(o.pending);
  const store = credentialStore(o.credential);
  const redirect = checkedRedirect(o.redirectUrl);

  let raw: string | null;
  try {
    raw = await pendingFrom.take();
  } catch {
    fail("no_pending_login");
  }
  const pending = parsePending(raw);

  let credential;
  try {
    credential = await completeBrowserLogin(redirect, pending);
  } catch (error) {
    // Our own wording only: the underlying message can quote Skylight's response or the CLI.
    if (error instanceof OAuthError) {
      if (error.kind === "expired") fail("expired");
      if (error.kind === "bad_url") fail("bad_redirect_url");
      if (error.kind === "state") fail("state_mismatch");
    }
    fail("skylight_refused");
  }

  try {
    await store.write(credential);
  } catch {
    fail("store_failed");
  }
  return { signedIn: true, expiresAt: credential.expiresAt };
}

/** Whether your store holds a credential. Returns no part of it. */
export async function loginStatus(options: { credential: CredentialStore }): Promise<{ signedIn: boolean; expired: boolean; expiresAt: number | null }> {
  const o = onlyKeys(options, ["credential"]);
  const store = credentialStore(o.credential);
  let credential;
  try {
    credential = await store.read();
  } catch {
    fail("store_failed", "The credential store could not be read.");
  }
  if (!credential) return { signedIn: false, expired: false, expiresAt: null };
  return { signedIn: true, expired: isExpired(credential), expiresAt: credential.expiresAt };
}
