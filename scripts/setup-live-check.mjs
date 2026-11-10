// Live check of the setup entry (browser-paste sign-in) against real Skylight. Run from the clone after `npm run build`:
//   node scripts/setup-live-check.mjs
// It makes a NEW, separate sign-in held only in this process's memory: nothing is written to the
// Keychain, the settings file or disk, and the credential is gone when the script exits (the session
// is not revoked on Skylight's side). It prints pass/fail and counts, never a token, code or verifier.
// Do not paste the redirect address anywhere except this prompt.
import readline from "node:readline/promises";
import { beginLogin, completeLogin, loginStatus } from "../dist/setup.js";
import { createSkylight } from "../dist/lib.js";
import { readConfigFile } from "../dist/config-file.js";

const cfg = await readConfigFile();
if (!cfg) { console.error("No settings file. Run `skylight-mcp init` first."); process.exit(2); }

let pendingValue = null;
const pending = { save: async (v) => { pendingValue = v; }, take: async () => { const v = pendingValue; pendingValue = null; return v; } };
let stored = null; let writes = 0;
const credential = { name: "memory (this process only)", read: async () => stored, write: async (c) => { stored = c; writes++; }, delete: async () => { const had = stored !== null; stored = null; return had; } };

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"} ${label}`); if (!ok) failures++; };

const before = await loginStatus({ credential });
check(before.signedIn === false, "status before sign-in: signed out");

const started = await beginLogin({ pending });
console.log("\n1. Open this address in your browser and sign in to Skylight:\n");
console.log(`   ${started.loginUrl}\n`);
console.log("2. Skylight bounces through https://ourskylight.com/welcome?code=... too fast to copy.");
console.log("   Get it from browser history (Cmd-Y, search \"welcome?code\", newest entry, Copy link address).");
console.log(`   This attempt expires in ${started.expiresInMinutes} minutes.\n`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const redirectUrl = await rl.question("3. Paste the full address here and press Enter: ");
rl.close();
console.log("");

let done = null;
try {
  done = await completeLogin({ pending, credential, redirectUrl });
} catch (e) {
  console.log(`FAIL completeLogin: ${e?.name ?? "Error"} ${e?.code ?? ""} - ${e?.message ?? ""}`);
  process.exit(1);
}
const secrets = stored ? [stored.accessToken, stored.refreshToken] : [];
const returned = JSON.stringify([started, done]);
check(done.signedIn === true && typeof done.expiresAt === "number", "completeLogin: signed in, expiry returned");
check(writes === 1 && stored !== null, "credential written to the store exactly once");
check(secrets.length === 2 && secrets.every((s) => typeof s === "string" && s.length > 0 && !returned.includes(s)), "no token in anything the functions returned");
check(pendingValue === null, "pending sign-in consumed");

const after = await loginStatus({ credential });
check(after.signedIn === true && after.expired === false, `status after sign-in: signed in, expires in about ${Math.round((after.expiresAt - Date.now()) / 60_000)} minutes`);

const replay = await completeLogin({ pending, credential, redirectUrl }).then(() => "accepted", (e) => e?.code);
check(replay === "no_pending_login", "the same address cannot be used twice");

try {
  const skylight = createSkylight({ frameId: cfg.frameId, timezone: cfg.timezone, credential });
  const sources = await skylight.calendar.sources();
  check(Array.isArray(sources) && sources.length > 0, `the new credential reads your frame (${sources.length} calendar sources)`);
} catch (e) {
  check(false, `read with the new credential threw ${e?.name ?? "Error"}`);
}

console.log(failures === 0 ? "\nPASS: the setup entry signs in against real Skylight." : `\nFAIL: ${failures} check(s) failed.`);
console.log("Now check the OTHER sessions still work: run `doctor` (Mac Keychain session) and one read through Duet (hosted session).");
process.exit(failures === 0 ? 0 : 1);
