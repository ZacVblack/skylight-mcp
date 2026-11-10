// Live check of the library entry against your own frame. Run from the clone after `npm run build`:
//   node scripts/library-live-check.mjs
// Reads only. Uses the stored sign-in (macOS Keychain) and the settings file written by `init`.
// Prints counts, field paths and pass/fail, never values: nothing here is safe to paste if it prints data, so it prints none.
import { createSkylight } from "../dist/lib.js";
import { defaultCredentialStore } from "../dist/api/credential-store.js";
import { readConfigFile } from "../dist/config-file.js";

const HIDDEN_KEYS = new Set(["owner_email", "invited_emails", "uid", "calendar_id", "calendar_account_id", "supports_notification_settings", "source_id", "sync_url", "token", "access_token", "refresh_token"]);
const EMAIL = /[^\s@"']+@[^\s@"']+\.[a-z]{2,}/i;
const FEED = /:\/\/[^\/\s]*@|:\/\/[^\/\s]+\/|token=|\.ics\b/i; // userinfo, a path after the host, a token, or an .ics link

const cfg = await readConfigFile();
if (!cfg) { console.error("No settings file. Run `skylight-mcp init` first."); process.exit(2); }
const skylight = createSkylight({ frameId: cfg.frameId, timezone: cfg.timezone, credential: defaultCredentialStore() });

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString("en-CA", { timeZone: cfg.timezone });
const from = day(-3), to = day(14), today = day(0);

let hardFailures = 0;
const warn = [];

function walk(value, path, report) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") {
      if (EMAIL.test(value)) report.emails.push(path);
      if (FEED.test(value)) report.feeds.push(path);
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (HIDDEN_KEYS.has(k)) report.hidden.push(`${path}.${k}`);
    walk(v, Array.isArray(value) ? `${path}[]` : `${path}.${k}`, report);
  }
}

async function check(name, fn, { allowEmails = [] } = {}) {
  let out;
  try { out = await fn(); } catch (e) { console.log(`FAIL ${name}: threw ${e?.name ?? "Error"}`); hardFailures++; return null; }
  const report = { hidden: [], emails: [], feeds: [] };
  walk(out, name, report);
  let jsonSafe = true;
  try { if (JSON.stringify(JSON.parse(JSON.stringify(out))) !== JSON.stringify(out)) jsonSafe = false; } catch { jsonSafe = false; }
  const count = Array.isArray(out) ? out.length : 1;
  const emails = [...new Set(report.emails.map((p) => p.replace(/\[\]/g, "")))].filter((p) => !allowEmails.some((a) => p.endsWith(a)));
  const feeds = [...new Set(report.feeds.map((p) => p.replace(/\[\]/g, "")))];
  const bad = report.hidden.length > 0 || !jsonSafe || (name === "calendar.sources" && (feeds.length > 0 || emails.length > 0));
  if (bad) hardFailures++;
  console.log(`${bad ? "FAIL" : "ok  "} ${name}: ${count} item(s); hidden keys ${report.hidden.length}; JSON-safe ${jsonSafe}`);
  if (report.hidden.length) console.log(`       hidden key paths: ${[...new Set(report.hidden)].join(", ")}`);
  if (emails.length) { warn.push(`${name}: email-like text at ${emails.join(", ")}`); console.log(`       email-like text in: ${emails.join(", ")} (free text; review)`); }
  if (feeds.length) { warn.push(`${name}: feed-like text at ${feeds.join(", ")}`); console.log(`       feed-like text in: ${feeds.join(", ")} (free text; review)`); }
  return out;
}

const events = await check("calendar.events", () => skylight.calendar.events({ from, to }), { allowEmails: [".description", ".location", ".summary"] });
await check("calendar.sources", () => skylight.calendar.sources());
await check("profiles.list", () => skylight.profiles.list());
await check("chores.list", () => skylight.chores.list({ date: today }));
await check("meals.sittings", () => skylight.meals.sittings({ from, to }));
await check("meals.recipes", () => skylight.meals.recipes());
await check("meals.categories", () => skylight.meals.categories());
const lists = await check("lists.list", () => skylight.lists.list());
if (Array.isArray(lists) && lists[0]?.id) await check("lists.items", () => skylight.lists.items(String(lists[0].id)));

// A property that matters: an occurrence of a repeating event shares a seriesId.
if (Array.isArray(events)) {
  const withSeries = events.filter((e) => e.seriesId);
  console.log(`ok   events with a seriesId: ${withSeries.length} of ${events.length}`);
}

console.log(hardFailures === 0 ? "\nPASS: no hidden keys, all results JSON-safe, no feed or email in sources." : `\nFAIL: ${hardFailures} check(s) failed.`);
if (warn.length) console.log(`Review (free text only, by design): ${warn.length} note(s) above.`);
process.exit(hardFailures === 0 ? 0 : 1);
