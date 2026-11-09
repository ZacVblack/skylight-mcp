import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";
import { HOSTED_DESTRUCTIVE_ALLOWLIST, HOSTED_EFFECTS } from "../src/worker/mcp.js";

const config = { frameId: "frame-1", timezone: "UTC", token: "test-access-1", authType: "bearer" as const };

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const server = new McpServer({ name: "skylight", version: "t" });
  // Exactly what the hosted server registers.
  registerTools(server, { hasPlus: true, effects: HOSTED_EFFECTS, include: HOSTED_DESTRUCTIVE_ALLOWLIST, photos: false });
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

const item = (id: string, summary: string, routine = false) => ({ id, type: "task_box_item", attributes: { id: Number(id), summary, emoji_icon: null, routine, reward_points: null } });

interface Seen { url: string; method: string }

/** `stays` keeps the item in the list after the DELETE, to prove the read-back catches a delete that did nothing. */
function stub(opts: { stays?: boolean; sameName?: boolean } = {}): Seen[] {
  const seen: Seen[] = [];
  let deleted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      seen.push({ url: u, method });
      if (method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      if (u.includes("/task_box/items")) {
        const all = [item("60458647", "TEST chore"), item("60458001", "Laundry")];
        return new Response(JSON.stringify({ data: deleted && !opts.stays ? all.slice(1) : all }), { status: 200 });
      }
      if (u.includes("/chores")) {
        const data = opts.sameName ? [{ id: "900", type: "chore", attributes: { summary: "TEST chore", start: "2026-11-09", status: "pending" } }] : [];
        return new Response(JSON.stringify({ data, included: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    })
  );
  return seen;
}

const deletes = (seen: Seen[]) => seen.filter((s) => s.method === "DELETE");

afterEach(() => vi.unstubAllGlobals());

describe("delete_task_box_item", () => {
  it("is on the hosted server and previews without sending a DELETE", async () => {
    const seen = stub();
    const r = await call("delete_task_box_item", { itemId: "60458647" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Preview only");
    expect(r.text).toContain("TEST chore");
    expect(deletes(seen)).toEqual([]);
  });

  it("sends exactly one DELETE to the captured path with confirm, and reads it back", async () => {
    const seen = stub();
    const r = await call("delete_task_box_item", { itemId: "60458647", confirm: true });
    expect(r.isError).toBe(false);
    expect(deletes(seen)).toHaveLength(1);
    expect(deletes(seen)[0].url).toMatch(/\/frames\/frame-1\/task_box\/items\/60458647$/);
    expect(r.text).toContain("no longer in the Task Box");
  });

  it("deletes by id only: a same-named scheduled chore is reported as unverified and never deleted", async () => {
    const seen = stub({ sameName: true });
    const r = await call("delete_task_box_item", { itemId: "60458647" });
    expect(r.text).toContain("link unverified");
    expect(r.text).toContain("would stay");
    await call("delete_task_box_item", { itemId: "60458647", confirm: true });
    expect(deletes(seen).every((d) => d.url.includes("/task_box/items/"))).toBe(true);
  });

  it("refuses an unknown id and sends nothing", async () => {
    const seen = stub();
    const r = await call("delete_task_box_item", { itemId: "999", confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No Task Box item with ID 999");
    expect(deletes(seen)).toEqual([]);
  });

  it("reports an error when the read-back still shows the item", async () => {
    stub({ stays: true });
    const r = await call("delete_task_box_item", { itemId: "60458647", confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("still lists");
  });
});

describe("get_task_box", () => {
  it("shows IDs so a template can be deleted by id", async () => {
    stub();
    const r = await call("get_task_box", {});
    expect(r.text).toContain("TEST chore (ID: 60458647)");
  });
});
