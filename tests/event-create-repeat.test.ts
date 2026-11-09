import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { clearCategoriesCache } from "../src/api/endpoints/categories.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";
import { HOSTED_DESTRUCTIVE_ALLOWLIST, HOSTED_EFFECTS } from "../src/worker/mcp.js";

const config = { frameId: "frame-1", timezone: "America/Los_Angeles", token: "test-access-1", authType: "bearer" as const };

async function call(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const server = new McpServer({ name: "skylight", version: "t" });
  registerTools(server, { hasPlus: true, effects: HOSTED_EFFECTS, include: HOSTED_DESTRUCTIVE_ALLOWLIST, photos: false });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const req = new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_calendar_event", arguments: args } }),
  });
  const res = await runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(req));
  const json = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: json.result.content.map((c) => c.text).join("\n"), isError: Boolean(json.result.isError) };
}

type Post = { url: string; body: Record<string, unknown> };
function stub() {
  const posts: Post[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/categories")) {
        const cat = (id: string, label: string) => ({ id, type: "category", attributes: { label, linked_to_profile: true } });
        return new Response(JSON.stringify({ data: [cat("11", "Alex"), cat("13", "Jordan")] }), { status: 200 });
      }
      if ((init?.method ?? "GET") === "POST" && u.includes("/calendar_events")) {
        posts.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
        return new Response(JSON.stringify({ data: { id: "99-1900000000", type: "calendar_event", attributes: {} } }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    })
  );
  return { posts };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearCategoriesCache();
});

const base = { summary: "Practice", startsAt: "2037-03-03T16:00", endsAt: "2037-03-03T17:00", repeat: { frequency: "weekly", count: 3 } };

describe("create_calendar_event with repeat", () => {
  it("without confirm: previews every date and sends no POST", async () => {
    const s = stub();
    const out = await call(base);
    expect(out.isError).toBe(false);
    expect(out.text).toContain("PREVIEW, nothing created");
    expect(out.text).toContain("2037-03-03, 2037-03-10, 2037-03-17");
    expect(out.text).toContain("find_conflicts");
    expect(out.text).toContain("not written to Google");
    expect(s.posts).toEqual([]);
  });

  it("confirm:false is still a preview", async () => {
    const s = stub();
    await call({ ...base, confirm: false });
    expect(s.posts).toEqual([]);
  });

  it("with confirm: one POST carrying the rrule, local offset times and no calendar chosen by the caller", async () => {
    const s = stub();
    const out = await call({ ...base, confirm: true, profiles: ["Alex"] });
    expect(out.isError).toBe(false);
    expect(s.posts).toHaveLength(1);
    const b = s.posts[0]!.body;
    expect(b.rrule).toEqual(["RRULE:FREQ=WEEKLY;INTERVAL=1;UNTIL=20370317T235959Z;WKST=SU;BYDAY=TU"]);
    expect(b.starts_at).toMatch(/-0[78]:00$/);
    expect(b.category_ids).toEqual(["11"]);
    expect(b).not.toHaveProperty("calendar_id");
    expect(b).not.toHaveProperty("calendar_account_id");
  });

  it("a plain one-off create is unchanged: no rrule, no preview", async () => {
    const s = stub();
    const out = await call({ summary: "Dentist", startsAt: "2037-03-03T16:00", endsAt: "2037-03-03T17:00" });
    expect(out.text).toContain("Created calendar event");
    expect(s.posts[0]!.body).not.toHaveProperty("rrule");
  });

  it.each([
    ["two profiles", { profiles: ["Alex", "Jordan"] }],
    ["offset in startsAt", { startsAt: "2037-03-03T16:00:00-08:00" }],
    ["date-only start", { startsAt: "2037-03-03", endsAt: "2037-03-03" }],
    ["end before start", { endsAt: "2037-03-03T15:00" }],
    ["monthly", { repeat: { frequency: "monthly", count: 3 } }],
    ["no end", { repeat: { frequency: "weekly" } }],
    ["unknown repeat key", { repeat: { frequency: "weekly", count: 3, rrule: "x" } }],
    ["past start", { startsAt: "2020-03-03T16:00", endsAt: "2020-03-03T17:00" }],
  ])("refuses %s and sends nothing, even with confirm", async (_n, over) => {
    const s = stub();
    const out = await call({ ...base, confirm: true, ...over });
    expect(out.isError).toBe(true);
    expect(s.posts).toEqual([]);
  });

  it("confirm on a one-off event is refused", async () => {
    const s = stub();
    const out = await call({ summary: "Dentist", startsAt: "2037-03-03T16:00", endsAt: "2037-03-03T17:00", confirm: true });
    expect(out.isError).toBe(true);
    expect(s.posts).toEqual([]);
  });

  describe("all-day series", () => {
    const ad = { summary: "No school", startsAt: "2037-03-03", endsAt: "2037-03-04", allDay: true, repeat: { frequency: "weekly", count: 3 } };

    it("previews the dates as all day and sends nothing without confirm", async () => {
      const s = stub();
      const out = await call(ad);
      expect(out.isError).toBe(false);
      expect(out.text).toContain("PREVIEW, nothing created");
      expect(out.text).toContain("all day");
      expect(out.text).toContain("2037-03-03, 2037-03-10, 2037-03-17");
      expect(s.posts).toEqual([]);
    });

    it("with confirm: date-only start and next-day end, all_day true, UNTIL date rule, no calendar fields", async () => {
      const s = stub();
      const out = await call({ ...ad, confirm: true, profiles: ["Alex"] });
      expect(out.isError).toBe(false);
      expect(s.posts).toHaveLength(1);
      const b = s.posts[0]!.body;
      expect(b.all_day).toBe(true);
      expect(b.starts_at).toBe("2037-03-03");
      expect(b.ends_at).toBe("2037-03-04");
      expect(b.timezone).toBe("America/Los_Angeles");
      expect(b.rrule).toEqual(["RRULE:FREQ=WEEKLY;INTERVAL=1;UNTIL=20370317T235959Z;WKST=SU;BYDAY=TU"]);
      expect(b.category_ids).toEqual(["11"]);
      expect(b).not.toHaveProperty("calendar_id");
    });

    it.each([
      ["a time in startsAt", { startsAt: "2037-03-03T09:00" }],
      ["a multi-day occurrence", { endsAt: "2037-03-06" }],
      ["end equal to start", { endsAt: "2037-03-03" }],
      ["a past date", { startsAt: "2020-03-03", endsAt: "2020-03-04" }],
      ["two profiles", { profiles: ["Alex", "Jordan"] }],
      ["no end condition", { repeat: { frequency: "weekly" } }],
    ])("refuses %s and sends nothing, even with confirm", async (_n, over) => {
      const s = stub();
      const out = await call({ ...ad, confirm: true, ...over });
      expect(out.isError).toBe(true);
      expect(s.posts).toEqual([]);
    });
  });
});
