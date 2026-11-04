import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";
import { addCalendarFeed, checkFeedUrl, readBackPolicy, scrubFeedText } from "../src/api/endpoints/source-calendars.js";
import { runCalendarsCommand } from "../src/calendars-cli.js";
import { PromptCancelled, promptHidden, type HiddenInput } from "../src/prompt-hidden.js";
import { HOSTED_EFFECTS, HOSTED_DESTRUCTIVE_ALLOWLIST } from "../src/worker/mcp.js";

const config = { frameId: "frame-1", timezone: "UTC", token: "test-access-1", authType: "bearer" as const };
const FEED = "https://calendar-api.example.com/v1/team.ics?token=SECRETTOKEN123&teamId=abc";
const SECRETS = ["SECRETTOKEN123", "token=", "team.ics"];

function inContext<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext({ client: new SkylightClient(config, null), config }, fn);
}

readBackPolicy.delayMs = 0;
afterEach(() => vi.unstubAllGlobals());

describe("checkFeedUrl", () => {
  it("accepts web and webcal addresses and returns the host", () => {
    for (const u of [FEED, "webcal://p1-caldav.example.com/published/2/X", "http://ical.example.com/x.ics", "webcals://h.example.com/a"]) {
      expect(checkFeedUrl(u).ok).toBe(true);
    }
    expect(checkFeedUrl(FEED)).toMatchObject({ ok: true, host: "calendar-api.example.com" });
  });

  it("rejects an address pasted more than once, before anything is sent", () => {
    const r = checkFeedUrl(FEED + FEED);
    expect(r.ok).toBe(false);
    expect(checkFeedUrl(FEED + "webcal://p1-caldav.example.com/x").ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("SECRETTOKEN123");
  });

  it("rejects anything that is not a web address, before anything is sent", () => {
    for (const u of ["", "   ", "file:///etc/passwd", "javascript:alert(1)", "ftp://x.example.com/a", "not a url", "https://", "https://a b.example.com", "family123@group.calendar.example.com"]) {
      expect(checkFeedUrl(u).ok).toBe(false);
    }
  });
});

describe("addCalendarFeed", () => {
  it("posts only sync_url to the pinned host and returns just the name and host", async () => {
    const calls: Array<{ url: string; method: string; body?: string; auth?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), method: String(init.method), body: init.body as string, auth: (init.headers as Record<string, string>).Authorization });
        return new Response(JSON.stringify({ data: { id: "1", type: "webcal_account", attributes: { sync_url: FEED, name: "Team Schedule" } } }), { status: 200 });
      })
    );
    const result = await inContext(() => addCalendarFeed(`  ${FEED}  `));
    expect(result).toEqual({ status: "added", host: "calendar-api.example.com", name: "Team Schedule" });
    expect(JSON.stringify(result)).not.toContain("SECRETTOKEN123");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://app.ourskylight.com/api/frames/frame-1/webcal_accounts");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ sync_url: FEED });
  });

  it("never sends the bearer token anywhere but the pinned host", async () => {
    const hosts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        hosts.push(new URL(String(url)).host);
        return new Response(JSON.stringify({ data: { attributes: { name: "X" } } }), { status: 200 });
      })
    );
    await inContext(() => addCalendarFeed("https://evil.example.net/steal.ics"));
    expect(hosts).toEqual(["app.ourskylight.com"]);
  });

  it("reports a duplicate as already synced, not as a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: ["That URL is already synced to your Calendar"] }), { status: 422 })));
    expect(await inContext(() => addCalendarFeed(FEED))).toEqual({ status: "already_synced", host: "calendar-api.example.com" });
  });

  it("scrubs the address from an error that echoes it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [`Could not read ${FEED}`] }), { status: 422 })));
    const error = await inContext(() => addCalendarFeed(FEED)).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    for (const s of SECRETS) expect((error as Error).message).not.toContain(s);
  });

  it("scrubs a server error too, and sends nothing for a bad address", async () => {
    const fetchMock = vi.fn(async () => new Response(`upstream said ${FEED}`, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const error = await inContext(() => addCalendarFeed(FEED)).catch((e: Error) => e);
    for (const s of SECRETS) expect((error as Error).message).not.toContain(s);
    fetchMock.mockClear();
    await expect(inContext(() => addCalendarFeed("file:///etc/passwd"))).rejects.toThrow(/must start with/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scrubFeedText removes any address-shaped text", () => {
    expect(scrubFeedText("bad https://a.example.com/x?k=1 and webcal://b.example.com/y", "")).toBe("bad (feed address hidden) and (feed address hidden)");
  });
});

describe("skylight-mcp calendars add", () => {
  function deps(answers: string[], addFeed = vi.fn(async () => ({ status: "added" as const, host: "calendar-api.example.com", name: "Team Schedule" }))) {
    const out: string[] = [];
    const queue = [...answers];
    return { out, addFeed, prompt: vi.fn(async () => queue.shift() ?? ""), run: (args: string[]) => runCalendarsCommand(args, { out: (l) => out.push(l), prompt: deps_prompt(queue), addFeed }) };
  }
  function deps_prompt(queue: string[]) {
    return async () => queue.shift() ?? "";
  }

  it("prints only the name and host, never the address", async () => {
    const d = deps([FEED]);
    expect(await d.run(["add"])).toBe(0);
    const text = d.out.join("\n");
    expect(text).toContain("Team Schedule");
    expect(text).toContain("calendar-api.example.com");
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(d.addFeed).toHaveBeenCalledWith(FEED);
  });

  it("refuses an address on the command line and sends nothing", async () => {
    const d = deps([FEED]);
    expect(await d.run(["add", FEED])).toBe(2);
    expect(d.addFeed).not.toHaveBeenCalled();
    for (const s of SECRETS) expect(d.out.join("\n")).not.toContain(s);
  });

  it("asks again after a bad address and gives up after three, sending nothing", async () => {
    const d = deps(["nope", "also nope", "still nope"]);
    expect(await d.run(["add"])).toBe(2);
    expect(d.addFeed).not.toHaveBeenCalled();
  });

  it("treats already synced as success", async () => {
    const d = deps([FEED], vi.fn(async () => ({ status: "already_synced" as const, host: "calendar-api.example.com" })));
    expect(await d.run(["add"])).toBe(0);
    expect(d.out.join("\n")).toContain("already synced");
  });

  it("does not leak the address when the call fails", async () => {
    const d = deps([FEED], vi.fn(async () => { throw new Error(`HTTP 500: ${scrubFeedText(FEED, FEED)}`); }));
    expect(await d.run(["add"])).toBe(1);
    for (const s of SECRETS) expect(d.out.join("\n")).not.toContain(s);
  });
});

describe("promptHidden", () => {
  function fakeInput(tty: boolean): HiddenInput & { emit: (c: string) => void; raw: boolean[] } {
    const ee = new EventEmitter();
    const raw: boolean[] = [];
    return {
      isTTY: tty,
      setRawMode: (m: boolean) => raw.push(m),
      resume: () => undefined,
      pause: () => undefined,
      setEncoding: () => undefined,
      on: (e, l) => ee.on(e, l as never),
      off: (e, l) => ee.off(e, l as never),
      emit: (c: string) => ee.emit("data", c),
      raw,
    };
  }

  it("returns what was typed without ever writing it to the output", async () => {
    const input = fakeInput(true);
    const written: string[] = [];
    const p = promptHidden("Address: ", { input, output: { write: (t) => written.push(t) } });
    input.emit(FEED.slice(0, 20));
    input.emit(`${FEED.slice(20)}\r`);
    expect(await p).toBe(FEED);
    const shown = written.join("");
    for (const s of SECRETS) expect(shown).not.toContain(s);
    expect(shown).toContain(`${FEED.length} characters`);
    expect(input.raw).toEqual([true, false]);
  });

  it("shows a running character count while pasting, never the text", async () => {
    const input = fakeInput(true);
    const written: string[] = [];
    const p = promptHidden("Address: ", { input, output: { write: (t) => written.push(t) } });
    input.emit(FEED.slice(0, 30));
    expect(written.join("")).toContain("30 characters (not shown). Press Enter");
    input.emit(`${FEED.slice(30)}\r`);
    await p;
    for (const s of SECRETS) expect(written.join("")).not.toContain(s);
  });

  it("handles backspace and ignores control characters", async () => {
    const input = fakeInput(true);
    const p = promptHidden("> ", { input, output: { write: () => undefined } });
    input.emit("abcd\u007f\u007fX\u001b\n");
    expect(await p).toBe("abX");
  });

  it("cancels on Ctrl-C and restores the terminal", async () => {
    const input = fakeInput(true);
    const p = promptHidden("> ", { input, output: { write: () => undefined } });
    input.emit("ab\u0003");
    await expect(p).rejects.toBeInstanceOf(PromptCancelled);
    expect(input.raw).toEqual([true, false]);
  });
});

describe("delete_source_calendar", () => {
  const list = (ids: string[]) => ({
    data: [
      { id: "1", type: "source_calendar_detail", attributes: { label: "Family", kind: "gmail", role: "writer", source_id: "family@group.example.com", default_for_new_events: true } },
      { id: "2", type: "source_calendar_detail", attributes: { label: "Team", kind: "webcal", role: "reader", source_id: FEED, default_for_new_events: false } },
      { id: "3", type: "source_calendar_detail", attributes: { label: "Other", kind: "gmail", role: "owner", source_id: "o@example.com", default_for_new_events: false } },
    ].filter((c) => ids.includes(c.id)),
  });

  async function call(args: Record<string, unknown>, opts: { hosted?: boolean } = {}): Promise<string> {
    const server = new McpServer({ name: "skylight", version: "t" });
    registerTools(server, opts.hosted ? { hasPlus: true, effects: HOSTED_EFFECTS, include: HOSTED_DESTRUCTIVE_ALLOWLIST, photos: false } : { hasPlus: true, photos: false });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const req = new Request("https://w.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_source_calendar", arguments: args } }),
    });
    const res = await runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(req));
    const json = (await res.json()) as { result?: { content: Array<{ text: string }> }; error?: { message: string } };
    return json.result ? json.result.content.map((c) => c.text).join("\n") : `ERROR ${json.error?.message}`;
  }

  function stub(afterDelete: string[]): Array<{ method: string; url: string }> {
    const seen: Array<{ method: string; url: string }> = [];
    let deleted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ method: String(init.method), url: String(url) });
        if (init.method === "DELETE") {
          deleted = true;
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return new Response(JSON.stringify(list(deleted ? afterDelete : ["1", "2", "3"])), { status: 200 });
      })
    );
    return seen;
  }

  it("previews without deleting, and never shows the address", async () => {
    const seen = stub(["1", "3"]);
    const text = await call({ calendarId: "2" });
    expect(text).toContain("NOT REMOVED");
    expect(text).toContain("Team");
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(seen.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("deletes the right path with confirm and reads back", async () => {
    const seen = stub(["1", "3"]);
    const text = await call({ calendarId: "2", confirm: true });
    expect(text).toContain("Confirmed gone");
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(seen.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["https://app.ourskylight.com/api/frames/frame-1/source_calendars/2"]);
  });

  it("refuses account calendars and the default calendar, deleting nothing", async () => {
    const seen = stub(["1", "2", "3"]);
    expect(await call({ calendarId: "3", confirm: true })).toMatch(/account calendar/);
    expect(await call({ calendarId: "1", confirm: true })).toMatch(/account calendar/);
    expect(seen.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("does not trust the delete call: still listed is an error", async () => {
    stub(["1", "2", "3"]);
    expect(await call({ calendarId: "2", confirm: true })).toMatch(/still listed/);
  });

  it("rejects unknown and non-numeric IDs", async () => {
    stub(["1", "2", "3"]);
    expect(await call({ calendarId: "99", confirm: true })).toMatch(/No synced calendar/);
    expect(await call({ calendarId: "../x", confirm: true })).toMatch(/numeric/);
  });

  it("is not registered on the hosted server", async () => {
    stub(["1", "3"]);
    expect(await call({ calendarId: "2", confirm: true }, { hosted: true })).toMatch(/not found/i);
  });
});

describe("update_source_calendar_profiles", () => {
  const CATS = [
    { id: "10", type: "category", attributes: { label: "Ben", linked_to_profile: true } },
    { id: "11", type: "category", attributes: { label: "Alison", linked_to_profile: true } },
    { id: "12", type: "category", attributes: { label: "Dave", linked_to_profile: true } },
    { id: "99", type: "category", attributes: { label: "Team Schedule", linked_to_profile: false } },
  ];
  const cal = (id: string, kind: string, cats: string[]) => ({
    id,
    type: "source_calendar_detail",
    attributes: { label: id === "2" ? "Team" : "Other", kind, source_id: kind === "webcal" ? FEED : "o@example.com", default_for_new_events: false },
    relationships: { categories: { data: cats.map((c) => ({ id: c, type: "category_detail" })) } },
  });

  async function call(args: Record<string, unknown>, opts: { hosted?: boolean; tool?: string } = {}): Promise<string> {
    const server = new McpServer({ name: "skylight", version: "t" });
    registerTools(server, opts.hosted ? { hasPlus: true, effects: HOSTED_EFFECTS, include: HOSTED_DESTRUCTIVE_ALLOWLIST, photos: false } : { hasPlus: true, photos: false });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const req = new Request("https://w.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_source_calendar_profiles", arguments: args } }),
    });
    const res = await runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(req));
    const json = (await res.json()) as { result?: { content: Array<{ text: string }> }; error?: { message: string } };
    return json.result ? json.result.content.map((c) => c.text).join("\n") : `ERROR ${json.error?.message}`;
  }

  /** A stateful fake: PUT replaces the calendar's categories, unless `ignorePut` simulates a silent no-op. */
  function stub(start: string[], opts: { ignorePut?: boolean } = {}): Array<{ method: string; url: string; body?: unknown }> {
    const seen: Array<{ method: string; url: string; body?: unknown }> = [];
    let cats = start;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const u = String(url);
        seen.push({ method: String(init.method), url: u, body: init.body ? JSON.parse(init.body as string) : undefined });
        if (init.method === "PUT") {
          if (!opts.ignorePut) cats = (JSON.parse(init.body as string).categorizations as Array<{ category_id: string }>).map((c) => c.category_id);
          return new Response(JSON.stringify({ data: cal("2", "webcal", cats) }), { status: 200 });
        }
        if (u.endsWith("/categories")) return new Response(JSON.stringify({ data: CATS }), { status: 200 });
        return new Response(JSON.stringify({ data: [cal("2", "webcal", cats), cal("3", "gmail", ["11"])] }), { status: 200 });
      })
    );
    return seen;
  }

  const puts = (seen: Array<{ method: string }>) => seen.filter((c) => c.method === "PUT");

  it("previews before and after without writing, and never shows the address", async () => {
    const { clearCategoriesCache } = await import("../src/api/endpoints/categories.js");
    clearCategoriesCache();
    const seen = stub(["99"]);
    const text = await call({ calendarId: "2", link: ["Ben"] });
    expect(text).toContain("NOT CHANGED");
    expect(text).toMatch(/Now:\s+profiles: none; labels kept: Team Schedule/);
    expect(text).toMatch(/After: profiles: Ben; labels kept: Team Schedule/);
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(puts(seen)).toHaveLength(0);
  });

  it("sends the full set so the label survives, to the captured path, and reads back", async () => {
    const { clearCategoriesCache } = await import("../src/api/endpoints/categories.js");
    clearCategoriesCache();
    const seen = stub(["99"]);
    const text = await call({ calendarId: "2", link: ["ben"], confirm: true });
    expect(text).toContain("Confirmed by reading it back");
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(puts(seen)).toHaveLength(1);
    expect(puts(seen)[0]!.url).toBe("https://app.ourskylight.com/api/frames/frame-1/source_calendars/2/source_calendar_categorizations");
    expect((puts(seen)[0]!.body as { categorizations: unknown }).categorizations).toEqual([{ category_id: "99" }, { category_id: "10" }]);
  });

  it("unlinks only the named profile and keeps the others and the label", async () => {
    const { clearCategoriesCache } = await import("../src/api/endpoints/categories.js");
    clearCategoriesCache();
    const seen = stub(["99", "10", "11"]);
    const text = await call({ calendarId: "2", unlink: ["Ben"], confirm: true });
    expect(text).toContain("Updated");
    expect((puts(seen)[0]!.body as { categorizations: unknown }).categorizations).toEqual([{ category_id: "99" }, { category_id: "11" }]);
  });

  it("does not trust the write: a change Skylight did not apply is an error", async () => {
    const { clearCategoriesCache } = await import("../src/api/endpoints/categories.js");
    clearCategoriesCache();
    stub(["99"], { ignorePut: true });
    expect(await call({ calendarId: "2", link: ["Ben"], confirm: true })).toMatch(/not what was asked/);
  });

  it("changes nothing when already as asked, when the name is unknown, or when it would empty the calendar", async () => {
    const { clearCategoriesCache } = await import("../src/api/endpoints/categories.js");
    clearCategoriesCache();
    const seen = stub(["10"]);
    expect(await call({ calendarId: "2", link: ["Ben"], confirm: true })).toMatch(/No change needed/);
    expect(await call({ calendarId: "2", link: ["Benjamin"], confirm: true })).toMatch(/No profile called/);
    expect(await call({ calendarId: "2", unlink: ["Ben"], confirm: true })).toMatch(/no profile or label at all/);
    expect(await call({ calendarId: "2", link: ["Ben"], unlink: ["Ben"], confirm: true })).toMatch(/same profile/);
    expect(await call({ calendarId: "2", confirm: true })).toMatch(/link or unlink/);
    expect(puts(seen)).toHaveLength(0);
  });

  it("refuses account calendars and bad IDs, writing nothing", async () => {
    const { clearCategoriesCache } = await import("../src/api/endpoints/categories.js");
    clearCategoriesCache();
    const seen = stub(["99"]);
    expect(await call({ calendarId: "3", link: ["Ben"], confirm: true })).toMatch(/account calendar/);
    expect(await call({ calendarId: "../x", link: ["Ben"], confirm: true })).toMatch(/numeric/);
    expect(await call({ calendarId: "77", link: ["Ben"], confirm: true })).toMatch(/No synced calendar/);
    expect(puts(seen)).toHaveLength(0);
  });

  it("is available on the hosted server (a write, not destructive)", async () => {
    const { clearCategoriesCache } = await import("../src/api/endpoints/categories.js");
    clearCategoriesCache();
    stub(["99"]);
    expect(await call({ calendarId: "2", link: ["Ben"] }, { hosted: true })).toContain("NOT CHANGED");
  });
});

describe("rename_source_calendar", () => {
  const cal = (id: string, kind: string, label: string, cats: string[]) => ({
    id,
    type: "source_calendar_detail",
    attributes: { label, kind, source_id: kind === "webcal" ? FEED : "o@example.com", default_for_new_events: false },
    relationships: { categories: { data: cats.map((c) => ({ id: c, type: "category_detail" })) } },
  });

  async function call(args: Record<string, unknown>, hosted = false): Promise<string> {
    const server = new McpServer({ name: "skylight", version: "t" });
    registerTools(server, hosted ? { hasPlus: true, effects: HOSTED_EFFECTS, include: HOSTED_DESTRUCTIVE_ALLOWLIST, photos: false } : { hasPlus: true, photos: false });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const req = new Request("https://w.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rename_source_calendar", arguments: args } }),
    });
    const res = await runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(req));
    const json = (await res.json()) as { result?: { content: Array<{ text: string }> }; error?: { message: string } };
    return json.result ? json.result.content.map((c) => c.text).join("\n") : `ERROR ${json.error?.message}`;
  }

  /** PUT renames unless `ignorePut`; `wipeLinks` simulates a rename that also drops the profile links. */
  function stub(opts: { ignorePut?: boolean; wipeLinks?: boolean } = {}): Array<{ method: string; url: string; body?: unknown }> {
    const seen: Array<{ method: string; url: string; body?: unknown }> = [];
    let label = "CTK - B8N - Fates Schedule";
    let cats = ["99", "10"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ method: String(init.method), url: String(url), body: init.body ? JSON.parse(init.body as string) : undefined });
        if (init.method === "PUT") {
          if (!opts.ignorePut) label = (JSON.parse(init.body as string) as { label: string }).label;
          if (opts.wipeLinks) cats = ["99"];
          return new Response(JSON.stringify({ data: cal("2", "webcal", label, cats) }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [cal("2", "webcal", label, cats), cal("3", "gmail", "Family", ["11"])] }), { status: 200 });
      })
    );
    return seen;
  }
  const puts = (seen: Array<{ method: string }>) => seen.filter((c) => c.method === "PUT");

  it("previews without writing and never shows the address", async () => {
    const seen = stub();
    const text = await call({ calendarId: "2", name: "Fates" });
    expect(text).toContain("NOT RENAMED");
    expect(text).toContain('"Fates"');
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(puts(seen)).toHaveLength(0);
  });

  it("puts only the label to the captured path and reads it back", async () => {
    const seen = stub();
    const text = await call({ calendarId: "2", name: "  Fates   Schedule ", confirm: true });
    expect(text).toContain("Confirmed by reading it back");
    expect(puts(seen)).toHaveLength(1);
    expect(puts(seen)[0]!.url).toBe("https://app.ourskylight.com/api/frames/frame-1/source_calendars/2");
    expect(puts(seen)[0]!.body).toEqual({ label: "Fates Schedule" });
  });

  it("does not trust the write: a rename Skylight ignored is an error", async () => {
    stub({ ignorePut: true });
    expect(await call({ calendarId: "2", name: "Fates", confirm: true })).toMatch(/still called/);
  });

  it("notices when a rename changed the linked profiles", async () => {
    stub({ wipeLinks: true });
    expect(await call({ calendarId: "2", name: "Fates", confirm: true })).toMatch(/linked profiles changed/);
  });

  it("refuses blank, link-shaped and over-long names, account calendars and bad IDs, writing nothing", async () => {
    const seen = stub();
    expect(await call({ calendarId: "2", name: "   ", confirm: true })).toMatch(/cannot be blank/);
    expect(await call({ calendarId: "2", name: FEED, confirm: true })).toMatch(/web address/);
    expect(await call({ calendarId: "2", name: "x".repeat(101), confirm: true })).toMatch(/longer than/);
    expect(await call({ calendarId: "3", name: "Fam", confirm: true })).toMatch(/account calendar/);
    expect(await call({ calendarId: "../x", name: "A", confirm: true })).toMatch(/numeric/);
    expect(await call({ calendarId: "77", name: "A", confirm: true })).toMatch(/No synced calendar/);
    expect(puts(seen)).toHaveLength(0);
  });

  it("does nothing when the name is already that, and works on the hosted server", async () => {
    const seen = stub();
    expect(await call({ calendarId: "2", name: "CTK - B8N - Fates Schedule", confirm: true })).toMatch(/No change needed/);
    expect(puts(seen)).toHaveLength(0);
    expect(await call({ calendarId: "2", name: "Fates" }, true)).toContain("NOT RENAMED");
  });
});

describe("get_source_calendars guidance", () => {
  it("only names tools that exist, so the advice cannot go stale", async () => {
    const { readFileSync } = await import("node:fs");
    const { TOOL_EFFECTS } = await import("../src/tools/registry.js");
    const src = readFileSync(new URL("../src/tools/calendar.ts", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("Name only the tools this server actually exposes"), src.indexOf("Only feeds (kind: webcal) are one-way"));
    const named = [...block.matchAll(/\b((?:update|rename|delete)_\w+)/g)].map((m) => m[1]!);
    expect(named).toHaveLength(3);
    expect(named.length).toBeGreaterThan(0);
    for (const n of named) expect(Object.keys(TOOL_EFFECTS)).toContain(n);
    expect(block).toContain("skylight-mcp calendars add");
  });
});

describe("read-back tolerates Skylight's list lagging a write (seen live on a delete)", () => {
  const cal = (id: string, label: string, cats: string[]) => ({
    id,
    type: "source_calendar_detail",
    attributes: { label, kind: "webcal", source_id: FEED, default_for_new_events: false },
    relationships: { categories: { data: cats.map((c) => ({ id: c, type: "category_detail" })) } },
  });
  const CATS = [
    { id: "10", type: "category", attributes: { label: "Ben", linked_to_profile: true } },
    { id: "99", type: "category", attributes: { label: "Lbl", linked_to_profile: false } },
  ];

  async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const server = new McpServer({ name: "skylight", version: "t" });
    registerTools(server, { hasPlus: true, photos: false });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const req = new Request("https://w.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const res = await runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(req));
    const json = (await res.json()) as { result?: { content: Array<{ text: string }> }; error?: { message: string } };
    return json.result ? json.result.content.map((c) => c.text).join("\n") : `ERROR ${json.error?.message}`;
  }

  /** After the write, the list shows the OLD state for `stale` reads, then the new state. */
  function stub(stale: number, before: ReturnType<typeof cal>, after: ReturnType<typeof cal> | null): { gets: () => number } {
    let wrote = false;
    let staleLeft = stale;
    let gets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (init.method === "PUT" || init.method === "DELETE") {
          wrote = true;
          return new Response(JSON.stringify({ success: true, data: before }), { status: 200 });
        }
        if (String(url).endsWith("/categories")) return new Response(JSON.stringify({ data: CATS }), { status: 200 });
        gets++;
        let current: ReturnType<typeof cal> | null = before;
        if (wrote) {
          if (staleLeft > 0) staleLeft--;
          else current = after;
        }
        return new Response(JSON.stringify({ data: current ? [current] : [] }), { status: 200 });
      })
    );
    return { gets: () => gets };
  }

  it("delete: succeeds when the list catches up on a later read", async () => {
    const s = stub(2, cal("2", "Team", ["99"]), null);
    expect(await callTool("delete_source_calendar", { calendarId: "2", confirm: true })).toContain("Confirmed gone");
    expect(s.gets()).toBeGreaterThan(3);
  });

  it("delete: still an error when the calendar never leaves the list", async () => {
    stub(99, cal("2", "Team", ["99"]), null);
    expect(await callTool("delete_source_calendar", { calendarId: "2", confirm: true })).toMatch(/still listed/);
  });

  it("rename: succeeds when the new name appears on a later read, errors when it never does", async () => {
    stub(2, cal("2", "Old", ["99"]), cal("2", "New", ["99"]));
    expect(await callTool("rename_source_calendar", { calendarId: "2", name: "New", confirm: true })).toContain("Confirmed by reading it back");
    stub(99, cal("2", "Old", ["99"]), cal("2", "New", ["99"]));
    expect(await callTool("rename_source_calendar", { calendarId: "2", name: "New", confirm: true })).toMatch(/still called/);
  });

  it("link: succeeds when the links appear on a later read, errors when they never do", async () => {
    stub(2, cal("2", "T", ["99"]), cal("2", "T", ["99", "10"]));
    expect(await callTool("update_source_calendar_profiles", { calendarId: "2", link: ["Ben"], confirm: true })).toContain("Confirmed by reading it back");
    stub(99, cal("2", "T", ["99"]), cal("2", "T", ["99", "10"]));
    expect(await callTool("update_source_calendar_profiles", { calendarId: "2", link: ["Ben"], confirm: true })).toMatch(/not what was asked/);
  });
});
