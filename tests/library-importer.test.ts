/**
 * Importer-side tests for the library entry (dist/lib.js). Each test runs a real Node child
 * process against the PACKED package installed into a temp project, with fetch replaced by
 * tests/library/stub-fetch.mjs, so it sees exactly what an importer sees: the exports map,
 * the packed files, and only the network calls the library makes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = "@davidwoods/skylight-mcp";
let tmp = "";
let proj = "";

const HIDDEN_KEYS = ["owner_email", "invited_emails", "uid", "calendar_id", "calendar_account_id", "supports_notification_settings", "source_id"];
const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+/;

const event = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: "calendar_event",
  attributes: {
    summary: "Practice",
    starts_at: "2037-03-03T16:00:00.000-08:00",
    ends_at: "2037-03-03T17:00:00.000-08:00",
    all_day: false,
    location: "Gym",
    source: "google",
    editable: true,
    recurring: true,
    owner_email: "owner.person@example.com",
    invited_emails: ["guest.person@example.com"],
    uid: "uid-secret-1",
    calendar_id: "family-secret@group.calendar.example.com",
    calendar_account_id: "acct-secret-1",
    supports_notification_settings: false,
    ...over,
  },
  relationships: { categories: { data: [{ id: "11" }, { id: "90" }] } },
});

function fixtures(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "/calendar_events": { data: [event("101-1804032000")] },
    "/categories": {
      data: [
        { id: "11", type: "category", attributes: { label: "Alex", color: "#fff", linked_to_profile: true } },
        { id: "90", type: "category", attributes: { label: "Team", color: "#000", linked_to_profile: false } },
      ],
    },
    "/source_calendars": {
      data: [
        { id: "1", type: "source_calendar", attributes: { label: "person.one@example.com", kind: "gmail", role: "owner", editable: true, source_id: "person.one@example.com" } },
        { id: "2", type: "source_calendar", attributes: { label: "League", kind: "webcal", role: "reader", editable: false, source_id: "webcal://user:hunter2@feeds.example.com/published/2/SECRETTOKEN123?token=abc" } },
      ],
    },
    "/chores": { data: [{ id: "7", type: "chore", attributes: { summary: "Dishes", status: "pending", start: "2037-03-03", start_time: null, recurring: false, routine: false, reward_points: 2, up_for_grabs: false }, relationships: { category: { data: { id: "11", type: "category" } } } }], included: [{ id: "11", type: "category", attributes: { label: "Alex" } }] },
    "/meals/sittings": { data: [{ id: "5", type: "meal_sitting", attributes: { summary: "Tacos", instances: ["2037-03-03"], recurring: false }, relationships: { meal_category: { data: { id: "3", type: "x" } } } }] },
    "/meals/categories": { data: [{ id: "3", type: "meal_category", attributes: { label: "Dinner" } }] },
    "/meals/recipes": { data: [{ id: "8", type: "meal_recipe", attributes: { summary: "Soup" } }] },
    "/lists": { data: [{ id: "5", type: "list", attributes: { label: "Groceries", kind: "shopping", color: "#abc" } }] },
    "/lists/5": { data: { id: "5", type: "list", attributes: { label: "Groceries" } }, included: [{ id: "50", type: "list_item", attributes: { label: "Milk", status: "pending", section: null } }] },
    ...over,
  };
}

/** Run `body` (ESM source) in a child that imports the package and has fetch stubbed. Returns parsed stdout and recorded calls. */
function runImporter(body: string, fx: Record<string, unknown> = fixtures(), argv: string[] = []): { out: unknown; calls: Array<{ url: string; host: string; auth: string | null }>; stderr: string; status: number | null } {
  const fxFile = path.join(tmp, "fx.json");
  const callsFile = path.join(tmp, "calls.json");
  fs.writeFileSync(fxFile, JSON.stringify(fx));
  fs.rmSync(callsFile, { force: true });
  const script = path.join(proj, "run.mjs");
  fs.writeFileSync(script, `import * as lib from "${PKG}";\nconst result = await (async () => {\n${body}\n})();\nconsole.log(JSON.stringify(result ?? null));\n`);
  const r = spawnSync(process.execPath, ["--import", path.join(repo, "tests/library/stub-fetch.mjs"), script, ...argv], {
    cwd: proj,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", LIB_FIXTURES: fxFile, LIB_CALLS: callsFile },
    timeout: 30_000,
  });
  const calls = fs.existsSync(callsFile) ? (JSON.parse(fs.readFileSync(callsFile, "utf8")) as Array<{ url: string; host: string; auth: string | null }>) : [];
  let out: unknown = null;
  try {
    out = JSON.parse(r.stdout.trim().split("\n").pop() ?? "null");
  } catch {
    out = r.stdout;
  }
  return { out, calls, stderr: r.stderr, status: r.status };
}

const make = `const sky = lib.createSkylight({ frameId: "123", timezone: "America/Los_Angeles", credential: { token: "tok-test-1" } });`;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skylight-lib-"));
  proj = path.join(tmp, "importer");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "importer", type: "module", private: true }));
  // Build, pack exactly what would be published, and unpack it where an importer would find it.
  execFileSync("npx", ["tsc"], { cwd: repo, stdio: "pipe" });
  const packOut = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", tmp], { cwd: repo, encoding: "utf8" });
  const tarball = path.join(tmp, (JSON.parse(packOut) as Array<{ filename: string }>)[0]!.filename.replace(/^@/, "").replace("/", "-"));
  const dest = path.join(proj, "node_modules", "@davidwoods", "skylight-mcp");
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", dest, "--strip-components=1"]);
  // Runtime dependencies come from this repo's install (no network in tests).
  for (const dep of ["zod", "@modelcontextprotocol/sdk", "@cloudflare/workers-oauth-provider"]) {
    const target = path.join(proj, "node_modules", dep);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.join(repo, "node_modules", dep), target, "dir");
  }
}, 180_000);

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("library entry, from the importer's side (packed package)", () => {
  it("1. public surface is exactly the listed names", () => {
    const { out } = runImporter(`return Object.keys(lib).sort();`);
    expect(out).toEqual(["createSkylight"]);
  });

  it("1b. the created object has exactly the Phase 1 read methods, no more", () => {
    const { out } = runImporter(`${make}\nreturn Object.fromEntries(Object.entries(sky).map(([k, v]) => [k, Object.keys(v).sort()]));`);
    expect(out).toEqual({
      calendar: ["events", "sources"],
      profiles: ["list"],
      chores: ["list"],
      meals: ["categories", "recipes", "sittings"],
      lists: ["items", "list"],
    });
  });

  it("2. deep imports of internals fail; package.json stays readable", () => {
    const { out } = runImporter(`
      const codes = {};
      for (const sub of ["dist/api/client.js", "dist/index.js", "dist/context.js", "src/lib.ts"]) {
        try { await import("${PKG}/" + sub); codes[sub] = "imported"; } catch (e) { codes[sub] = e.code; }
      }
      return codes;`);
    for (const code of Object.values(out as Record<string, string>)) expect(code).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
    const pj = runImporter(`const m = await import("${PKG}/package.json", { with: { type: "json" } }); return m.default.name;`);
    expect(pj.out).toBe(PKG);
  });

  it("3. importing starts no server and does not act on process.argv", () => {
    const r = runImporter(`return "ok";`, fixtures(), ["auth", "login"]);
    expect(r.status).toBe(0);
    expect(r.out).toBe("ok");
    expect(r.calls).toEqual([]);
    expect(r.stderr).not.toMatch(/running on stdio|Logged in|Open this/i);
  });

  it("4. the token never leaves the pinned host, whatever the options or arguments say", () => {
    const hostile = runImporter(`
      const bad = [];
      for (const extra of [{ baseUrl: "https://evil.example" }, { host: "evil.example" }, { apiBase: "//evil.example" }, { fetch: () => {} }, { SKYLIGHT_BASE_URL: "https://evil.example" }]) {
        try { lib.createSkylight({ frameId: "123", timezone: "America/Los_Angeles", credential: { token: "tok" }, ...extra }); bad.push(Object.keys(extra)[0]); } catch {}
      }
      for (const frameId of ["123/../../x", "123?x=1", "//evil.example", "abc"]) {
        try { lib.createSkylight({ frameId, timezone: "America/Los_Angeles", credential: { token: "tok" } }); bad.push(frameId); } catch {}
      }
      try { lib.createSkylight({ frameId: "123", timezone: "America/Los_Angeles", credential: { token: "tok", baseUrl: "https://evil.example" } }); bad.push("credential.baseUrl"); } catch {}
      return bad;`);
    expect(hostile.out).toEqual([]);

    const r = runImporter(`${make}
      const refused = [];
      for (const call of [() => sky.lists.items("//evil.example/x"), () => sky.lists.items("5/../../x"), () => sky.calendar.events({ from: "https://evil.example", to: "2037-03-04" }), () => sky.chores.list({ date: "2037-03-03?x=1" })]) {
        try { await call(); } catch { refused.push(true); }
      }
      await sky.calendar.events({ from: "2037-03-03", to: "2037-03-04" });
      await sky.calendar.sources();
      await sky.profiles.list();
      await sky.chores.list({ date: "2037-03-03", profile: "Alex" });
      await sky.meals.sittings({ from: "2037-03-03", to: "2037-03-04" });
      await sky.meals.recipes();
      await sky.meals.categories();
      await sky.lists.list();
      await sky.lists.items("5");
      return refused.length;`);
    expect(r.out).toBe(4);
    expect(r.calls.length).toBeGreaterThan(8);
    for (const c of r.calls) {
      expect(c.host).toBe("app.ourskylight.com");
      expect(c.auth).toBe("Bearer tok-test-1");
    }
  });

  it("5. sources() carries no feed path, query, credentials or email address", () => {
    const { out } = runImporter(`${make}\nreturn await sky.calendar.sources();`);
    const text = JSON.stringify(out);
    for (const secret of ["SECRETTOKEN123", "hunter2", "token=abc", "published", "person.one@example.com"]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(EMAIL);
    const feed = (out as Array<{ kind: string; host: string | null }>).find((s) => s.kind === "feed")!;
    expect(feed.host).toBe("webcal://feeds.example.com");
    expect((out as Array<{ kind: string; label: string }>).find((s) => s.kind === "google")!.label).toBe("Google calendar");
  });

  it("6. events() has no hidden field and no email-shaped value", () => {
    const { out } = runImporter(`${make}\nreturn await sky.calendar.events({ from: "2037-03-03", to: "2037-03-03" });`);
    const events = out as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    for (const key of HIDDEN_KEYS) expect(Object.keys(events[0]!)).not.toContain(key);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(EMAIL);
    for (const secret of ["uid-secret-1", "family-secret", "acct-secret-1"]) expect(text).not.toContain(secret);
    expect(events[0]).toMatchObject({ title: "Practice", profiles: ["Alex"], labels: ["Team"], source: "google", seriesId: "101", recurring: true, allDay: false });
  });

  it("7. every return value is JSON-safe (survives a round trip unchanged)", () => {
    const { out } = runImporter(`${make}
      const all = {
        events: await sky.calendar.events({ from: "2037-03-03", to: "2037-03-04" }),
        sources: await sky.calendar.sources(),
        profiles: await sky.profiles.list(),
        chores: await sky.chores.list({ date: "2037-03-03" }),
        sittings: await sky.meals.sittings({ from: "2037-03-03", to: "2037-03-04" }),
        recipes: await sky.meals.recipes(),
        mealCategories: await sky.meals.categories(),
        lists: await sky.lists.list(),
        items: await sky.lists.items("5"),
      };
      return { all, same: JSON.stringify(JSON.parse(JSON.stringify(all))) === JSON.stringify(all) };`);
    const r = out as { all: Record<string, unknown[]>; same: boolean };
    expect(r.same).toBe(true);
    for (const [name, rows] of Object.entries(r.all)) expect(rows.length, name).toBeGreaterThan(0);
    expect(r.all.sittings![0]).toMatchObject({ title: "Tacos", category: "Dinner", dates: ["2037-03-03"] });
    expect(r.all.chores![0]).toMatchObject({ title: "Dishes", profile: "Alex", points: 2, done: false });
  });

  it("8. no function takes a URL or a feed address", () => {
    const r = runImporter(`${make}
      const results = [];
      const attempt = async (fn) => { try { await fn(); results.push("accepted"); } catch { results.push("refused"); } };
      await attempt(() => sky.lists.items("https://evil.example/x"));
      await attempt(() => sky.calendar.events({ from: "webcal://feeds.example.com/x", to: "2037-03-04" }));
      await attempt(() => sky.meals.sittings({ from: "2037-03-03", to: "https://evil.example" }));
      return { results, arities: [lib.createSkylight.length, sky.calendar.events.length, sky.lists.items.length], hasUrlish: Object.keys(lib).some((k) => /url|feed|webcal/i.test(k)) };`);
    const o = r.out as { results: string[]; arities: number[]; hasUrlish: boolean };
    expect(o.results).toEqual(["refused", "refused", "refused"]);
    expect(o.arities).toEqual([1, 1, 1]);
    expect(o.hasUrlish).toBe(false);
    // The shipped type declarations name no URL, feed or host option either.
    const dts = fs.readFileSync(path.join(proj, "node_modules/@davidwoods/skylight-mcp/dist/lib.d.ts"), "utf8");
    expect(dts).not.toMatch(/baseUrl|apiBase|feedUrl|webcal|fetch\??:/i);
  });

  it("9. a series' occurrence id changes after a time edit, so ids cannot be relied on", () => {
    const before = runImporter(`${make}\nreturn await sky.calendar.events({ from: "2037-03-03", to: "2037-03-03" });`, fixtures({ "/calendar_events": { data: [event("101-1804032000")] } }));
    const after = runImporter(`${make}\nreturn await sky.calendar.events({ from: "2037-03-03", to: "2037-03-03" });`, fixtures({ "/calendar_events": { data: [event("101-1804035600", { starts_at: "2037-03-03T17:00:00.000-08:00" })] } }));
    const a = (before.out as Array<{ id: string; seriesId: string }>)[0]!;
    const b = (after.out as Array<{ id: string; seriesId: string }>)[0]!;
    expect(a.id).not.toBe(b.id);
    expect(a.seriesId).toBe("101");
    expect(b.seriesId).toBe("101");
    const dts = fs.readFileSync(path.join(proj, "node_modules/@davidwoods/skylight-mcp/dist/lib.d.ts"), "utf8");
    expect(dts).toMatch(/opaque/i);
    expect(dts).toMatch(/CHANGE after a time edit/);
  });
});
