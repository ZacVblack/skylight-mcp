import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { clearCategoriesCache } from "../src/api/endpoints/categories.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";

const config = { frameId: "frame-1", timezone: "UTC", token: "test-access-1", authType: "bearer" as const };

async function listEvents(): Promise<string> {
  const server = new McpServer({ name: "skylight", version: "t" });
  registerTools(server, { hasPlus: true, photos: false });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const req = new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_calendar_events", arguments: { date: "2026-11-03" } } }),
  });
  const res = await runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(req));
  const json = (await res.json()) as { result: { content: Array<{ text: string }> } };
  return json.result.content.map((c) => c.text).join("\n");
}

const attrs = {
  summary: "Practice",
  starts_at: "2026-11-03T16:00:00.000-08:00",
  ends_at: "2026-11-03T17:00:00.000-08:00",
  all_day: false,
  source: "google",
  owner_email: "owner@example.com",
  calendar_id: "family123@group.calendar.example.com",
  calendar_account_id: "acct-1",
  invited_emails: "a@example.com,b@example.com",
  uid: "uid-abc",
  supports_notification_settings: false,
};

function stub(events: unknown[], categoriesStatus = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/categories")) {
        if (categoriesStatus !== 200) return new Response("{}", { status: categoriesStatus });
        const cat = (id: string, label: string) => ({ id, type: "category", attributes: { label, linked_to_profile: true } });
        return new Response(JSON.stringify({ data: [cat("11", "Alex"), cat("13", "Jordan")] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: events }), { status: 200 });
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearCategoriesCache();
});

describe("get_calendar_events output", () => {
  it("never prints emails, calendar ids, account ids or UIDs", async () => {
    stub([{ id: "1", type: "calendar_event", attributes: attrs }]);
    const text = await listEvents();
    expect(text).toContain("summary: Practice");
    expect(text).toContain("source: google");
    for (const leaked of ["owner@example.com", "a@example.com", "family123", "acct-1", "uid-abc", "owner_email", "calendar_id", "uid:"]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("still prints fields it has not seen before", async () => {
    stub([{ id: "1", type: "calendar_event", attributes: { ...attrs, brand_new_field: "kept" } }]);
    expect(await listEvents()).toContain("brand_new_field: kept");
  });

  it("names the assigned profiles from relationships.categories", async () => {
    stub([{ id: "1", type: "calendar_event", attributes: attrs, relationships: { categories: { data: [{ id: "11" }, { id: "13" }] } } }]);
    expect(await listEvents()).toContain("profiles: Alex, Jordan");
  });

  it("names a profile given as category_ids in attributes", async () => {
    stub([{ id: "1", type: "calendar_event", attributes: { ...attrs, category_ids: ["13"] } }]);
    expect(await listEvents()).toContain("profiles: Jordan");
  });

  it("prints no profiles line when none are assigned or the id is unknown", async () => {
    stub([
      { id: "1", type: "calendar_event", attributes: attrs, relationships: { categories: { data: [] } } },
      { id: "2", type: "calendar_event", attributes: attrs, relationships: { categories: { data: [{ id: "999" }] } } },
    ]);
    expect(await listEvents()).not.toContain("profiles:");
  });

  it("still lists events when the profile lookup fails", async () => {
    stub([{ id: "1", type: "calendar_event", attributes: attrs, relationships: { categories: { data: [{ id: "11" }] } } }], 500);
    const text = await listEvents();
    expect(text).toContain("summary: Practice");
    expect(text).not.toContain("profiles:");
  });
});

describe("get_calendar_events profiles on a shared event", () => {
  it("asks for categories and prints every profile an event is assigned to", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        urls.push(u);
        if (u.includes("/categories")) {
          const cat = (id: string, label: string) => ({ id, type: "category", attributes: { label, linked_to_profile: true } });
          return new Response(JSON.stringify({ data: [cat("11", "Alex"), cat("13", "Jordan")] }), { status: 200 });
        }
        // Mirrors the live API: the full set comes back only when categories are included;
        // otherwise a single profile is reported.
        const withAll = u.includes("include=categories");
        const relationships = withAll
          ? { categories: { data: [{ id: "11", type: "category" }, { id: "13", type: "category" }] } }
          : { category: { data: { id: "13", type: "category" } } };
        return new Response(JSON.stringify({ data: [{ id: "1", type: "calendar_event", attributes: attrs, relationships }] }), { status: 200 });
      })
    );
    const text = await listEvents();
    expect(urls.some((u) => u.includes("calendar_events") && u.includes("include=categories"))).toBe(true);
    expect(text).toContain("profiles: Alex, Jordan");
  });
});
