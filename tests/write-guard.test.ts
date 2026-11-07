import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";
import { WriteGuard } from "../src/utils/write-guard.js";

const LIMITS = { windowMs: 1000, maxWrites: 3, maxDestructive: 2 };

describe("WriteGuard", () => {
  it("allows up to the limit, then refuses with a retry time", () => {
    let t = 0;
    const g = new WriteGuard(LIMITS, () => t);
    for (let i = 0; i < 3; i++) expect(g.admit("write").ok).toBe(true);
    const verdict = g.admit("write");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toMatch(/change limit/);
      expect(verdict.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });

  it("forgets calls after the window", () => {
    let t = 0;
    const g = new WriteGuard(LIMITS, () => t);
    for (let i = 0; i < 3; i++) g.admit("write");
    expect(g.admit("write").ok).toBe(false);
    t = 1001;
    expect(g.admit("write").ok).toBe(true);
  });

  it("caps deletes below the general limit, and deletes count toward the general limit", () => {
    let t = 0;
    const g = new WriteGuard(LIMITS, () => t);
    expect(g.admit("destructive").ok).toBe(true);
    expect(g.admit("destructive").ok).toBe(true);
    const third = g.admit("destructive");
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toMatch(/delete limit/);
    // Two deletes used two of three changes; one ordinary write is left.
    expect(g.admit("write").ok).toBe(true);
    expect(g.admit("write").ok).toBe(false);
  });

  it("does not record a refused call", () => {
    let t = 0;
    const g = new WriteGuard(LIMITS, () => t);
    for (let i = 0; i < 3; i++) g.admit("write");
    for (let i = 0; i < 5; i++) g.admit("write");
    expect(g.recent()).toBe(3);
  });
});

// Through the real registry and a real tool, with the network stubbed.
const config = { frameId: "frame-1", timezone: "UTC", token: "test-access-1", authType: "bearer" as const };

async function callTool(guard: WriteGuard, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const server = new McpServer({ name: "skylight", version: "t" });
  registerTools(server, { hasPlus: true, photos: false, writeGuard: guard });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const req = new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(req));
  const json = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  return { isError: json.result.isError === true, text: json.result.content.map((c) => c.text).join("\n") };
}

describe("write guard in the tool registry", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { id: "9", type: "list", attributes: { label: "x" } } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("refuses a change over the limit without touching Skylight", async () => {
    const fetchMock = stub();
    const guard = new WriteGuard({ windowMs: 60_000, maxWrites: 2, maxDestructive: 1 });
    const args = { label: "List", kind: "to_do" };
    expect((await callTool(guard, "create_list", args)).isError).toBe(false);
    expect((await callTool(guard, "create_list", args)).isError).toBe(false);
    const callsBefore = fetchMock.mock.calls.length;
    const third = await callTool(guard, "create_list", args);
    expect(third.isError).toBe(true);
    expect(third.text).toMatch(/Nothing was changed/);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it("never limits reads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const guard = new WriteGuard({ windowMs: 60_000, maxWrites: 1, maxDestructive: 1 });
    for (let i = 0; i < 5; i++) {
      const out = await callTool(guard, "get_lists", {});
      expect(out.text).not.toMatch(/Nothing was changed/);
      expect(out.isError, out.text).toBe(false);
    }
  });

  it("logs the tool, effect and outcome, and nothing the caller sent", async () => {
    stub();
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    const guard = new WriteGuard({ windowMs: 60_000, maxWrites: 1, maxDestructive: 1 });
    await callTool(guard, "create_list", { label: "SECRET-LIST-NAME", kind: "to_do" });
    await callTool(guard, "create_list", { label: "SECRET-LIST-NAME", kind: "to_do" });
    vi.restoreAllMocks();
    const changes = lines.filter((l) => l.includes("skylight_change")).map((l) => JSON.parse(l.slice(l.indexOf("{"))));
    expect(changes.map((c) => c.outcome)).toEqual(["ok", "refused"]);
    expect(changes[0]).toMatchObject({ tool: "create_list", effect: "write" });
    expect(lines.join("\n")).not.toContain("SECRET-LIST-NAME");
  });
});
