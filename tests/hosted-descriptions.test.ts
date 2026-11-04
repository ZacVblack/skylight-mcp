import { describe, expect, it } from "vitest";
import { HOSTED_DESTRUCTIVE_ALLOWLIST, HOSTED_EFFECTS, handleMcpRequest } from "../src/worker/mcp.js";
import type { SkylightProps } from "../src/worker/props.js";
import { TOOL_EFFECTS } from "../src/tools/registry.js";

const props: SkylightProps = {
  accessToken: "test-access-1",
  refreshToken: "test-refresh-1",
  fingerprint: "fp",
  expiresAt: Date.now() + 3_600_000,
  frameId: "frame-1",
  timezone: "America/Los_Angeles",
  hasPlus: true,
};

async function hostedTools(): Promise<Array<{ name: string; description?: string }>> {
  const res = await handleMcpRequest(
    new Request("https://worker.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    props,
    "test"
  );
  const json = (await res.json()) as { result: { tools: Array<{ name: string; description?: string }> } };
  return json.result.tools;
}

describe("hosted tool descriptions", () => {
  it("never name a tool the hosted server does not expose", async () => {
    const tools = await hostedTools();
    const exposed = new Set(tools.map((t) => t.name));
    // Sanity: the hosted set is what the effect rules say it is.
    expect(HOSTED_EFFECTS).toEqual(["read", "write"]);
    expect(HOSTED_DESTRUCTIVE_ALLOWLIST.every((n) => exposed.has(n))).toBe(true);

    const hidden = Object.keys(TOOL_EFFECTS).filter((n) => !exposed.has(n));
    expect(hidden.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const tool of tools) {
      for (const name of hidden) {
        if (new RegExp(`\\b${name}\\b`).test(tool.description ?? "")) offenders.push(`${tool.name} -> ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("local tool descriptions", () => {
  it("still name all three feed-management tools when everything is registered", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { registerTools } = await import("../src/tools/registry.js");
    const server = new McpServer({ name: "t", version: "0" });
    const descriptions: Record<string, string> = {};
    const original = server.tool.bind(server) as (...a: unknown[]) => unknown;
    (server as unknown as { tool: (...a: unknown[]) => unknown }).tool = (name: unknown, ...rest: unknown[]) => {
      if (typeof rest[0] === "string") descriptions[String(name)] = rest[0];
      return original(name, ...rest);
    };
    registerTools(server, { hasPlus: true });
    expect(descriptions.get_source_calendars).toContain("rename_source_calendar, update_source_calendar_profiles and delete_source_calendar manage it");
  });
});
