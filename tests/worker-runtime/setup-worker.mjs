// A minimal Worker that runs the library's setup entry and read entry inside the Workers runtime.
// Bundled by tests/setup-worker-runtime.test.ts; outbound fetch is answered by the test.
import { beginLogin, completeLogin, loginStatus } from "../../dist/setup.js";
import { createSkylight } from "../../dist/lib.js";

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const attempt = async (fn) => { try { return { ok: await fn() }; } catch (e) { return { name: e?.name, code: e?.code, message: String(e?.message) }; } };

export default {
  async fetch() {
    let pendingValue = null;
    const pending = { save: async (v) => { pendingValue = v; }, take: async () => { const v = pendingValue; pendingValue = null; return v; } };
    let stored = null; let writes = 0;
    const credential = { name: "memory", read: async () => stored, write: async (c) => { stored = c; writes++; }, delete: async () => { const had = stored !== null; stored = null; return had; } };

    const started = await beginLogin({ pending });
    const login = new URL(started.loginUrl);
    const record = JSON.parse(pendingValue);
    // Web Crypto, independent of the library's node:crypto path: the challenge must be S256 of the verifier.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(record.codeVerifier));
    const state = login.searchParams.get("state");

    const hostile = await attempt(() => completeLogin({ pending, credential, redirectUrl: `https://evil.example/welcome?code=CODE-W&state=${state}` }));
    const done = await attempt(() => completeLogin({ pending, credential, redirectUrl: `https://ourskylight.com/welcome?code=CODE-W&state=${state}` }));
    const replay = await attempt(() => completeLogin({ pending, credential, redirectUrl: `https://ourskylight.com/welcome?code=CODE-W&state=${state}` }));
    const status = await loginStatus({ credential });
    const sources = await attempt(() => createSkylight({ frameId: "123", timezone: "America/Los_Angeles", credential }).calendar.sources());

    // A second attempt with the wrong state, in the same runtime.
    const again = await beginLogin({ pending });
    const wrongState = await attempt(() => completeLogin({ pending, credential, redirectUrl: `https://ourskylight.com/welcome?code=CODE-W&state=${"0".repeat(32)}` }));

    return Response.json({
      loginHost: login.host,
      method: login.searchParams.get("code_challenge_method"),
      challengeOk: login.searchParams.get("code_challenge") === b64url(digest),
      verifierLength: record.codeVerifier.length,
      stateLength: state.length,
      statesDiffer: new URL(again.loginUrl).searchParams.get("state") !== state,
      hostile: hostile.code, done: done.ok, replay: replay.code, wrongState: wrongState.code,
      status, writes,
      storedOk: stored?.accessToken === "AT-worker-1" && stored?.refreshToken === "RT-worker-1" && typeof stored?.fingerprint === "string",
      sources: sources.ok ?? sources,
      returned: JSON.stringify([started, done, status]),
      verifier: record.codeVerifier,
    });
  },
};
