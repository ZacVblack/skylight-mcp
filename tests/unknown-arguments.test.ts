/**
 * Refuse, never ignore. A tool called with an argument it does not know must fail and name the
 * argument, on every tool, on both servers. Before this, the SDK's default schema dropped unknown
 * keys silently: find_conflicts called with startsAt/endsAt (it takes date/dateEnd) ran over its
 * default week and the caller reported "no conflicts" for dates that were never checked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { runWithContext } from "../src/context.js";
import { registerTools, type RegisterToolsOptions } from "../src/tools/registry.js";
import { HOSTED_DESTRUCTIVE_ALLOWLIST, HOSTED_EFFECTS } from "../src/worker/mcp.js";

const config = { frameId: "frame-1", timezone: "America/Los_Angeles", token: "test-access-1", authType: "bearer" as const };
const LOCAL: RegisterToolsOptions = { hasPlus: true };
const HOSTED: RegisterToolsOptions = { hasPlus: true, effects: HOSTED_EFFECTS, include: HOSTED_DESTRUCTIVE_ALLOWLIST, photos: false };

type Rpc = { result?: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string; inputSchema: { additionalProperties?: unknown } }> }; error?: { message: string } };

async function rpc(options: RegisterToolsOptions, method: string, params: Record<string, unknown>): Promise<{ json: Rpc; names: string[] }> {
  const server = new McpServer({ name: "skylight", version: "t" });
  const names = registerTools(server, options);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const req = new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const res = await runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(req));
  return { json: (await res.json()) as Rpc, names };
}

/** The refusal text, wherever the SDK puts it (a JSON-RPC error or an isError result). Empty if the call was accepted. */
function refusal(json: Rpc): string {
  if (json.error) return json.error.message;
  if (json.result?.isError) return (json.result.content ?? []).map((c) => c.text).join("\n");
  return "";
}

function stubFetch() {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    })
  );
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

describe.each([
  ["local", LOCAL],
  ["hosted", HOSTED],
])("unknown arguments are refused on the %s server", (_label, options) => {
  it("every tool refuses an argument it does not know, names it, and sends nothing", async () => {
    const urls = stubFetch();
    const { names } = await rpc(options, "tools/list", {});
    expect(names.length).toBeGreaterThan(20);
    const accepted: string[] = [];
    for (const name of names) {
      const { json } = await rpc(options, "tools/call", { name, arguments: { not_a_real_argument: 1 } });
      if (!refusal(json).includes("not_a_real_argument")) accepted.push(name);
    }
    expect(accepted).toEqual([]);
    expect(urls).toEqual([]);
  });

  it("every tool's published schema says so (additionalProperties: false)", async () => {
    const { json } = await rpc(options, "tools/list", {});
    const open = (json.result?.tools ?? []).filter((t) => t.inputSchema.additionalProperties !== false).map((t) => t.name);
    expect(json.result?.tools?.length).toBeGreaterThan(20);
    expect(open).toEqual([]);
  });

  it("find_conflicts with startsAt/endsAt is refused; with date/dateEnd it runs", async () => {
    const urls = stubFetch();
    const wrong = await rpc(options, "tools/call", { name: "find_conflicts", arguments: { startsAt: "2037-03-03", endsAt: "2037-03-10" } });
    expect(refusal(wrong.json)).toContain("startsAt");
    expect(urls).toEqual([]);
    const right = await rpc(options, "tools/call", { name: "find_conflicts", arguments: { date: "2037-03-03", dateEnd: "2037-03-10" } });
    expect(refusal(right.json)).toBe("");
    expect(urls.some((u) => u.includes("date_min=2037-03-03"))).toBe(true);
  });
});
