import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { clearCategoriesCache } from "../src/api/endpoints/categories.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";

const config = { frameId: "frame-1", timezone: "UTC", token: "test-access-1", authType: "bearer" as const };

async function call(name: string, args: Record<string, unknown>): Promise<string> {
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
  const json = (await res.json()) as { result: { content: Array<{ text: string }> } };
  return json.result.content.map((c) => c.text).join("\n");
}

// delete_chore, update_chore and complete_chore all take an id "from get_chores", so get_chores must print it.
// A one-off chore has a plain numeric id; a recurring occurrence has a composite id.
const chores = {
  data: [
    { id: "900001", type: "chore", attributes: { summary: "One-off task", status: "pending", start: "2026-11-09", recurring: false, routine: false, up_for_grabs: false }, relationships: {} },
    { id: "12345-2026-11-09-0600", type: "chore", attributes: { summary: "Daily task", status: "pending", start: "2026-11-09", recurring: true, routine: false, up_for_grabs: false }, relationships: {} },
  ],
  included: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  clearCategoriesCache();
});

describe("get_chores prints the id every chore tool needs", () => {
  it("shows the id of a one-off chore and of a recurring occurrence, next to the right chore", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes("/chores") ? chores : { data: [] }), { status: 200 })));
    const text = await call("get_chores", { date: "2026-11-09", dateEnd: "2026-11-09" });
    expect(text).toContain("- One-off task (ID: 900001)");
    expect(text).toContain("- Daily task (ID: 12345-2026-11-09-0600)");
  });
});
