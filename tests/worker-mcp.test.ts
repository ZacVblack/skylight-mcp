import { afterEach, describe, expect, it, vi } from "vitest";
import { HOSTED_EFFECTS, handleMcpRequest } from "../src/worker/mcp.js";
import type { SkylightProps } from "../src/worker/props.js";
import { accessTokenTtlSeconds, isSkylightProps, toCredential, withCredential } from "../src/worker/props.js";

const props: SkylightProps = {
  accessToken: "test-access-1",
  refreshToken: "test-refresh-1",
  fingerprint: "fp",
  expiresAt: Date.now() + 3_600_000,
  frameId: "frame-1",
  timezone: "America/Los_Angeles",
  hasPlus: true,
};

function rpc(body: unknown): Request {
  return new Request("https://worker.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("hosted MCP handler", () => {
  it("lists read/write tools plus only the allowlisted delete, no photos", async () => {
    const res = await handleMcpRequest(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }), props, "test");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { tools: Array<{ name: string; annotations?: Record<string, boolean> }> } };
    const names = json.result.tools.map((t) => t.name);
    expect(names).toContain("get_calendar_events");
    expect(names).toContain("create_calendar_event");
    // Only the deliberately allowlisted deletes are on the hosted server (preview-first, confirm: true).
    expect(names.filter((n) => n.startsWith("delete_")).sort()).toEqual(
      ["delete_calendar_event", "delete_chore", "delete_list", "delete_list_item", "delete_meal_sitting", "delete_message", "delete_recipe", "delete_reward"]
    );
    expect(names).not.toContain("delete_source_calendar");
    expect(names).not.toContain("get_albums");
    const get = json.result.tools.find((t) => t.name === "get_calendar_events")!;
    expect(get.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("calls Skylight with the grant's bearer token and frame id", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), auth: (init.headers as Record<string, string>).Authorization ?? null });
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      })
    );
    const res = await handleMcpRequest(
      rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_calendar_events", arguments: { date: "2026-10-30" } } }),
      props,
      "test"
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(json.result.isError).toBeFalsy();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(new URL(c.url).origin).toBe("https://app.ourskylight.com");
      expect(c.url).toContain("/frames/frame-1/");
      expect(c.auth).toBe("Bearer test-access-1");
    }
  });

  it("isolates concurrent requests for different grants", async () => {
    const seen = new Set<string>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.add(`${new URL(String(url)).pathname}|${(init.headers as Record<string, string>).Authorization}`);
        await new Promise((r) => setTimeout(r, 5));
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      })
    );
    const other: SkylightProps = { ...props, accessToken: "test-access-2", frameId: "frame-2" };
    const call = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_calendar_events", arguments: {} } };
    await Promise.all([handleMcpRequest(rpc(call), props, "t"), handleMcpRequest(rpc(call), other, "t")]);
    const pairs = [...seen];
    expect(pairs.some((p) => p.includes("frame-1") && p.endsWith("Bearer test-access-1"))).toBe(true);
    expect(pairs.some((p) => p.includes("frame-2") && p.endsWith("Bearer test-access-2"))).toBe(true);
    expect(pairs.some((p) => p.includes("frame-1") && p.endsWith("Bearer test-access-2"))).toBe(false);
    expect(pairs.some((p) => p.includes("frame-2") && p.endsWith("Bearer test-access-1"))).toBe(false);
  });

  it("HOSTED_EFFECTS never includes destructive", () => {
    expect(HOSTED_EFFECTS).not.toContain("destructive");
  });
});

describe("props helpers", () => {
  it("round-trips through a credential", () => {
    const cred = toCredential(props);
    expect(withCredential({ ...props, accessToken: "x" }, cred)).toEqual(props);
  });
  it("access token TTL expires before Skylight's token, floor 60s", () => {
    expect(accessTokenTtlSeconds(props, props.expiresAt - 3_600_000)).toBe(3600 - 300);
    expect(accessTokenTtlSeconds(props, props.expiresAt)).toBe(60);
  });
  it("validates props shape", () => {
    expect(isSkylightProps(props)).toBe(true);
    expect(isSkylightProps({ ...props, hasPlus: "yes" })).toBe(false);
    expect(isSkylightProps(null)).toBe(false);
  });
});
