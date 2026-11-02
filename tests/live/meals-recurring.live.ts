import { expect, it } from "vitest";
import { categoryIdFrom, liveSuite, LIVE_PREFIX, sittingIdFrom } from "./harness.js";

// Repeating-meal round trip on a throwaway weekly series ~100 days out:
// create, delete one occurrence, delete this-and-future, delete all. Each step
// is verified by reading back, and the preview is checked to change nothing.
// A cleanup removes the whole series even if an assertion fails midway.
//
// This is the check the mocked tests cannot give: the repeating create body,
// the API version it is sent under, and how Skylight answers a one-day read
// after each scope (the mocked confirmation logic is inferred from captures
// that used a month-wide window).

liveSuite("repeating meal create and scoped delete", { tags: ["write", "meals"] }, (ctx) => {
  let id: string | null = null;
  let dinner: string | null = null;
  const week = (n: number): string => ctx.daysFromToday(100 + 7 * n);
  const name = `${LIVE_PREFIX}weekly meal`;

  async function listed(date: string): Promise<string> {
    const r = await ctx.call("get_meal_sittings", { date, dateEnd: date });
    return r.text;
  }
  const has = async (n: number): Promise<boolean> => (await listed(week(n))).includes(`sitting ID: ${id}`);

  it("finds the Dinner category", async () => {
    if (!ctx.hasPlus) return ctx.note("skipped: account has no Plus");
    const r = await ctx.call("get_meal_categories");
    dinner = categoryIdFrom(r.text, "Dinner");
    expect(dinner, "Dinner category id").not.toBeNull();
  });

  it("creates a weekly series that shows on later weeks", async () => {
    if (!dinner) return;
    const r = await ctx.call("create_meal_sitting", { date: week(0), mealCategoryId: dinner, summary: name, repeat: "weekly" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/repeating weekly/);
    id = sittingIdFrom(r.text);
    expect(id, "sitting id in the create response").not.toBeNull();
    ctx.onCleanup(async () => {
      if (!id) return;
      for (let n = 0; n < 4; n++) {
        if (await has(n)) {
          await ctx.call("delete_meal_sitting", { sittingId: id, date: week(n), scope: "all", confirm: true });
          return;
        }
      }
    });
    expect(await has(0), "week 0").toBe(true);
    expect(await has(1), "week 1").toBe(true);
    expect(await has(2), "week 2").toBe(true);
    expect(await has(3), "week 3").toBe(true);
  });

  it("previews delete for every scope and removes nothing", async () => {
    if (!id) return;
    for (const scope of ["one", "future", "all"] as const) {
      const r = await ctx.call("delete_meal_sitting", { sittingId: id, date: week(1), scope });
      expect(r.text, scope).toContain("NOT DELETED");
    }
    expect(await has(1)).toBe(true);
  });

  it("scope one removes only that week", async () => {
    if (!id) return;
    const r = await ctx.call("delete_meal_sitting", { sittingId: id, date: week(1), scope: "one", confirm: true });
    expect(r.isError, r.text).toBe(false);
    expect(await has(0), "week 0 kept").toBe(true);
    expect(await has(1), "week 1 gone").toBe(false);
    expect(await has(2), "week 2 kept").toBe(true);
    expect(await has(3), "week 3 kept").toBe(true);
  });

  it("scope future removes that week and every later one, keeps earlier", async () => {
    if (!id) return;
    const r = await ctx.call("delete_meal_sitting", { sittingId: id, date: week(2), scope: "future", confirm: true });
    expect(r.isError, r.text).toBe(false);
    expect(await has(0), "week 0 kept").toBe(true);
    expect(await has(2), "week 2 gone").toBe(false);
    expect(await has(3), "week 3 gone").toBe(false);
  });

  it("scope all removes the series and Skylight agrees", async () => {
    if (!id) return;
    const r = await ctx.call("delete_meal_sitting", { sittingId: id, date: week(0), scope: "all", confirm: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/whole series/);
    expect(await has(0), "week 0 gone").toBe(false);
  });
});
