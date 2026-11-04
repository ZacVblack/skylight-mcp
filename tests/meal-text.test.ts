import { afterEach, describe, expect, it, vi } from "vitest";
import { checkMealText, NAME_CEILING } from "../src/utils/meal-text.js";
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

describe("checkMealText: placeholders are errors", () => {
  it.each([
    ["(plan doc URL)"],
    ["[recipe link]"],
    ["<dessert name>"],
    ["(recipe URL needed)"],
    ["(steps to fill in)"],
    ["(recipe URL)"],
    ["(URL)"],
    ["[link]"],
    ["TBD"],
  ])("flags %s in instructions", (marker) => {
    const found = checkMealText({ description: `https://example.com/r\nPlan: ${marker}` });
    expect(found.errors).toHaveLength(1);
    expect(found.errors[0]).toContain("instructions contains a placeholder");
  });

  it("flags a placeholder in the name and the note", () => {
    expect(checkMealText({ summary: "Burgers + (dessert name)" }).errors[0]).toContain("name contains a placeholder");
    expect(checkMealText({ note: "Start at 5. (recipe URL needed)" }).errors[0]).toContain("note contains a placeholder");
  });

  it("does not flag ordinary parentheses, real links or times", () => {
    const found = checkMealText({
      summary: "Chicken fajitas",
      note: "Practice 6 to 7 (arrive 5:55), eat by 5:15. Marinate by 3:30 (or Sunday night).",
      description: "https://example.com/doc\nBake 12 to 15 min (check early).\nPlan: https://docs.example.com/d/abc/edit",
    });
    expect(found.errors).toEqual([]);
  });
});

describe("checkMealText: warnings advise and never block", () => {
  it("warns on a long name but only above the target", () => {
    expect(checkMealText({ summary: "Green chicken enchiladas" }).warnings).toEqual([]);
    expect(checkMealText({ summary: "Slow cooker chicken tortilla soup" }).warnings.join(" ")).toContain("aim for 25");
    expect(checkMealText({ summary: "x".repeat(NAME_CEILING + 1) }).warnings.join(" ")).toContain("ceiling");
  });

  it("allows a dessert name up to the ceiling but limits the dessert to two words", () => {
    expect(checkMealText({ summary: "Burgers + skillet cookie" }).warnings).toEqual([]);
    expect(checkMealText({ summary: "Tikka masala + apple crisp" }).warnings).toEqual([]);
    const found = checkMealText({ summary: "Smash burgers + pumpkin donut holes" });
    expect(found.warnings.join(" ")).toContain("3 words");
    expect(found.errors).toEqual([]);
  });

  it("warns on non-ASCII text and on cooking steps in a note, not in instructions", () => {
    expect(checkMealText({ summary: "Pasta \u{1F35D}" }).warnings.join(" ")).toContain("non-ASCII");
    expect(checkMealText({ note: "Soft-boil the eggs in the Instant Pot." }).warnings.join(" ")).toContain("cooking step");
    expect(checkMealText({ description: "Simmer 10 min. Whisk in the flour." }).warnings).toEqual([]);
  });
});

const categories = { data: [{ id: "12", type: "meal_category", attributes: { label: "Dinner" } }] };
const sittings = { data: [] };

function json(b: unknown): Response {
  return new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
}

function route(url: string, init?: RequestInit): Response {
  const u = String(url);
  if (u.includes("/meals/categories")) return json(categories);
  if (u.includes("/meals/sittings") && (init?.method ?? "GET") === "GET") return json(sittings);
  if (u.includes("/meals/sittings") && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return json({ data: [{ id: `new-${body.date}`, type: "meal_sitting", attributes: { summary: body.summary, instances: [body.date] } }] });
  }
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
  const j = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: j.result.content.map((c) => c.text).join("\n"), isError: j.result.isError };
}

function stubFetch(): { writes: string[] } {
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (u: string, i?: RequestInit) => {
    if ((i?.method ?? "GET") !== "GET") writes.push(`${i?.method} ${String(u)}`);
    return route(u, i);
  }));
  return { writes };
}

afterEach(() => vi.unstubAllGlobals());

describe("plan_week_meals text checks", () => {
  it("refuses a real write that carries a placeholder, and writes nothing", async () => {
    const { writes } = stubFetch();
    const out = await text(await handleMcpRequest(call("plan_week_meals", {
      meals: [
        { date: "2026-11-09", summary: "Korean chicken bowls", description: "https://example.com/r\nPlan: (plan doc URL)" },
        { date: "2026-11-10", summary: "Green chicken enchiladas", description: "https://example.com/e" },
      ],
    }), props, "t"));
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Nothing written");
    expect(out.text).toContain("placeholder");
    expect(writes).toEqual([]);
  });

  it("a dry run reports the error and writes nothing", async () => {
    const { writes } = stubFetch();
    const out = await text(await handleMcpRequest(call("plan_week_meals", {
      dryRun: true,
      meals: [{ date: "2026-11-09", summary: "Korean chicken bowls", note: "Plan: [recipe link]" }],
    }), props, "t"));
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("Dry run");
    expect(out.text).toContain("Text errors");
    expect(out.text).toContain("would be refused");
    expect(writes).toEqual([]);
  });

  it("warnings are shown but do not block the write", async () => {
    const { writes } = stubFetch();
    const out = await text(await handleMcpRequest(call("plan_week_meals", {
      meals: [{ date: "2026-11-09", summary: "Slow cooker chicken tortilla soup" }],
    }), props, "t"));
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("Text warnings");
    expect(out.text).toContain("aim for 25");
    expect(writes.filter((w) => w.startsWith("POST") && w.includes("/meals/sittings"))).toHaveLength(1);
  });

  it("a clean plan shows no checks section", async () => {
    stubFetch();
    const out = await text(await handleMcpRequest(call("plan_week_meals", {
      dryRun: true,
      meals: [{ date: "2026-11-09", summary: "Baked salmon", note: "Eat by 5:15." }],
    }), props, "t"));
    expect(out.text).not.toContain("Text errors");
    expect(out.text).not.toContain("Text warnings");
  });
});

describe("update_meal_sitting text checks", () => {
  it("refuses a placeholder before reading or writing anything", async () => {
    const { writes } = stubFetch();
    const out = await text(await handleMcpRequest(call("update_meal_sitting", {
      sittingId: "s1", date: "2026-11-09", description: "Plan: (plan doc URL)",
    }), props, "t"));
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Nothing was changed");
    expect(writes).toEqual([]);
  });
});
