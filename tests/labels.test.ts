import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { clearCategoriesCache, labelDeleteRefusal } from "../src/api/endpoints/categories.js";
import { readBackPolicy } from "../src/api/endpoints/source-calendars.js";
import { runWithContext } from "../src/context.js";
import { registerTools, selectedTools } from "../src/tools/registry.js";
import { HOSTED_DESTRUCTIVE_ALLOWLIST, HOSTED_EFFECTS } from "../src/worker/mcp.js";

const config = { frameId: "frame-1", timezone: "UTC", token: "test-access-1", authType: "bearer" as const };

async function call(name: string, args: Record<string, unknown>, hosted = false): Promise<{ text: string; isError: boolean }> {
  const server = new McpServer({ name: "skylight", version: "t" });
  if (hosted) registerTools(server, { hasPlus: true, effects: HOSTED_EFFECTS, include: HOSTED_DESTRUCTIVE_ALLOWLIST, photos: false });
  else registerTools(server, { hasPlus: true });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const req = new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(req));
  const json = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean }; error?: { message: string } };
  if (json.error) return { text: json.error.message, isError: true };
  return { text: json.result.content.map((c) => c.text).join("\n"), isError: Boolean(json.result.isError) };
}

// Shapes from the 2026-11-03 capture of the web app's categories list (ids and names are placeholders).
function cat(id: string, label: string, over: { profile?: boolean; feeds?: string[] } = {}) {
  return {
    id,
    type: "category_detail",
    attributes: { id: Number(id), label, color: "#000000", selected_for_chore_chart: Boolean(over.profile), linked_to_profile: Boolean(over.profile) },
    relationships: { source_calendars: { data: (over.feeds ?? []).map((f) => ({ id: f, type: "source_calendar" })) } },
  };
}
const DEAD = cat("401", "OLD TEAM BLUE");
const DEAD2 = cat("402", "7th Grade");
const USED = cat("404", "Spring League");
const FEED = cat("403", "Team Schedule", { feeds: ["9001"] });
const PROFILE = cat("301", "Alex", { profile: true });
const PROFILE2 = cat("302", "Sam", { profile: true });

function event(id: string, ...categoryIds: string[]) {
  return {
    id,
    type: "calendar_event",
    attributes: { summary: `E${id}`, starts_at: "2026-11-12T18:00:00.000Z", ends_at: "2026-11-12T19:00:00.000Z", all_day: false, source: "google" },
    relationships: { categories: { data: categoryIds.map((c) => ({ id: c, type: "category" })) } },
  };
}

/** Fake Skylight: categories and events; DELETE on a category removes it after `lagReads` more reads. */
function stub(opts: { lagReads?: number; deleteStatus?: number; neverGone?: boolean } = {}) {
  let cats = [DEAD, DEAD2, FEED, USED, PROFILE, PROFILE2];
  const events = [event("e1", "403", "301"), event("e2", "403"), event("e3", "302"), event("e4", "404"), event("e5", "404", "301")];
  let pending: string | null = null;
  let lag = 0;
  const deletes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "DELETE") {
        deletes.push(u);
        if (opts.deleteStatus && opts.deleteStatus >= 400) return new Response("{}", { status: opts.deleteStatus });
        pending = u.split("/").pop()!;
        lag = opts.lagReads ?? 0;
        if (lag === 0 && !opts.neverGone) cats = cats.filter((c) => c.id !== pending);
        return new Response(null, { status: 204 });
      }
      if (u.includes("/categories")) {
        const out = JSON.stringify({ data: cats });
        if (pending && lag > 0 && --lag === 0 && !opts.neverGone) cats = cats.filter((c) => c.id !== pending);
        return new Response(out, { status: 200 });
      }
      if (u.includes("/calendar_events")) return new Response(JSON.stringify({ data: events }), { status: 200 });
      return new Response("{}", { status: 200 });
    })
  );
  return { deletes };
}

beforeEach(() => {
  readBackPolicy.delayMs = 0;
  clearCategoriesCache();
});
afterEach(() => vi.unstubAllGlobals());

describe("labelDeleteRefusal: the guards", () => {
  it("refuses a profile and a feed-backed label, allows a dead label", () => {
    expect(labelDeleteRefusal(PROFILE as never)).toContain("profile");
    expect(labelDeleteRefusal(FEED as never)).toContain("synced calendar");
    expect(labelDeleteRefusal(DEAD as never)).toBeNull();
  });
});

describe("get_labels", () => {
  it("lists labels only, with upcoming counts and feed marks, never profiles", async () => {
    stub();
    const out = await call("get_labels", {});
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Team Schedule [label ID: 403]: 2 upcoming events in the next 365 days, written to by 1 synced calendar");
    expect(out.text).toContain("OLD TEAM BLUE [label ID: 401]: 0 upcoming events");
    expect(out.text).not.toContain("Alex");
    expect(out.text).not.toContain("Sam");
  });
});

describe("delete_label", () => {
  it("preview sends no DELETE and says no event would be removed for a dead label", async () => {
    const { deletes } = stub();
    const out = await call("delete_label", { labelId: "401" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Preview only, nothing deleted");
    expect(out.text).toContain("OLD TEAM BLUE");
    expect(out.text).toContain("no event would be removed");
    expect(out.text).not.toContain("REMOVED from Skylight");
    expect(deletes).toEqual([]);
  });

  it("preview lists the events that carry only this label as removed, and counts shared ones as staying", async () => {
    const { deletes } = stub();
    const out = await call("delete_label", { labelId: "404" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("1 upcoming event carries only this label and would be REMOVED from Skylight");
    expect(out.text).toContain("Ee4 [event ID: e4]");
    expect(out.text).not.toContain("[event ID: e5]");
    expect(out.text).toContain("1 upcoming event also has a profile or another label; it stays and loses this label");
    expect(deletes).toEqual([]);
  });

  it("the confirmed reply says how many events went with the label", async () => {
    stub();
    const out = await call("delete_label", { labelId: "404", confirm: true });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("and with it 1 upcoming event that carried only this label");
  });

  it("confirm sends exactly one DELETE for that id and confirms by read-back", async () => {
    const { deletes } = stub();
    const out = await call("delete_label", { labelId: "401", confirm: true });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('Deleted label "OLD TEAM BLUE"');
    expect(deletes).toEqual(["https://app.ourskylight.com/api/frames/frame-1/categories/401"]);
  });

  it("tolerates the list lagging the delete", async () => {
    stub({ lagReads: 2 });
    const out = await call("delete_label", { labelId: "401", confirm: true });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Confirmed gone");
  });

  it("errors if the label never leaves the list after a 204", async () => {
    stub({ neverGone: true });
    const out = await call("delete_label", { labelId: "401", confirm: true });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("still shows");
  });

  it("the endpoint itself refuses a non-numeric id, independent of the tool schema", async () => {
    const { deleteCategory } = await import("../src/api/endpoints/categories.js");
    const { deletes } = stub();
    await expect(runWithContext({ client: new SkylightClient(config, null), config }, () => deleteCategory("401/../302"))).rejects.toThrow("numeric");
    expect(deletes).toEqual([]);
  });

  it("reports when Skylight rejects the delete", async () => {
    const { deletes } = stub({ deleteStatus: 405 });
    const out = await call("delete_label", { labelId: "401", confirm: true });
    expect(out.isError).toBe(true);
    expect(deletes).toHaveLength(1);
  });

  it.each([
    ["a profile", "301", "profile"],
    ["a feed-backed label", "403", "synced calendar"],
    ["an unknown id", "999", "No label with ID"],
  ])("refuses %s even with confirm, sending nothing", async (_what, id, reason) => {
    const { deletes } = stub();
    const out = await call("delete_label", { labelId: id, confirm: true });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(reason);
    expect(out.text).toContain("Nothing was deleted");
    expect(deletes).toEqual([]);
  });

  it("rejects a non-numeric id before any request", async () => {
    const { deletes } = stub();
    const out = await call("delete_label", { labelId: "../frames", confirm: true });
    expect(out.isError).toBe(true);
    expect(deletes).toEqual([]);
  });

  it("is local-only: not on the hosted server, while get_labels is", async () => {
    const hosted = selectedTools({ hasPlus: true, effects: HOSTED_EFFECTS, include: HOSTED_DESTRUCTIVE_ALLOWLIST, photos: false });
    expect(hosted).toContain("get_labels");
    expect(hosted).not.toContain("delete_label");
    stub();
    const out = await call("delete_label", { labelId: "401", confirm: true }, true);
    expect(out.isError).toBe(true);
  });
});
