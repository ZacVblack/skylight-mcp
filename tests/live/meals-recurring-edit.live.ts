import { expect, it } from "vitest";
import { categoryIdFrom, liveSuite, LIVE_PREFIX, sittingIdFrom } from "./harness.js";

// Edit scopes on a repeating meal, through the real tool, on one throwaway
// weekly series ~100 days out. In order: preview changes nothing; scope all
// keeps every week and the series id (the start-date trap); scope future splits
// into a new id; scope one detaches a single week into a new id; the detached
// meal is then refused by the tool. Cleanup removes every series it created and
// the detached meal, and says loudly if anything could not be removed.
//
// Why live: the mocked tests replay captured shapes. The trap (a later
// occurrence's date in an "all" edit silently deletes earlier weeks) was only
// ever shown by the real API.

liveSuite("repeating meal edit scopes", { tags: ["write", "meals"] }, (ctx) => {
  const week = (n: number): string => ctx.daysFromToday(100 + 7 * n);
  const NAMES = { a: `${LIVE_PREFIX}edit A`, b: `${LIVE_PREFIX}edit B`, c: `${LIVE_PREFIX}edit C`, d: `${LIVE_PREFIX}edit D` };
  let dinner: string | null = null;
  let original: string | null = null;
  let split: string | null = null;
  let detached: string | null = null;

  async function listing(n: number): Promise<string> {
    return (await ctx.call("get_meal_sittings", { date: week(n), dateEnd: week(n) })).text;
  }
  /** The listing line for this sitting id in week n, or null. */
  async function line(n: number, id: string | null): Promise<string | null> {
    if (!id) return null;
    return (await listing(n)).split("\n").find((l) => l.includes(`[sitting ID: ${id}]`)) ?? null;
  }
  async function firstWeekWith(id: string | null, from = 0, to = 5): Promise<number | null> {
    for (let n = from; n <= to; n++) if (await line(n, id)) return n;
    return null;
  }
  const idAt = async (n: number, name: string): Promise<string | null> =>
    /\[sitting ID: (\d+)\]/.exec((await listing(n)).split("\n").find((l) => l.includes(name)) ?? "")?.[1] ?? null;

  async function removeSeries(id: string | null): Promise<void> {
    const n = await firstWeekWith(id);
    if (id && n !== null) await ctx.call("delete_meal_sitting", { sittingId: id, date: week(n), scope: "all", confirm: true });
  }

  it("creates a weekly series", async () => {
    if (!ctx.hasPlus) throw new Error("Plus required");
    dinner = categoryIdFrom((await ctx.call("get_meal_categories")).text, "Dinner");
    expect(dinner, "Dinner category id").not.toBeNull();
    const r = await ctx.call("create_meal_sitting", { date: week(0), mealCategoryId: dinner!, summary: NAMES.a, repeat: "weekly" });
    expect(r.isError, r.text).toBe(false);
    original = sittingIdFrom(r.text);
    expect(original).not.toBeNull();
    ctx.onCleanup(async () => {
      await removeSeries(original);
      await removeSeries(split);
      if (detached) {
        // The tool refuses detached meals, so use the raw call the web app makes.
        const n = await firstWeekWith(detached);
        if (n !== null) {
          const at = week(n);
          try {
            await ctx.client().request(`/api/frames/{frameId}/meals/sittings/${detached}/instances/${at}`, {
              method: "DELETE",
              params: { date_min: at, date_max: ctx.daysFromToday(100 + 7 * n + 1), include: "meal_category,meal_recipe,profiles", apply_to: "one" },
              apiVersion: "2026-10-15",
            });
          } catch (error) {
            ctx.note(`detached cleanup call failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      for (let n = 0; n <= 5; n++) {
        const left = (await listing(n)).split("\n").filter((l) => l.includes(`${LIVE_PREFIX}edit`));
        for (const l of left) ctx.note(`LEFTOVER, delete by hand in Skylight (${week(n)}): ${l}`);
      }
    });
    for (let n = 0; n < 4; n++) expect(await line(n, original), `week ${n}`).not.toBeNull();
  });

  it("previews a scoped edit and changes nothing without confirm", async () => {
    if (!original) return;
    for (const scope of ["one", "future", "all"] as const) {
      const r = await ctx.call("update_meal_sitting", { sittingId: original, date: week(2), summary: NAMES.b, scope });
      expect(r.isError, `${scope}: ${r.text}`).toBe(false);
      expect(r.text, scope).toContain("NOT CHANGED");
    }
    expect(await line(2, original)).toContain(NAMES.a);
  });

  it("without a scope the tool refuses and changes nothing", async () => {
    if (!original) return;
    const r = await ctx.call("update_meal_sitting", { sittingId: original, date: week(2), summary: NAMES.b, confirm: true });
    expect(r.isError).toBe(true);
    expect(await line(2, original)).toContain(NAMES.a);
  });

  it("scope all, from week 2, keeps weeks 0 and 1 and the series id", async () => {
    if (!original) return;
    const r = await ctx.call("update_meal_sitting", { sittingId: original, date: week(2), summary: NAMES.b, scope: "all", confirm: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/whole series/);
    expect(r.text, "the tool's own check that the start survived").toMatch(/still starts/);
    for (let n = 0; n < 4; n++) {
      const l = await line(n, original);
      expect(l, `week ${n} kept under the same id`).not.toBeNull();
      expect(l, `week ${n} renamed`).toContain(NAMES.b);
    }
  });

  it("scope future, from week 2, splits: earlier weeks keep the old id, later weeks get a new one", async () => {
    if (!original) return;
    const r = await ctx.call("update_meal_sitting", { sittingId: original, date: week(2), summary: NAMES.c, scope: "future", confirm: true });
    expect(r.isError, r.text).toBe(false);
    split = await idAt(2, NAMES.c);
    expect(split, "new sitting id for the later part, from the listing").not.toBeNull();
    expect(split).not.toBe(original);
    const stated = /sitting ID (\d+)/.exec(r.text)?.[1];
    if (stated) expect(stated, "the reply names the same new id").toBe(split);
    for (const n of [0, 1]) {
      expect(await line(n, original), `week ${n} stays under the old id`).toContain(NAMES.b);
      expect(await line(n, split), `week ${n} not in the new series`).toBeNull();
    }
    for (const n of [2, 3]) {
      expect(await line(n, split), `week ${n} moved to the new id`).toContain(NAMES.c);
      expect(await line(n, original), `week ${n} gone from the old id`).toBeNull();
    }
  });

  it("scope one, on week 3, detaches that week into its own meal", async () => {
    if (!split) return;
    const r = await ctx.call("update_meal_sitting", { sittingId: split, date: week(3), summary: NAMES.d, scope: "one", confirm: true });
    expect(r.isError, r.text).toBe(false);
    detached = await idAt(3, NAMES.d);
    expect(detached, "the edited week is now its own sitting").not.toBeNull();
    expect(detached).not.toBe(split);
    expect(await line(3, split), "series no longer has week 3").toBeNull();
    expect(await line(2, split), "week 2 untouched").toContain(NAMES.c);
    expect(await line(4, split), "later weeks untouched").toContain(NAMES.c);
  });

  it("refuses to edit or delete the detached meal and changes nothing", async () => {
    if (!detached) return;
    const edit = await ctx.call("update_meal_sitting", { sittingId: detached, date: week(3), summary: "x", scope: "all", confirm: true });
    expect(edit.isError).toBe(true);
    const del = await ctx.call("delete_meal_sitting", { sittingId: detached, date: week(3), confirm: true });
    expect(del.isError).toBe(true);
    expect(await line(3, detached)).toContain(NAMES.d);
  });
});
