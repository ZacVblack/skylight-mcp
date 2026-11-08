import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { clearCategoriesCache } from "../src/api/endpoints/categories.js";
import { readBackPolicy } from "../src/api/endpoints/source-calendars.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";
import { HOSTED_DESTRUCTIVE_ALLOWLIST, HOSTED_EFFECTS } from "../src/worker/mcp.js";

const config = { frameId: "frame-1", timezone: "UTC", token: "test-access-1", authType: "bearer" as const };

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const server = new McpServer({ name: "skylight", version: "t" });
  // Exactly what the hosted server registers.
  registerTools(server, { hasPlus: true, effects: HOSTED_EFFECTS, include: HOSTED_DESTRUCTIVE_ALLOWLIST, photos: false });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const req = new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(req));
  const json = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: json.result.content.map((c) => c.text).join("\n"), isError: Boolean(json.result.isError) };
}

const base = {
  summary: "Date night",
  starts_at: "2026-11-12T18:00:00.000-08:00",
  ends_at: "2026-11-12T19:30:00.000-08:00",
  all_day: false,
  recurring: false,
  recurring_config: false,
  master_event_id: null,
  source: "skylight",
  editable: true,
};

function ev(id: string, over: Record<string, unknown> = {}) {
  return { id, type: "calendar_event", attributes: { ...base, ...over }, relationships: { categories: { data: [{ id: "11", type: "category" }, { id: "13", type: "category" }] } } };
}

/** Fake Skylight: a list of events; DELETE removes after `lagReads` more list reads. */
function stub(events: unknown[], opts: { lagReads?: number; neverDeletes?: boolean } = {}) {
  let live = [...events] as Array<{ id: string }>;
  let pendingDelete: string | null = null;
  let lag = 0;
  const deletes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/categories")) {
        const cat = (id: string, label: string) => ({ id, type: "category", attributes: { label, linked_to_profile: true } });
        return new Response(JSON.stringify({ data: [cat("11", "Alex"), cat("13", "Jordan")] }), { status: 200 });
      }
      if (method === "DELETE") {
        deletes.push(u);
        pendingDelete = u.split("?")[0]!.split("/").pop()!;
        lag = opts.lagReads ?? 0;
        if (!opts.neverDeletes && lag === 0) live = live.filter((e) => e.id !== pendingDelete);
        return new Response(null, { status: 204 });
      }
      if (u.includes("/calendar_events")) {
        const out = JSON.stringify({ data: live });
        if (pendingDelete && !opts.neverDeletes && lag > 0 && --lag === 0) live = live.filter((e) => e.id !== pendingDelete);
        return new Response(out, { status: 200 });
      }
      return new Response("{}", { status: 200 });
    })
  );
  return { deletes };
}

beforeEach(() => {
  readBackPolicy.delayMs = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearCategoriesCache();
});

describe("delete_calendar_event (hosted, preview-first)", () => {
  it("previews the event and sends no DELETE without confirm", async () => {
    const s = stub([ev("1")]);
    const out = await call("delete_calendar_event", { eventId: "1", date: "2026-11-12" });
    expect(out.text).toContain("Preview only");
    expect(out.text).toContain("Date night");
    expect(out.text).toContain("Alex, Jordan");
    expect(out.text).toContain("confirm: true");
    expect(s.deletes).toEqual([]);
  });

  it("sends exactly one DELETE for that id with confirm, and confirms it is gone", async () => {
    const s = stub([ev("1"), ev("2", { summary: "Other" })]);
    const out = await call("delete_calendar_event", { eventId: "1", date: "2026-11-12", confirm: true });
    expect(s.deletes).toHaveLength(1);
    expect(s.deletes[0]).toMatch(/calendar_events\/1$/);
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Confirmed gone");
  });

  it("does not report failure when the list lags the delete", async () => {
    stub([ev("1")], { lagReads: 2 });
    const out = await call("delete_calendar_event", { eventId: "1", date: "2026-11-12", confirm: true });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Confirmed gone");
  });

  it("reports an error when the event is still there after the retries", async () => {
    stub([ev("1")], { neverDeletes: true });
    const out = await call("delete_calendar_event", { eventId: "1", date: "2026-11-12", confirm: true });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("still shows");
  });

  it.each([
    ["a feed event", { source: "ics_link", editable: false }],
    ["a feed event reporting editable", { source: "ics_link" }],
    ["a non-editable event", { editable: false }],
    ["an occurrence edited on its own", { master_event_id: "uof1jj830ii82vaakifhnassco" }],
    ["a Google event that is not editable", { source: "google", editable: false }],
  ])("refuses %s even with confirm, and sends no DELETE", async (_label, over) => {
    const s = stub([ev("1", over)]);
    const out = await call("delete_calendar_event", { eventId: "1", date: "2026-11-12", confirm: true });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Nothing was deleted");
    expect(s.deletes).toEqual([]);
  });

  describe("Google-synced events", () => {
    it("previews with a note that it also removes the event at Google, and sends a plain DELETE (no apply_to)", async () => {
      const s = stub([ev("1", { source: "google" })]);
      const preview = await call("delete_calendar_event", { eventId: "1", date: "2026-11-12" });
      expect(preview.text).toContain("Google");
      expect(preview.text).toContain("everyone who shares");
      expect(s.deletes).toEqual([]);
      const out = await call("delete_calendar_event", { eventId: "1", date: "2026-11-12", confirm: true });
      expect(out.isError).toBe(false);
      expect(s.deletes).toHaveLength(1);
      expect(s.deletes[0]).toMatch(/calendar_events\/1$/);
    });
  });

  describe("repeating events (scope)", () => {
    const rep = (over: Record<string, unknown> = {}) =>
      ev("14553251426-1804032000", {
        source: "google",
        recurring: true,
        recurring_config: true,
        rrule: ["RRULE:FREQ=WEEKLY;WKST=SU;UNTIL=20270407T235959Z;INTERVAL=1;BYDAY=TU"],
        ...over,
      });
    const date = "2026-11-12";

    it("refuses a repeating event with no scope, even with confirm, and sends no DELETE", async () => {
      const s = stub([rep()]);
      const out = await call("delete_calendar_event", { eventId: "14553251426-1804032000", date, confirm: true });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("say how much to delete");
      expect(out.text).toContain("Nothing was deleted");
      expect(s.deletes).toEqual([]);
    });

    it("refuses a scope on a one-off event, and sends no DELETE", async () => {
      const s = stub([ev("1")]);
      const out = await call("delete_calendar_event", { eventId: "1", date, scope: "all", confirm: true });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("only applies to repeating events");
      expect(s.deletes).toEqual([]);
    });

    it("rejects a scope that is not one, future or all, and sends no DELETE", async () => {
      const s = stub([rep()]);
      const out = await call("delete_calendar_event", { eventId: "14553251426-1804032000", date, scope: "everything", confirm: true });
      expect(out.isError).toBe(true);
      expect(s.deletes).toEqual([]);
    });

    it.each([
      ["one", "ONLY the occurrence"],
      ["future", "AND every later occurrence"],
      ["all", "WHOLE series"],
    ])("scope %s: the preview says what it removes and sends nothing", async (scope, words) => {
      const s = stub([rep()]);
      const out = await call("delete_calendar_event", { eventId: "14553251426-1804032000", date, scope });
      expect(out.isError).toBe(false);
      expect(out.text).toContain("Preview only");
      expect(out.text).toContain(words);
      expect(out.text).toContain("RRULE:FREQ=WEEKLY");
      expect(s.deletes).toEqual([]);
    });

    it.each(["one", "future", "all"])("scope %s: with confirm sends exactly one DELETE carrying that scope and no other", async (scope) => {
      const s = stub([rep()]);
      const out = await call("delete_calendar_event", { eventId: "14553251426-1804032000", date, scope, confirm: true });
      expect(out.isError).toBe(false);
      expect(s.deletes).toEqual([expect.stringMatching(new RegExp(`/calendar_events/14553251426-1804032000\\?apply_to=${scope}$`))]);
    });

    it("keeps the token on the pinned host for a scoped delete", async () => {
      const s = stub([rep()]);
      await call("delete_calendar_event", { eventId: "14553251426-1804032000", date, scope: "one", confirm: true });
      expect(s.deletes[0]!.startsWith("https://app.ourskylight.com/")).toBe(true);
    });
  });

  it("refuses an id that is not on that date, and sends no DELETE", async () => {
    const s = stub([ev("1")]);
    const out = await call("delete_calendar_event", { eventId: "999", date: "2026-11-12", confirm: true });
    expect(out.isError).toBe(true);
    expect(s.deletes).toEqual([]);
  });

  it("is on the hosted allowlist as a destructive tool", () => {
    expect(HOSTED_DESTRUCTIVE_ALLOWLIST).toContain("delete_calendar_event");
    expect(HOSTED_DESTRUCTIVE_ALLOWLIST).not.toContain("delete_source_calendar");
  });
});
