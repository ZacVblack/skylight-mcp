import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { clearCategoriesCache } from "../src/api/endpoints/categories.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";

const config = { frameId: "frame-1", timezone: "UTC", token: "test-access-1", authType: "bearer" as const };

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
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
  const json = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  return { text: json.result.content.map((c) => c.text).join("\n"), isError: !!json.result.isError };
}

interface Seen { url: string; method: string; body: unknown }

/** Responses mirror the captured success cases: `data` is an ARRAY, one item per profile. */
function stub(): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      seen.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "POST" && u.includes("/chores/create_multiple")) {
        return new Response(
          JSON.stringify({ data: [{ id: "900", type: "chore", attributes: { summary: "Dishes", start: "2026-11-09", start_time: null, recurring: false } }] }),
          { status: 200 }
        );
      }
      if (method === "POST" && u.endsWith("/rewards")) {
        return new Response(
          JSON.stringify({ data: [{ id: "800", type: "reward", attributes: { name: "Movie", point_value: 5, respawn_on_redemption: false } }] }),
          { status: 201 }
        );
      }
      if (u.includes("/categories")) {
        return new Response(JSON.stringify({ data: [{ id: "7", type: "category", attributes: { label: "Jordan", linked_to_profile: true } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    })
  );
  return seen;
}

const writes = (seen: Seen[]) => seen.filter((s) => s.method !== "GET");

afterEach(() => {
  vi.unstubAllGlobals();
  clearCategoriesCache();
});

describe("create_chore", () => {
  it("posts the captured flat body to create_multiple with category_ids", async () => {
    const seen = stub();
    const r = await call("create_chore", { summary: "Dishes", date: "2026-11-09", assignee: "Jordan" });
    expect(r.isError).toBe(false);
    const post = writes(seen)[0];
    expect(post.method).toBe("POST");
    expect(post.url).toContain("/frames/frame-1/chores/create_multiple");
    expect(post.body).toEqual({
      summary: "Dishes",
      start: "2026-11-09",
      start_time: null,
      category_ids: ["7"],
      routine: false,
      up_for_grabs: false,
      recurrence_set: null,
      recurring_until: null,
      renewal_interval: null,
      renewal_unit: null,
    });
    // No JSON:API envelope: the property that caused the 422.
    expect(post.body).not.toHaveProperty("data");
    expect(r.text).toContain("ID: 900");
  });

  it("sends reward_points as captured when stars are given", async () => {
    const seen = stub();
    await call("create_chore", { summary: "Dishes", date: "2026-11-09", assignee: "Jordan", rewardPoints: 1 });
    expect(writes(seen)[0].body).toMatchObject({ reward_points: 1, routine: false, category_ids: ["7"] });
  });

  it("refuses without an assignee and writes nothing", async () => {
    const seen = stub();
    const r = await call("create_chore", { summary: "Dishes", date: "2026-11-09" });
    expect(r.isError).toBe(true);
    expect(writes(seen)).toHaveLength(0);
  });

  it("refuses the removed recurrence arguments instead of quietly making a one-off chore", async () => {
    const seen = stub();
    const r = await call("create_chore", { summary: "Dishes", date: "2026-11-09", assignee: "Jordan", recurring: true, recurrencePattern: "daily" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("recurring");
    expect(writes(seen)).toEqual([]);
  });
});

describe("create_reward", () => {
  it("posts the captured flat body with category_ids", async () => {
    const seen = stub();
    const r = await call("create_reward", { name: "Movie", pointValue: 5, assignee: "Jordan" });
    expect(r.isError).toBe(false);
    const post = writes(seen)[0];
    expect(post.method).toBe("POST");
    expect(post.url).toMatch(/\/frames\/frame-1\/rewards$/);
    expect(post.body).toEqual({ name: "Movie", point_value: 5, respawn_on_redemption: false, category_ids: ["7"] });
    expect(post.body).not.toHaveProperty("data");
    expect(r.text).toContain("ID: 800");
  });

  it("refuses without an assignee and writes nothing", async () => {
    const seen = stub();
    const r = await call("create_reward", { name: "Movie", pointValue: 5 });
    expect(r.isError).toBe(true);
    expect(writes(seen)).toHaveLength(0);
  });
});
