import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { clearCategoriesCache } from "../src/api/endpoints/categories.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";
import { HOSTED_DESTRUCTIVE_ALLOWLIST, HOSTED_EFFECTS } from "../src/worker/mcp.js";

const config = { frameId: "frame-1", timezone: "UTC", token: "test-access-1", authType: "bearer" as const };

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const server = new McpServer({ name: "skylight", version: "t" });
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

const SERIES_ID = "14553251426-1804032000";

function ev(id: string, over: Record<string, unknown> = {}, cats = ["11", "13"]) {
  return {
    id,
    type: "calendar_event",
    attributes: {
      summary: "Practice",
      starts_at: "2026-11-12T18:00:00.000-08:00",
      ends_at: "2026-11-12T19:00:00.000-08:00",
      all_day: false,
      recurring: true,
      recurring_config: true,
      master_event_id: null,
      source: "google",
      editable: true,
      ...over,
    },
    relationships: { categories: { data: cats.map((c) => ({ id: c, type: "category" })) } },
  };
}

type Put = { url: string; body: Record<string, unknown> };

function stub(events: unknown[]) {
  const puts: Put[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/categories")) {
        const cat = (id: string, label: string) => ({ id, type: "category", attributes: { label, linked_to_profile: true } });
        return new Response(JSON.stringify({ data: [cat("11", "Alex"), cat("13", "Jordan")] }), { status: 200 });
      }
      if (method === "PUT") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        puts.push({ url: u, body });
        // What the server returned in the capture: the edited event.
        return new Response(JSON.stringify({ data: { id: u.endsWith(SERIES_ID) && body.apply_to === "one" ? "14553525362" : SERIES_ID, type: "calendar_event", attributes: { summary: body.summary ?? "Practice" } } }), { status: 200 });
      }
      if (u.includes("/calendar_events")) return new Response(JSON.stringify({ data: events }), { status: 200 });
      return new Response("{}", { status: 200 });
    })
  );
  return { puts };
}

beforeEach(() => {});
afterEach(() => {
  vi.unstubAllGlobals();
  clearCategoriesCache();
});

describe("update_calendar_event on repeating events (scope)", () => {
  const date = "2026-11-12";

  it.each(["one", "all"])("scope %s: sends one PUT to the occurrence with apply_to and the current profiles", async (scope) => {
    const s = stub([ev(SERIES_ID)]);
    const out = await call("update_calendar_event", { eventId: SERIES_ID, date, scope, summary: "Practice 2" });
    expect(out.isError).toBe(false);
    expect(s.puts).toHaveLength(1);
    expect(s.puts[0]!.url).toMatch(new RegExp(`/calendar_events/${SERIES_ID}$`));
    // The app always re-sends the profile assignment; a title change must not clear it.
    expect(s.puts[0]!.body).toEqual({ summary: "Practice 2", category_ids: ["11", "13"], apply_to: scope });
  });

  it("scope one reports that the occurrence became its own event; scope all warns it overwrote one-off edits", async () => {
    stub([ev(SERIES_ID)]);
    const one = await call("update_calendar_event", { eventId: SERIES_ID, date, scope: "one", summary: "Practice 2" });
    expect(one.text).toContain("detached from the series");
    expect(one.text).toContain("14553525362");
    const all = await call("update_calendar_event", { eventId: SERIES_ID, date, scope: "all", summary: "Practice 3" });
    expect(all.text).toContain("whole series");
    expect(all.text).toContain("edited on their own");
  });

  it("assigning profiles by name replaces the current ones", async () => {
    const s = stub([ev(SERIES_ID)]);
    await call("update_calendar_event", { eventId: SERIES_ID, date, scope: "all", profiles: ["Jordan"] });
    expect(s.puts[0]!.body).toEqual({ category_ids: ["13"], apply_to: "all" });
  });

  it("refuses a repeating event with no scope, and sends no PUT", async () => {
    const s = stub([ev(SERIES_ID)]);
    const out = await call("update_calendar_event", { eventId: SERIES_ID, date, summary: "X" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("say how much to change");
    expect(s.puts).toEqual([]);
  });

  it("refuses scope future (Skylight's API refuses it), and sends no PUT", async () => {
    const s = stub([ev(SERIES_ID)]);
    const out = await call("update_calendar_event", { eventId: SERIES_ID, date, scope: "future", summary: "X" });
    expect(out.isError).toBe(true);
    expect(s.puts).toEqual([]);
  });

  it("refuses a repeating event with no date, and sends no PUT", async () => {
    const s = stub([ev(SERIES_ID)]);
    const out = await call("update_calendar_event", { eventId: SERIES_ID, scope: "one", summary: "X" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("needs the occurrence's date");
    expect(s.puts).toEqual([]);
  });

  it.each([
    ["allDay", { allDay: true }],
    ["description", { description: "bring water" }],
    ["location", { location: "Field 2" }],
  ])("refuses to change %s on a series (not verified), and sends no PUT", async (_f, extra) => {
    const s = stub([ev(SERIES_ID)]);
    const out = await call("update_calendar_event", { eventId: SERIES_ID, date, scope: "all", summary: "X", ...extra });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("not verified");
    expect(s.puts).toEqual([]);
  });

  describe("time of day on a series", () => {
    it("scope all: sends starts_at, ends_at (with offset) and timezone with apply_to and the current profiles", async () => {
      const s = stub([ev(SERIES_ID)]);
      const out = await call("update_calendar_event", { eventId: SERIES_ID, date, scope: "all", startsAt: "2026-11-12T19:00", endsAt: "2026-11-12T20:00" });
      expect(out.isError).toBe(false);
      expect(s.puts).toHaveLength(1);
      expect(s.puts[0]!.body).toEqual({
        category_ids: ["11", "13"],
        starts_at: "2026-11-12T19:00:00.000+00:00",
        ends_at: "2026-11-12T20:00:00.000+00:00",
        timezone: "UTC",
        apply_to: "all",
      });
    });

    it("scope one: sends the same time fields with apply_to one (not verified live)", async () => {
      const s = stub([ev(SERIES_ID)]);
      const out = await call("update_calendar_event", { eventId: SERIES_ID, date, scope: "one", startsAt: "2026-11-12T19:00", endsAt: "2026-11-12T20:00" });
      expect(out.isError).toBe(false);
      expect(s.puts).toHaveLength(1);
      expect(s.puts[0]!.body).toMatchObject({ starts_at: "2026-11-12T19:00:00.000+00:00", ends_at: "2026-11-12T20:00:00.000+00:00", timezone: "UTC", apply_to: "one" });
    });

    it.each([
      ["only startsAt", { startsAt: "2026-11-12T19:00" }],
      ["only endsAt", { endsAt: "2026-11-12T20:00" }],
      ["a different date", { startsAt: "2026-11-13T19:00", endsAt: "2026-11-13T20:00" }],
      ["an offset", { startsAt: "2026-11-12T19:00:00-08:00", endsAt: "2026-11-12T20:00:00-08:00" }],
      ["end before start", { startsAt: "2026-11-12T19:00", endsAt: "2026-11-12T18:00" }],
    ])("refuses %s and sends no PUT", async (_n, extra) => {
      const s = stub([ev(SERIES_ID)]);
      const out = await call("update_calendar_event", { eventId: SERIES_ID, date, scope: "all", ...extra });
      expect(out.isError).toBe(true);
      expect(s.puts).toEqual([]);
    });
  });

  it("refuses a scope on a one-off event, and sends no PUT", async () => {
    const s = stub([ev("1", { recurring: false, recurring_config: false })]);
    const out = await call("update_calendar_event", { eventId: "1", scope: "all", summary: "X" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("only applies to repeating events");
    expect(s.puts).toEqual([]);
  });

  it("a one-off event update is unchanged: no apply_to, no extra read needed", async () => {
    const s = stub([]);
    const out = await call("update_calendar_event", { eventId: "1", summary: "New title" });
    expect(out.isError).toBe(false);
    expect(s.puts).toEqual([expect.objectContaining({ body: { summary: "New title" } })]);
  });

  it.each([
    ["a feed event", { source: "ics_link", editable: false }],
    ["a non-editable event", { editable: false }],
    ["an occurrence edited on its own", { recurring: false, recurring_config: false, master_event_id: "uid" }],
    ["an event that is not a series", { recurring: false, recurring_config: false }],
  ])("refuses %s, and sends no PUT", async (_l, over) => {
    const s = stub([ev(SERIES_ID, over)]);
    const out = await call("update_calendar_event", { eventId: SERIES_ID, date, scope: "all", summary: "X" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Nothing was changed");
    expect(s.puts).toEqual([]);
  });

  it("keeps the token on the pinned host", async () => {
    const s = stub([ev(SERIES_ID)]);
    await call("update_calendar_event", { eventId: SERIES_ID, date, scope: "one", summary: "X" });
    expect(s.puts[0]!.url.startsWith("https://app.ourskylight.com/")).toBe(true);
  });
});
