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
  const json = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: json.result.content.map((c) => c.text).join("\n"), isError: json.result.isError === true };
}

// "Alexander" contains "Alex": the old matcher resolved the shorter name to whichever came first.
const cat = (id: string, label: string) => ({ id, type: "category", attributes: { label, linked_to_profile: true } });
const categories = { data: [cat("12", "Alexander"), cat("11", "Alex"), cat("13", "Jordan")] };
const choreList = {
  data: [
    { id: "c1", type: "chore", attributes: { summary: "Dishes", status: "pending", start: "2026-11-03", start_time: null }, relationships: { category: { data: { type: "category", id: "11" } } } },
    { id: "c2", type: "chore", attributes: { summary: "Trash", status: "pending", start: "2026-11-03", start_time: null }, relationships: { category: { data: { type: "category", id: "12" } } } },
  ],
  included: categories.data,
};
const ok = { data: { id: "900", type: "chore", attributes: { summary: "x", status: "pending", start: "2026-11-03" } } };

interface Seen { url: string; method: string; body: string }
function stub(): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = String(url);
      const method = init.method ?? "GET";
      seen.push({ url: u, method, body: String(init.body ?? "") });
      if (u.includes("/categories")) return new Response(JSON.stringify(categories), { status: 200 });
      if (method === "GET" && u.includes("/chores")) return new Response(JSON.stringify(choreList), { status: 200 });
      if (method === "GET") return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (u.includes("create_multiple")) return new Response(JSON.stringify({ data: [ok.data] }), { status: 200 });
      return new Response(JSON.stringify(ok), { status: 200 });
    })
  );
  return seen;
}
const writes = (seen: Seen[]) => seen.filter((s) => s.method !== "GET");

afterEach(() => {
  vi.unstubAllGlobals();
  clearCategoriesCache();
});

describe("strict profile names", () => {
  it("create_chore assigns to the exact name, not the first name that contains it", async () => {
    const seen = stub();
    const out = await call("create_chore", { summary: "Dishes", date: "2026-11-03", assignee: "alex" });
    expect(out.isError).toBe(false);
    expect(writes(seen)[0]!.body).toContain('"category_ids":["11"]');
    expect(writes(seen)[0]!.body).not.toContain('"12"');
  });

  it("create_chore with a partial name fails, lists the profiles, and writes nothing", async () => {
    const seen = stub();
    const out = await call("create_chore", { summary: "Dishes", date: "2026-11-03", assignee: "Alexa" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Alexander");
    expect(writes(seen)).toHaveLength(0);
  });

  it("update_chore with a partial name fails and writes nothing", async () => {
    const seen = stub();
    const out = await call("update_chore", { choreId: "114", assignee: "Jor" });
    expect(out.isError).toBe(true);
    expect(writes(seen)).toHaveLength(0);
  });

  it("get_chores filters on the exact profile only", async () => {
    stub();
    const out = await call("get_chores", { date: "2026-11-03", dateEnd: "2026-11-03", assignee: "Alex" });
    expect(out.text).toContain("Dishes");
    expect(out.text).not.toContain("Trash");
  });

  it("create_reward and redeem_reward refuse a partial name and write nothing", async () => {
    const seen = stub();
    const a = await call("create_reward", { name: "Movie", pointValue: 10, assignee: "Alexa" });
    const b = await call("redeem_reward", { rewardId: "5", assignee: "Alexa" });
    expect(a.isError && b.isError).toBe(true);
    expect(writes(seen)).toHaveLength(0);
  });

  it("send_message and update_message refuse a partial sender and send nothing", async () => {
    const seen = stub();
    const a = await call("send_message", { body: "hi", from: "Alexa", confirm: true });
    const b = await call("update_message", { id: "5", body: "hi", from: "Alexa" });
    expect(a.isError).toBe(true);
    expect(a.text).toContain("Alexander");
    expect(b.isError).toBe(true);
    expect(writes(seen)).toHaveLength(0);
  });
});
