import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { runWithContext } from "../src/context.js";
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

function rpc(name: string, args: Record<string, unknown>): Request {
  return new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
}

/** Hosted profile: read + write only. */
const hosted = (name: string, args: Record<string, unknown>) => handleMcpRequest(rpc(name, args), props, "t");

/** Local profile: every effect, so destructive tools are reachable. */
async function local(name: string, args: Record<string, unknown>): Promise<Response> {
  const config = { frameId: props.frameId, timezone: props.timezone, token: props.accessToken, authType: "bearer" as const };
  const server = new McpServer({ name: "skylight", version: "t" });
  registerTools(server, { hasPlus: true, photos: false });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(rpc(name, args)));
}

async function read(res: Response): Promise<{ text: string; isError: boolean }> {
  const json = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: json.result.content.map((c) => c.text).join("\n"), isError: json.result.isError === true };
}

const oneOff = {
  id: "5001",
  type: "meal_sitting",
  attributes: { summary: "Thai green curry", description: "", note: "", rrule: null, draft: false, recurring: false, instances: ["2026-11-03"] },
  relationships: {
    meal_category: { data: { id: "12", type: "meal_category" } },
    meal_recipe: { data: { id: "r9", type: "meal_recipe" } },
    profiles: { data: [{ id: "p1", type: "profile" }] },
  },
};
const repeating = { ...oneOff, id: "5002", attributes: { ...oneOff.attributes, recurring: true, rrule: "FREQ=WEEKLY" } };

interface Seen {
  url: string;
  method: string;
  body: unknown;
  version: string | null;
}

function stub(sittings: unknown[], mutationResponse: unknown = { data: [], meta: {} }): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      const method = init.method ?? "GET";
      seen.push({
        url: String(url),
        method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        version: headers.get("Skylight-Api-Version"),
      });
      const payload = method === "GET" ? { data: sittings } : mutationResponse;
      return new Response(JSON.stringify(payload), { status: 200 });
    })
  );
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("update_meal_sitting", () => {
  it("sends the whole form to the instance path under the web app's API version", async () => {
    const seen = stub([oneOff]);
    const out = await read(await hosted("update_meal_sitting", { sittingId: "5001", date: "2026-11-03", summary: "Thai green curry v2" }));
    expect(out.isError).toBe(false);
    const patch = seen.find((s) => s.method === "PATCH")!;
    expect(new URL(patch.url).pathname).toBe("/api/frames/frame-1/meals/sittings/5001/instances/2026-11-03");
    expect(patch.body).toEqual({
      date: "2026-11-03",
      note: "",
      rrule: null,
      summary: "Thai green curry v2",
      description: "",
      meal_category_id: "12",
      meal_recipe_id: "r9",
      profile_ids: ["p1"],
      saveToRecipeBox: false,
    });
    // Every request in the flow carries the version the captures were made with.
    expect(seen.every((s) => s.version === "2026-10-15")).toBe(true);
  });

  it("a date move keeps the OLD date in the path and puts the new date in the body", async () => {
    const seen = stub([oneOff]);
    await read(await hosted("update_meal_sitting", { sittingId: "5001", date: "2026-11-03", newDate: "2026-11-04" }));
    const patch = seen.find((s) => s.method === "PATCH")!;
    expect(new URL(patch.url).pathname.endsWith("/instances/2026-11-03")).toBe(true);
    expect((patch.body as { date: string; summary: string }).date).toBe("2026-11-04");
    expect((patch.body as { summary: string }).summary).toBe("Thai green curry");
  });

  it("refuses a repeating meal and writes nothing", async () => {
    const seen = stub([repeating]);
    const out = await read(await hosted("update_meal_sitting", { sittingId: "5002", date: "2026-11-03", summary: "x" }));
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/repeats/i);
    expect(seen.some((s) => s.method !== "GET")).toBe(false);
  });

  it("an unknown sitting or date writes nothing", async () => {
    const seen = stub([oneOff]);
    const wrongDate = await read(await hosted("update_meal_sitting", { sittingId: "5001", date: "2026-11-09", summary: "x" }));
    const wrongId = await read(await hosted("update_meal_sitting", { sittingId: "9999", date: "2026-11-03", summary: "x" }));
    expect(wrongDate.isError && wrongId.isError).toBe(true);
    expect(seen.some((s) => s.method !== "GET")).toBe(false);
  });

  it("ids and dates cannot steer the URL path", async () => {
    const seen = stub([oneOff]);
    const badId = await read(await hosted("update_meal_sitting", { sittingId: "5001/../../chores", date: "2026-11-03", summary: "x" }));
    const badDate = await read(await hosted("update_meal_sitting", { sittingId: "5001", date: "2026-11-03", newDate: "2026-13-45", summary: "x" }));
    expect(badId.isError && badDate.isError).toBe(true);
    expect(seen.some((s) => s.method !== "GET")).toBe(false);
    expect(seen.every((s) => new URL(s.url).host === "app.ourskylight.com")).toBe(true);
  });

  it("refuses an empty change", async () => {
    const seen = stub([oneOff]);
    const out = await read(await hosted("update_meal_sitting", { sittingId: "5001", date: "2026-11-03" }));
    expect(out.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });
});

describe("delete_meal_sitting", () => {
  it("is not available on the hosted profile", async () => {
    const res = await hosted("delete_meal_sitting", { sittingId: "5001", date: "2026-11-03", confirm: true });
    const text = JSON.stringify(await res.json());
    expect(text).toMatch(/not found|unknown|disabled|error/i);
  });

  it("without confirm it previews and does not delete", async () => {
    const seen = stub([oneOff]);
    const out = await read(await local("delete_meal_sitting", { sittingId: "5001", date: "2026-11-03" }));
    expect(out.text).toContain("NOT DELETED");
    expect(out.text).toContain("Thai green curry");
    expect(seen.some((s) => s.method === "DELETE")).toBe(false);
  });

  it("with confirm it sends a bodyless DELETE to the instance path and reports the confirmed removal", async () => {
    const seen = stub([oneOff], { data: [], meta: { deleted_sitting_ids: [5001] } });
    const out = await read(await local("delete_meal_sitting", { sittingId: "5001", date: "2026-11-03", confirm: true }));
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Deleted");
    const del = seen.find((s) => s.method === "DELETE")!;
    expect(new URL(del.url).pathname).toBe("/api/frames/frame-1/meals/sittings/5001/instances/2026-11-03");
    expect(del.body).toBeUndefined();
    expect(del.version).toBe("2026-10-15");
  });

  it("does not claim success when Skylight does not confirm the removal", async () => {
    stub([oneOff], { data: [], meta: { deleted_sitting_ids: [] } });
    const out = await read(await local("delete_meal_sitting", { sittingId: "5001", date: "2026-11-03", confirm: true }));
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/did not confirm/i);
  });

});

// Shapes below come from the 2026-11-01 captures of the Skylight web app.
const MONDAY_RULE = "FREQ=WEEKLY;INTERVAL=1;WKST=SU;BYDAY=MO";
const series = {
  ...oneOff,
  id: "5002",
  attributes: { ...oneOff.attributes, summary: "Taco night", recurring: true, rrule: MONDAY_RULE, instances: ["2026-12-14"] },
};
/** An occurrence edited on its own: no rrule, but still reports recurring. */
const detached = {
  ...oneOff,
  id: "5003",
  attributes: { ...oneOff.attributes, summary: "Taco night", recurring: true, rrule: null, instances: ["2026-12-14"] },
};
const seriesAfter = (extra: Record<string, unknown>) => ({
  data: [{ ...series, attributes: { ...series.attributes, ...extra } }],
  meta: { deleted_sitting_ids: [] },
});
const applyTo = (url: string) => new URL(url).searchParams.get("apply_to");

describe("delete_meal_sitting on a repeating meal", () => {
  it("defaults to this occurrence only (apply_to=one) and confirms via the series losing the date", async () => {
    const seen = stub([series], seriesAfter({ instances: [] }));
    const out = await read(await local("delete_meal_sitting", { sittingId: "5002", date: "2026-12-14", confirm: true }));
    expect(out.isError).toBe(false);
    const del = seen.find((s) => s.method === "DELETE")!;
    expect(new URL(del.url).pathname).toBe("/api/frames/frame-1/meals/sittings/5002/instances/2026-12-14");
    expect(applyTo(del.url)).toBe("one");
    expect(del.body).toBeUndefined();
    expect(out.text).toMatch(/occurrence/);
  });

  it("scope future sends apply_to=future and keeps the series", async () => {
    const seen = stub([series], seriesAfter({ rrule: `${MONDAY_RULE};UNTIL=20261207`, instances: [] }));
    const out = await read(await local("delete_meal_sitting", { sittingId: "5002", date: "2026-12-14", scope: "future", confirm: true }));
    expect(out.isError).toBe(false);
    expect(applyTo(seen.find((s) => s.method === "DELETE")!.url)).toBe("future");
    expect(out.text).toMatch(/onward/);
  });

  it("scope all sends apply_to=all and confirms only through deleted_sitting_ids", async () => {
    const seen = stub([series], { data: [], meta: { deleted_sitting_ids: [5002] } });
    const out = await read(await local("delete_meal_sitting", { sittingId: "5002", date: "2026-12-14", scope: "all", confirm: true }));
    expect(out.isError).toBe(false);
    expect(applyTo(seen.find((s) => s.method === "DELETE")!.url)).toBe("all");
    expect(out.text).toMatch(/whole series/);
  });

  it("scope all is not reported as done when the series is not confirmed deleted", async () => {
    stub([series], { data: [], meta: { deleted_sitting_ids: [] } });
    const out = await read(await local("delete_meal_sitting", { sittingId: "5002", date: "2026-12-14", scope: "all", confirm: true }));
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/did not confirm/i);
  });

  it("one is not reported as done when the date is still in the series", async () => {
    stub([series], seriesAfter({ instances: ["2026-12-14"] }));
    const out = await read(await local("delete_meal_sitting", { sittingId: "5002", date: "2026-12-14", confirm: true }));
    expect(out.isError).toBe(true);
  });

  it("previews every scope without deleting, and the all preview names the whole series", async () => {
    const seen = stub([series]);
    const one = await read(await local("delete_meal_sitting", { sittingId: "5002", date: "2026-12-14" }));
    const future = await read(await local("delete_meal_sitting", { sittingId: "5002", date: "2026-12-14", scope: "future" }));
    const all = await read(await local("delete_meal_sitting", { sittingId: "5002", date: "2026-12-14", scope: "all" }));
    expect(seen.some((s) => s.method === "DELETE")).toBe(false);
    expect(one.text).toMatch(/only the .*occurrence.*series continues/);
    expect(future.text).toMatch(/every later occurrence/);
    expect(all.text).toMatch(/ENTIRE repeating series/);
    expect(all.text).toContain("NOT DELETED");
  });

  it("a one-off never sends apply_to, whatever scope is asked for", async () => {
    const seen = stub([oneOff], { data: [], meta: { deleted_sitting_ids: [5001] } });
    await read(await local("delete_meal_sitting", { sittingId: "5001", date: "2026-11-03", scope: "all", confirm: true }));
    expect(applyTo(seen.find((s) => s.method === "DELETE")!.url)).toBeNull();
  });

  it("refuses a detached occurrence, even with confirm, and deletes nothing", async () => {
    const seen = stub([detached]);
    const out = await read(await local("delete_meal_sitting", { sittingId: "5003", date: "2026-12-14", scope: "all", confirm: true }));
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/detached/i);
    expect(seen.some((s) => s.method === "DELETE")).toBe(false);
  });

  it("a scope outside one|future|all is rejected before any request is sent", async () => {
    const seen = stub([series]);
    await local("delete_meal_sitting", { sittingId: "5002", date: "2026-12-14", scope: "../all", confirm: true });
    expect(seen.some((s) => s.method === "DELETE")).toBe(false);
  });

  it("the token only goes to the pinned host", async () => {
    const seen = stub([series], seriesAfter({ instances: [] }));
    await local("delete_meal_sitting", { sittingId: "5002", date: "2026-12-14", confirm: true });
    expect(seen.every((s) => new URL(s.url).host === "app.ourskylight.com")).toBe(true);
  });
});

describe("update_meal_sitting on detached occurrences", () => {
  it("is refused like a series, and writes nothing", async () => {
    const seen = stub([detached]);
    const out = await read(await hosted("update_meal_sitting", { sittingId: "5003", date: "2026-12-14", summary: "x" }));
    expect(out.isError).toBe(true);
    expect(seen.some((s) => s.method !== "GET")).toBe(false);
  });
});

describe("create_meal_sitting with repeat", () => {
  const created = { data: [{ ...series, id: "6001" }] };

  it("sends the web app's whole form with a weekly rule on the date's weekday", async () => {
    const seen = stub([], created);
    const out = await read(
      await hosted("create_meal_sitting", { date: "2026-12-14", mealCategoryId: "12", summary: "Taco night", repeat: "weekly" })
    );
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/repeating weekly/);
    const post = seen.find((s) => s.method === "POST")!;
    expect(new URL(post.url).pathname).toBe("/api/frames/frame-1/meals/sittings");
    expect(post.body).toEqual({
      date: "2026-12-14",
      summary: "Taco night",
      description: "",
      note: "",
      meal_category_id: "12",
      meal_recipe_id: null,
      profile_ids: [],
      rrule: MONDAY_RULE,
      add_to_grocery_list: false,
      saveToRecipeBox: false,
    });
  });

  it("derives the weekday from the date, not the time zone of the caller", async () => {
    const seen = stub([], created);
    await read(await hosted("create_meal_sitting", { date: "2026-12-16", mealCategoryId: "12", summary: "x", repeat: "weekly" }));
    expect((seen.find((s) => s.method === "POST")!.body as { rrule: string }).rrule).toBe("FREQ=WEEKLY;INTERVAL=1;WKST=SU;BYDAY=WE");
  });

  it("without repeat the body carries no rrule", async () => {
    const seen = stub([], { data: [oneOff] });
    await read(await hosted("create_meal_sitting", { date: "2026-11-03", mealCategoryId: "12", summary: "x" }));
    expect(JSON.stringify(seen.find((s) => s.method === "POST")!.body)).not.toContain("rrule");
  });

  it("only weekly is accepted", async () => {
    const seen = stub([], created);
    await read(await hosted("create_meal_sitting", { date: "2026-12-14", mealCategoryId: "12", summary: "x", repeat: "daily" }));
    expect(seen.some((s) => s.method === "POST")).toBe(false);
  });
});
