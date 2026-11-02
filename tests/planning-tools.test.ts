import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../src/worker/mcp.js";
import type { SkylightProps } from "../src/worker/props.js";

const props: SkylightProps = {
  accessToken: "test-access-1",
  refreshToken: "test-refresh-1",
  fingerprint: "fp",
  expiresAt: Date.now() + 3_600_000,
  frameId: "frame-1",
  timezone: "America/Los_Angeles",
  hasPlus: true,
};

const events = {
  data: [
    { id: "e1", type: "calendar_event", attributes: { summary: "Robert bday", all_day: true, starts_at: "2026-11-05T00:00:00.000-08:00", ends_at: "2026-11-06T00:00:00.000-08:00", owner_email: "someone@example.com", calendar_id: "x@group.calendar.google.com" } },
    { id: "e2", type: "calendar_event", attributes: { summary: "Healdsburg", all_day: false, starts_at: "2026-11-05T16:00:00.000-08:00", ends_at: "2026-11-05T19:00:00.000-08:00" } },
    { id: "e3", type: "calendar_event", attributes: { summary: "Bball pics", all_day: false, starts_at: "2026-11-05T17:00:00.000-08:00", ends_at: "2026-11-05T19:00:00.000-08:00" } },
    { id: "e4", type: "calendar_event", attributes: { summary: "Tryouts", all_day: false, starts_at: "2026-11-03T15:30:00.000-08:00", ends_at: "2026-11-03T17:30:00.000-08:00" } },
  ],
};
const chores = {
  data: [
    { id: "c1", type: "chore", attributes: { summary: "Empty dishwasher", status: "pending", start: "2026-11-03", start_time: null, reward_points: 5 }, relationships: { category: { data: { type: "category", id: "k1" } } } },
    { id: "c2", type: "chore", attributes: { summary: "Trash out", status: "completed", start: "2026-11-03", start_time: "18:00" }, relationships: { category: { data: { type: "category", id: "k2" } } } },
    { id: "c3", type: "chore", attributes: { summary: "Clean room", status: "pending", start: "2026-10-30", start_time: null }, relationships: { category: { data: { type: "category", id: "k1" } } } },
  ],
  included: [
    { id: "k1", type: "category", attributes: { label: "Alex" } },
    { id: "k2", type: "category", attributes: { label: "Sam" } },
  ],
};
const categories = { data: [{ id: "12", type: "meal_category", attributes: { label: "Dinner" } }, { id: "10", type: "meal_category", attributes: { label: "Breakfast" } }] };
const sittings = { data: [{ id: "s1", type: "meal_sitting", attributes: { summary: "Thai green curry", instances: ["2026-11-03"] }, relationships: { meal_category: { data: { type: "meal_category", id: "12" } }, meal_recipe: { data: null } } }] };
const lists = { data: [{ id: "L1", type: "list", attributes: { label: "Groceries", kind: "shopping", default_grocery_list: true, color: null } }] };
const listItems = { data: lists.data[0], included: [
  { id: "i1", type: "list_item", attributes: { label: "Milk", status: "pending" } },
  { id: "i2", type: "list_item", attributes: { label: "Eggs", status: "completed" } },
] };

function route(url: string, init?: RequestInit): Response {
  const u = String(url);
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  if (u.includes("/calendar_events")) return json(events);
  if (u.includes("/chores")) return json(chores);
  if (u.includes("/meals/categories")) return json(categories);
  if (u.includes("/meals/sittings") && (init?.method ?? "GET") === "GET") return json(sittings);
  if (u.includes("/meals/sittings") && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return json({ data: [{ id: `new-${body.date}`, type: "meal_sitting", attributes: { summary: body.summary, instances: [body.date] } }] });
  }
  if (u.includes("/add_to_grocery_list")) return json({});
  if (u.match(/\/lists\/L1$/)) return json(listItems);
  if (u.includes("/lists")) return json(lists);
  if (u.includes("/plus_access")) return json({});
  return new Response("not found " + u, { status: 404 });
}

function call(name: string, args: Record<string, unknown>): Request {
  return new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
}
async function text(res: Response): Promise<{ text: string; isError?: boolean }> {
  const json = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: json.result.content.map((c) => c.text).join("\n"), isError: json.result.isError };
}

afterEach(() => vi.unstubAllGlobals());

describe("get_week_overview", () => {
  it("merges calendar, chores, meals, lists and conflicts, without emails or calendar ids", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return route(url, init); }));
    const { text: out, isError } = await text(await handleMcpRequest(call("get_week_overview", { date: "2026-11-02", days: 5 }), props, "t"));
    expect(isError).toBeFalsy();
    expect(out).toContain("Tue, Nov 3");
    expect(out).toContain("3:30 PM–5:30 PM: Tryouts");
    expect(out).toContain("chore [ ] Empty dishwasher (Alex), 5 pts [chore ID: c1]");
    expect(out).toContain("chore [x] Trash out (Sam) at 18:00");
    expect(out).toContain("dinner: Thai green curry");
    expect(out).toContain("all day: Robert bday");
    expect(out).toContain('"Healdsburg" and "Bball pics" overlap 5:00 PM–7:00 PM');
    expect(out).toContain("Overdue chores:");
    expect(out).toContain("Clean room (Alex)");
    expect(out).toContain("Groceries (shopping, default grocery): 1 pending: Milk");
    expect(out).not.toContain("example.com");
    expect(out).not.toContain("group.calendar.google.com");
    // one round trip per source, not one per day
    expect(calls.filter((c) => c.url.includes("/calendar_events"))).toHaveLength(1);
  });

  it("omits meals cleanly when the meals API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => (String(url).includes("/meals/") ? new Response("", { status: 403 }) : route(url, init))));
    const { text: out, isError } = await text(await handleMcpRequest(call("get_week_overview", { date: "2026-11-02", days: 2, includeLists: false }), props, "t"));
    expect(isError).toBeFalsy();
    expect(out).toContain("Meals: not available");
    expect(out).not.toContain("Lists:");
  });
});

describe("find_conflicts / find_free_slots", () => {
  it("reports the overlapping pair with event ids", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: RequestInit) => route(u, i)));
    const { text: out } = await text(await handleMcpRequest(call("find_conflicts", { date: "2026-11-02", dateEnd: "2026-11-08" }), props, "t"));
    expect(out).toContain("Thu, Nov 5");
    expect(out).toContain("[event IDs: e2, e3]");
  });

  it("finds free slots around tryouts within the window", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: RequestInit) => route(u, i)));
    const { text: out } = await text(await handleMcpRequest(call("find_free_slots", { date: "2026-11-03", days: 1, durationMinutes: 90, earliest: "09:00", latest: "20:00" }), props, "t"));
    expect(out).toContain("Tue, Nov 3: 9:00 AM–3:30 PM (6h 30m); 5:30 PM–8:00 PM (2h 30m)");
  });
});

describe("plan_week_meals", () => {
  it("dry run writes nothing and shows skips for filled slots", async () => {
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: RequestInit) => { if (i?.method === "POST") posts.push(String(u)); return route(u, i); }));
    const { text: out } = await text(await handleMcpRequest(call("plan_week_meals", {
      dryRun: true,
      meals: [{ date: "2026-11-03", summary: "Pasta" }, { date: "2026-11-04", summary: "Fajitas" }, { date: "2026-11-05", meal: "Breakfast", summary: "Pancakes" }],
    }), props, "t"));
    expect(out).toContain("Dry run");
    expect(out).toContain('Tue, Nov 3 Dinner: skipped, already "Thai green curry"');
    expect(out).toContain('Wed, Nov 4 Dinner: would add "Fajitas"');
    expect(out).toContain('Thu, Nov 5 Breakfast: would add "Pancakes"');
    expect(posts.filter((p) => p.includes("/meals/sittings"))).toHaveLength(0);
  });

  it("writes the open slots, skips filled ones, pushes recipe ingredients when asked", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const grocery: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: RequestInit) => {
      if (String(u).includes("/meals/sittings") && i?.method === "POST") bodies.push(JSON.parse(String(i.body)));
      if (String(u).includes("/add_to_grocery_list")) grocery.push(String(u));
      return route(u, i);
    }));
    const { text: out } = await text(await handleMcpRequest(call("plan_week_meals", {
      addRecipesToGroceryList: true,
      meals: [{ date: "2026-11-03", summary: "Pasta" }, { date: "2026-11-04", summary: "Fajitas" }, { date: "2026-11-06", recipeId: "r9" }],
    }), props, "t"));
    expect(out).toContain("Wrote 2 of 3");
    expect(bodies).toEqual([
      { date: "2026-11-04", meal_category_id: "12", summary: "Fajitas" },
      { date: "2026-11-06", meal_category_id: "12", meal_recipe_id: "r9" },
    ]);
    expect(grocery).toHaveLength(1);
    expect(out).toContain("ingredients added to grocery list");
  });

  it("sets note and instructions after creating, sending the meal's own category and leaving other fields alone", async () => {
    const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
    const created: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: RequestInit) => {
      const url = String(u);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/meals/sittings") && i?.method === "POST") {
        const body = JSON.parse(String(i.body)) as Record<string, unknown>;
        created.date = body.date;
        return json({ data: [{ id: "777", type: "meal_sitting", attributes: { summary: body.summary, instances: [body.date], rrule: null, note: "", description: "" } }] });
      }
      if (url.includes("/meals/sittings") && i?.method === "PATCH") {
        patches.push({ url, body: JSON.parse(String(i.body)) as Record<string, unknown> });
        return json({ data: [] });
      }
      if (url.includes("/meals/sittings") && (i?.method ?? "GET") === "GET" && new Headers(i?.headers).get("Skylight-Api-Version") === "2026-10-15") {
        return json({ data: [{ id: "777", type: "meal_sitting", attributes: { summary: "Baked salmon", instances: ["2026-11-04"], rrule: null, note: "", description: "" }, relationships: { meal_category: { data: { type: "meal_category", id: "12" } }, meal_recipe: { data: null } } }] });
      }
      return route(u, i);
    }));
    const { text: out } = await text(await handleMcpRequest(call("plan_week_meals", {
      meals: [{ date: "2026-11-04", summary: "Baked salmon", note: "Keep a plate", description: "https://example.com/r Bake 400F" }],
    }), props, "t"));
    expect(out).toContain("Wrote 1 of 1");
    expect(out).toContain("note set, instructions set");
    expect(patches).toHaveLength(1);
    expect(new URL(patches[0]!.url).pathname).toBe("/api/frames/frame-1/meals/sittings/777/instances/2026-11-04");
    expect(patches[0]!.body).toMatchObject({ note: "Keep a plate", description: "https://example.com/r Bake 400F", summary: "Baked salmon", meal_category_id: "12", rrule: null });
  });

  it("if attaching text fails the meal still counts as added and the reply says the text is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: RequestInit) => {
      if (String(u).includes("/meals/sittings") && i?.method === "PATCH") return new Response("nope", { status: 500 });
      return route(u, i);
    }));
    const { text: out } = await text(await handleMcpRequest(call("plan_week_meals", {
      meals: [{ date: "2026-11-04", summary: "Fajitas", note: "x" }],
    }), props, "t"));
    expect(out).toContain('added "Fajitas"');
    expect(out).toMatch(/NOTE\/INSTRUCTIONS NOT SET/);
  });

  it("validates before writing: unknown category or empty entry aborts the whole batch", async () => {
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: RequestInit) => { if (i?.method === "POST") posts.push(String(u)); return route(u, i); }));
    const { text: out, isError } = await text(await handleMcpRequest(call("plan_week_meals", {
      meals: [{ date: "2026-11-04", summary: "Fajitas" }, { date: "2026-11-05", meal: "Brunch", summary: "x" }, { date: "2026-11-06" }],
    }), props, "t"));
    expect(isError).toBe(true);
    expect(out).toContain("Nothing written");
    expect(out).toContain('no meal category called "Brunch"');
    expect(out).toContain("give a summary or a recipeId");
    expect(posts).toHaveLength(0);
  });
});
