import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { clearCategoriesCache, getCategories, resolveProfile } from "../src/api/endpoints/categories.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";

// The hosted Worker serves many users from one process. A profile list cached
// for one frame must never be served to another frame's request.

const cfg = (frameId: string) => ({ frameId, timezone: "UTC", token: `tok-${frameId}`, authType: "bearer" as const });
const cat = (id: string, label: string) => ({ id, type: "category", attributes: { label, color: "#fff", linked_to_profile: true } });

function stub(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      const data = u.includes("/frames/frame-a/") ? [cat("1", "Aardvark")] : [cat("2", "Zebra")];
      return new Response(JSON.stringify({ data }), { status: 200 });
    })
  );
}

async function members(frameId: string): Promise<string> {
  const server = new McpServer({ name: "skylight", version: "t" });
  registerTools(server, { hasPlus: true, photos: false });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const req = new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_family_members", arguments: {} } }),
  });
  const config = cfg(frameId);
  const res = await runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(req));
  const json = (await res.json()) as { result: { content: Array<{ text: string }> } };
  return json.result.content.map((c) => c.text).join("\n");
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearCategoriesCache();
});

describe("profile list cache is scoped per frame", () => {
  it("a second frame never sees the first frame's profiles", async () => {
    stub();
    expect(await members("frame-a")).toContain("Aardvark");
    const second = await members("frame-b");
    expect(second).toContain("Zebra");
    expect(second).not.toContain("Aardvark");
  });
});

describe("profile list cache freshness", () => {
  it("a profile added after the list was cached is found, not rejected", async () => {
    let data = [cat("1", "Aardvark")];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = cfg("frame-a");
    const client = new SkylightClient(config, null);
    await runWithContext({ client, config }, async () => {
      await getCategories();
      await getCategories();
      expect(fetchMock).toHaveBeenCalledTimes(1); // second read was cached
      data = [cat("1", "Aardvark"), cat("3", "Newcomer")];
      expect((await resolveProfile("newcomer")).id).toBe("3"); // one fresh look on a miss
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await expect(resolveProfile("nobody")).rejects.toThrow(/No profile called/);
    });
  });
});
