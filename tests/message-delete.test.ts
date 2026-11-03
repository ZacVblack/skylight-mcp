import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { runWithContext } from "../src/context.js";
import { assertNudgeId } from "../src/api/endpoints/messages.js";
import { registerTools } from "../src/tools/registry.js";
import { handleMcpRequest } from "../src/worker/mcp.js";
import type { SkylightProps } from "../src/worker/props.js";

const props: SkylightProps = {
  accessToken: "test-access-1",
  refreshToken: "test-refresh-1",
  fingerprint: "fp",
  expiresAt: Date.now() + 3_600_000,
  frameId: "frame-1",
  timezone: "UTC",
  hasPlus: true,
};

function rpc(method: string, params: Record<string, unknown>): Request {
  return new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function local(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const config = { frameId: props.frameId, timezone: props.timezone, token: props.accessToken, authType: "bearer" as const };
  const server = new McpServer({ name: "skylight", version: "t" });
  registerTools(server, { hasPlus: true, photos: false });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const res = await runWithContext({ client: new SkylightClient(config, null), config }, () =>
    transport.handleRequest(rpc("tools/call", { name, arguments: args }))
  );
  const json = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: json.result.content.map((c) => c.text).join("\n"), isError: json.result.isError === true };
}

const message = (id: string) => ({
  id,
  type: "nudge",
  attributes: { body: "Please ignore", deliver_at: new Date().toISOString(), all_profiles: true, all_devices: true, recurring: false },
});

/** `stillThere` controls whether the message is still listed after the DELETE. */
function stub(stillThere: boolean) {
  const seen: Array<{ url: string; method: string; version: string | null }> = [];
  let deleted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      seen.push({ url: String(url), method, version: new Headers(init.headers).get("Skylight-Api-Version") });
      if (method === "DELETE") deleted = true;
      const listed = !deleted || stillThere;
      return new Response(JSON.stringify({ data: listed ? [message("76667")] : [] }), { status: 200 });
    })
  );
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("delete_message", () => {
  it("previews without deleting anything when not confirmed", async () => {
    const seen = stub(false);
    const out = await local("delete_message", { messageId: "76667" });
    expect(out.text).toContain("NOT DELETED");
    expect(out.text).toContain("Please ignore");
    expect(seen.some((s) => s.method === "DELETE")).toBe(false);
  });

  it("sends a bodyless DELETE to the pinned host under the nudges API version, then reads back", async () => {
    const seen = stub(false);
    const out = await local("delete_message", { messageId: "76667", confirm: true });
    const del = seen.find((s) => s.method === "DELETE")!;
    expect(del.url).toBe("https://app.ourskylight.com/api/frames/frame-1/nudges/76667");
    expect(del.version).toBe("2026-10-15");
    expect(seen.at(-1)!.method).toBe("GET");
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Confirmed gone");
  });

  it("treats an empty DELETE response body as success of the call, then verifies by read-back", async () => {
    let deleted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit = {}) => {
        if (init.method === "DELETE") {
          deleted = true;
          return new Response(null, { status: 204 });
        }
        return new Response(JSON.stringify({ data: deleted ? [] : [message("76667")] }), { status: 200 });
      })
    );
    const out = await local("delete_message", { messageId: "76667", confirm: true });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Confirmed gone");
  });

  it("does not report success when the message is still listed afterwards", async () => {
    stub(true);
    const out = await local("delete_message", { messageId: "76667", confirm: true });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("still listed");
  });

  it("refuses an id that is not on the frame without deleting", async () => {
    const seen = stub(false);
    const out = await local("delete_message", { messageId: "999", confirm: true });
    expect(out.isError).toBe(true);
    expect(seen.some((s) => s.method === "DELETE")).toBe(false);
  });

  it("cannot be steered by a hostile id", () => {
    expect(() => assertNudgeId("../devices/9")).toThrow();
    expect(() => assertNudgeId("76667/../x")).toThrow();
  });

  it("is offered on the hosted server, with only the allowlisted destructive tools", async () => {
    const res = await handleMcpRequest(rpc("tools/list", {}), props, "t");
    const tools = ((await res.json()) as { result: { tools: Array<{ name: string; annotations?: { destructiveHint?: boolean } }> } }).result.tools;
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name);
    expect(destructive).toContain("delete_message");
    expect(destructive).toContain("delete_calendar_event");
    expect(destructive).not.toContain("delete_source_calendar");
    expect(tools.map((t) => t.name)).toContain("send_message");
  });

  it("works through the hosted server: bodyless DELETE to the pinned host, read back", async () => {
    const seen = stub(false);
    const res = await handleMcpRequest(rpc("tools/call", { name: "delete_message", arguments: { messageId: "76667", confirm: true } }), props, "t");
    const json = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(json.result.isError).not.toBe(true);
    expect(seen.find((s) => s.method === "DELETE")!.url).toBe("https://app.ourskylight.com/api/frames/frame-1/nudges/76667");
    expect(json.result.content[0]!.text).toContain("Confirmed gone");
  });
});
