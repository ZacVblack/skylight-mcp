import { expect, it } from "vitest";
import { categoryIdFrom, liveSuite, LIVE_PREFIX, sittingIdFrom } from "./harness.js";

// PROBE, not a regression test: finds out what an `apply_to=all` edit does to a
// weekly series when the body carries the ORIGINAL start date but the request
// is addressed at a LATER occurrence. Captured on 2026-11-01: sending the
// edited occurrence's date as `date` moves the series start there and drops
// earlier occurrences. If sending the original start date avoids that, edit
// scope `all` can be built safely. If not, `all` stays refused.
//
// Observations are printed with ctx.note before any assertion, so the facts
// come out even when the hypothesis fails. The series is removed afterwards.

liveSuite("repeating meal edit probe (apply_to=all)", { tags: ["write", "meals"] }, (ctx) => {
  let id: string | null = null;
  let dinner: string | null = null;
  const week = (n: number): string => ctx.daysFromToday(100 + 7 * n);
  const name = `${LIVE_PREFIX}edit probe`;
  const renamed = `${LIVE_PREFIX}edit probe renamed`;

  async function listed(date: string): Promise<string> {
    return (await ctx.call("get_meal_sittings", { date, dateEnd: date })).text;
  }
  const has = async (n: number): Promise<boolean> => (await listed(week(n))).includes(`sitting ID: ${id}`);

  it("creates a weekly series", async () => {
    if (!ctx.hasPlus) throw new Error("Plus required");
    const cats = await ctx.call("get_meal_categories");
    dinner = categoryIdFrom(cats.text, "Dinner");
    expect(dinner, "Dinner category id").not.toBeNull();
    const r = await ctx.call("create_meal_sitting", { date: week(0), mealCategoryId: dinner!, summary: name, repeat: "weekly" });
    expect(r.isError, r.text).toBe(false);
    id = sittingIdFrom(r.text);
    expect(id).not.toBeNull();
    ctx.onCleanup(async () => {
      if (!id) return;
      for (let n = -1; n < 5; n++) {
        if (await has(n)) {
          await ctx.call("delete_meal_sitting", { sittingId: id, date: week(n), scope: "all", confirm: true });
          return;
        }
      }
    });
    expect(await has(0)).toBe(true);
    expect(await has(2)).toBe(true);
  });

  let derivedStart: string | null = null;

  it("series start date: attributes.date is not exposed, so derive it from a wide read", async () => {
    if (!id) return;
    const client = ctx.client();
    type Row = { id: string; attributes: Record<string, unknown> };
    const read = async (from: string, to: string): Promise<Row | undefined> => {
      const r = await client.request<{ data?: Row[] }>("/api/frames/{frameId}/meals/sittings", {
        method: "GET",
        params: { date_min: from, date_max: to, include: "meal_category,meal_recipe,profiles" },
        apiVersion: "2026-10-15",
      });
      return (r.data ?? []).find((x) => x.id === id);
    };
    const narrow = await read(week(2), ctx.daysFromToday(100 + 14 + 1));
    ctx.note(`attribute keys on a series read at week 2: ${Object.keys(narrow?.attributes ?? {}).sort().join(", ")}`);
    const narrowInstances = (narrow?.attributes.instances as string[] | undefined) ?? [];
    ctx.note(`narrow window (week 2 only): instances = ${narrowInstances.join(",") || "none"}`);
    try {
      const wide = await read(ctx.daysFromToday(-730), ctx.daysFromToday(100 + 14 + 1));
      const instances = ((wide?.attributes.instances as string[] | undefined) ?? []).slice().sort();
      ctx.note(`wide window (730 days back to week 2): ${instances.length} instances, first = ${instances[0] ?? "none"}, week 0 is ${week(0)}`);
      derivedStart = instances[0] ?? null;
    } catch (error) {
      ctx.note(`wide window read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    expect(derivedStart, "earliest instance over a wide window equals the series start").toBe(week(0));
  });

  it("edit all, addressed at week 2, body date = start derived from the wide read", async () => {
    if (!id) return;
    const client = ctx.client();
    const at = week(2);
    const query = { date_min: at, date_max: ctx.daysFromToday(100 + 14 + 1), include: "meal_category,meal_recipe,profiles" };
    const read = await client.request<{ data?: Array<{ id: string; attributes: Record<string, unknown>; relationships?: Record<string, { data?: { id: string } | Array<{ id: string }> | null }> }> }>(
      "/api/frames/{frameId}/meals/sittings",
      { method: "GET", params: query, apiVersion: "2026-10-15" }
    );
    const series = (read.data ?? []).find((s) => s.id === id);
    expect(series, "series visible at week 2").toBeTruthy();
    expect(derivedStart, "a start date was derived; this test does not guess one").not.toBeNull();
    const a = series!.attributes;
    const rel = series!.relationships ?? {};
    const one = (k: string): string | null => {
      const d = rel[k]?.data;
      return d && !Array.isArray(d) ? d.id : null;
    };
    const body = {
      date: derivedStart as string,
      note: typeof a.note === "string" ? a.note : "",
      rrule: a.rrule ?? null,
      summary: renamed,
      description: typeof a.description === "string" ? a.description : "",
      meal_category_id: one("meal_category"),
      meal_recipe_id: one("meal_recipe"),
      profile_ids: [] as string[],
      saveToRecipeBox: false,
    };
    ctx.note(`sent rrule present: ${body.rrule ? "yes" : "NO"}; body date derived from the read, equals week 0: ${derivedStart === week(0) ? "yes" : "NO"}; addressed at week 2`);
    const res = await client.request<{ data?: Array<{ id: string; attributes: Record<string, unknown> }> }>(
      `/api/frames/{frameId}/meals/sittings/${id}/instances/${at}`,
      { method: "PATCH", body, params: { ...query, apply_to: "all" }, apiVersion: "2026-10-15" }
    );
    const after = (res.data ?? []).find((s) => s.id === id);
    ctx.note(`response: series id kept = ${after ? "yes" : "NO (id changed or absent)"}; ${after ? `rrule=${String(after.attributes.rrule)}` : ""}`);

    const seen: string[] = [];
    for (let n = 0; n < 4; n++) {
      const text = await listed(week(n));
      const present = text.includes(`sitting ID: ${id}`);
      const renamedHere = text.includes("edit probe renamed");
      seen.push(`week ${n}: ${present ? "present" : "ABSENT"}${present && renamedHere ? ", renamed" : present ? ", NOT renamed" : ""}`);
    }
    ctx.note(`result -> ${seen.join(" | ")}`);

    expect(await has(0), "week 0 (earlier than edited occurrence) survives").toBe(true);
    expect(await has(1), "week 1 survives").toBe(true);
    expect(await has(2), "week 2 survives").toBe(true);
    expect(await has(3), "week 3 survives").toBe(true);
  });
});
