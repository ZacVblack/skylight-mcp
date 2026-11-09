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
const GCAL = "family-secret-addr@group.calendar.example.com";
const ACCT = "acct-secret-77";

function stub(opts: { withEvent?: boolean } = {}) {
  const posts: Post[] = [];
  const urls: string[] = [];
  const withEvent = opts.withEvent ?? true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/categories")) {
        return new Response(JSON.stringify({ data: [{ id: "11", type: "category", attributes: { label: "Alex", linked_to_profile: true } }] }), { status: 200 });
      }
      if (u.includes("/source_calendars")) {
        const sc = (id: string, label: string, kind: string, source_id: string, role: string, editable: boolean) => ({ id, type: "source_calendar", attributes: { label, kind, source_id, role, editable } });
        return new Response(JSON.stringify({ data: [
          sc("1", "Family", "gmail", GCAL, "writer", true),
          sc("2", "League", "webcal", "https://league.example.com/x", "reader", false),
          sc("3", "Shared RO", "gmail", "ro@group.calendar.example.com", "reader", false),
        ] }), { status: 200 });
      }
      if ((init?.method ?? "GET") === "POST" && u.includes("/calendar_events")) {
        posts.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
        return new Response(JSON.stringify({ data: { id: "99-1900000000", type: "calendar_event", attributes: {} } }), { status: 200 });
      }
      if (u.includes("/calendar_events")) {
        const data = withEvent
          ? [{ id: "5", type: "calendar_event", attributes: { summary: "Existing", source: "google", calendar_id: GCAL, calendar_account_id: ACCT } }, { id: "7", type: "calendar_event", attributes: { summary: "RO", source: "google", calendar_id: "ro@group.calendar.example.com", calendar_account_id: ACCT } }]
          : [{ id: "6", type: "calendar_event", attributes: { summary: "Other", source: "skylight" } }];
        return new Response(JSON.stringify({ data }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    })
  );
  return { posts, urls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearCategoriesCache();
});

const one = { summary: "Game", startsAt: "2037-03-03T16:00", endsAt: "2037-03-03T17:00", calendar: "Family" };

describe("create_calendar_event with calendar (Google target)", () => {
  it("without confirm: previews, names the calendar, sends no POST and leaks no ids", async () => {
    const s = stub();
    const out = await call(one);
    expect(out.isError).toBe(false);
    expect(out.text).toContain("PREVIEW, nothing created");
    expect(out.text).toContain('Google calendar "Family"');
    expect(out.text).not.toContain(GCAL);
    expect(out.text).not.toContain(ACCT);
    expect(s.posts).toEqual([]);
  });

  it("with confirm: one POST carrying the calendar address and account from an existing event; reply leaks no ids", async () => {
    const s = stub();
    const out = await call({ ...one, confirm: true, profiles: ["Alex"] });
    expect(out.isError).toBe(false);
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.body.calendar_id).toBe(GCAL);
    expect(s.posts[0]!.body.calendar_account_id).toBe(ACCT);
    expect(s.posts[0]!.body.category_ids).toEqual(["11"]);
    expect(out.text).toContain('Google calendar "Family"');
    expect(out.text).not.toContain(GCAL);
    expect(out.text).not.toContain(ACCT);
  });

  it("matches the name case-insensitively", async () => {
    const s = stub();
    await call({ ...one, calendar: "  fAmily ", confirm: true });
    expect(s.posts[0]!.body.calendar_id).toBe(GCAL);
  });

  it("a series with calendar previews every date and names the calendar, then posts once with the rrule", async () => {
    const s = stub();
    const rep = { ...one, repeat: { frequency: "weekly", count: 3 } };
    const pre = await call(rep);
    expect(pre.text).toContain("2037-03-03, 2037-03-10, 2037-03-17");
    expect(pre.text).toContain('Google calendar "Family"');
    expect(pre.text).not.toContain("not written to Google");
    expect(s.posts).toEqual([]);
    await call({ ...rep, confirm: true });
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.body.rrule).toEqual(["RRULE:FREQ=WEEKLY;INTERVAL=1;UNTIL=20370317T235959Z;WKST=SU;BYDAY=TU"]);
    expect(s.posts[0]!.body.calendar_id).toBe(GCAL);
  });

  it("an all-day series with calendar posts date-only start and end plus the Google calendar fields", async () => {
    const s = stub();
    const body = { summary: "No school", startsAt: "2037-03-03", endsAt: "2037-03-04", allDay: true, repeat: { frequency: "weekly", count: 3 }, calendar: "Family" };
    const pre = await call(body);
    expect(pre.text).toContain("all day");
    expect(pre.text).toContain('Google calendar "Family"');
    expect(s.posts).toEqual([]);
    await call({ ...body, confirm: true });
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.body.all_day).toBe(true);
    expect(s.posts[0]!.body.starts_at).toBe("2037-03-03");
    expect(s.posts[0]!.body.ends_at).toBe("2037-03-04");
    expect(s.posts[0]!.body.calendar_id).toBe(GCAL);
    expect(s.posts[0]!.body.calendar_account_id).toBe(ACCT);
  });

  it("without calendar nothing changes: Skylight's own calendar, no calendar fields", async () => {
    const s = stub();
    await call({ summary: "Dentist", startsAt: one.startsAt, endsAt: one.endsAt });
    expect(s.posts[0]!.body).not.toHaveProperty("calendar_id");
    expect(s.posts[0]!.body).not.toHaveProperty("calendar_account_id");
  });

  it.each([
    ["unknown name", { calendar: "Nope" }],
    ["a subscription feed", { calendar: "League" }],
    ["a read-only Google calendar", { calendar: "Shared RO" }],
  ])("refuses %s and sends nothing, even with confirm", async (_n, over) => {
    const s = stub();
    const out = await call({ ...one, confirm: true, ...over });
    expect(out.isError).toBe(true);
    expect(s.posts).toEqual([]);
  });

  it("names the linked Google calendars when the name is unknown", async () => {
    stub();
    const out = await call({ ...one, calendar: "Nope" });
    expect(out.text).toContain("Family");
    expect(out.text).not.toContain(GCAL);
  });

  it("refuses when the account cannot be determined (no existing event on that calendar)", async () => {
    const s = stub({ withEvent: false });
    const out = await call({ ...one, confirm: true });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Nothing was created");
    expect(s.posts).toEqual([]);
  });

  it("every request still goes to the pinned host", async () => {
    const s = stub();
    await call({ ...one, confirm: true });
    expect(s.urls.length).toBeGreaterThan(0);
    for (const u of s.urls) expect(u.startsWith("https://app.ourskylight.com/")).toBe(true);
  });

  it("confirm on a one-off event without calendar is still refused", async () => {
    const s = stub();
    const out = await call({ summary: "Dentist", startsAt: one.startsAt, endsAt: one.endsAt, confirm: true });
    expect(out.isError).toBe(true);
    expect(s.posts).toEqual([]);
  });
});
