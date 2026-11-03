/**
 * Planning tools: the ones a proactive assistant (Claude Duet) needs to
 * reason about a family week in one or two calls instead of five.
 *
 *   get_week_overview  calendar + chores + meals + lists, day by day, compact
 *   find_conflicts     overlapping timed events
 *   find_free_slots    gaps of at least N minutes within a daily window
 *   plan_week_meals    write several meal sittings in one call, with dry run
 *
 * Output deliberately omits emails, calendar ids and UIDs: they are noise for
 * the model and personal data in every transcript.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCalendarEvents } from "../api/endpoints/calendar.js";
import { getChores, isChoreDone } from "../api/endpoints/chores.js";
import { getListWithItems, getLists } from "../api/endpoints/lists.js";
import {
  addRecipeToGroceryList,
  createMealSitting,
  findMealSitting,
  getMealCategories,
  getMealSittings,
  mealCategoryName,
  type MealCategoryResource,
  type MealSittingResource,
  updateMealSitting,
} from "../api/endpoints/meals.js";
import { getConfig } from "../config.js";
import { getTodayDate, parseDate } from "../utils/dates.js";
import { formatErrorForMcp } from "../utils/errors.js";
import {
  addDays,
  eachDay,
  eventToInterval,
  findConflicts,
  findFreeSlots,
  formatDay,
  formatRange,
  groupByDay,
  type Interval,
} from "../utils/schedule.js";

const MAX_DAYS = 31;
const MAX_LIST_ITEMS_SHOWN = 15;

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

function resolveRange(date: string | undefined, dateEnd: string | undefined, days: number | undefined, timezone: string): { start: string; end: string } {
  const start = date ? parseDate(date, timezone) : getTodayDate(timezone);
  const end = dateEnd ? parseDate(dateEnd, timezone) : addDays(start, Math.max(1, Math.min(days ?? 7, MAX_DAYS)) - 1);
  if (end < start) throw new Error("dateEnd is before date");
  if (eachDay(start, end).length > MAX_DAYS) throw new Error(`Range is longer than ${MAX_DAYS} days`);
  return { start, end };
}

/** Meals for a range, keyed by "YYYY-MM-DD|Category". Null if the account has no meal planning. */
async function loadMeals(start: string, end: string): Promise<{ byKey: Map<string, string>; categories: MealCategoryResource[] } | null> {
  try {
    const [categories, sittings] = await Promise.all([getMealCategories(), getMealSittings({ dateMin: start, dateMax: addDays(end, 1) })]);
    const name = new Map(categories.map((c) => [c.id, mealCategoryName(c)]));
    const byKey = new Map<string, string>();
    for (const s of sittings) {
      const cat = name.get(s.relationships?.meal_category?.data?.id ?? "") ?? "Meal";
      const what = describeSitting(s);
      for (const d of s.attributes.instances ?? (s.attributes.date ? [s.attributes.date] : [])) {
        if (d >= start && d <= end) byKey.set(`${d}|${cat}`, what);
      }
    }
    return { byKey, categories };
  } catch {
    return null; // no Plus, or endpoint unavailable: the overview just omits meals
  }
}

function describeSitting(s: MealSittingResource): string {
  const summary = s.attributes.summary?.trim();
  const recipe = s.relationships?.meal_recipe?.data?.id;
  return summary || (recipe ? `recipe ${recipe}` : "(empty)");
}

export function registerPlanningTools(server: McpServer): void {
  server.tool(
    "get_week_overview",
    `One compact view of the family's week: calendar events, chores and tasks (with status and assignee), planned meals, and list summaries, day by day, plus any scheduling conflicts.

Use this first when planning anything (dinners, errands, who drives). It replaces separate calls to get_calendar_events, get_chores, get_meal_sittings and get_lists for the same range.

Parameters:
- date: first day (YYYY-MM-DD, 'today', 'monday'...). Default today.
- days: how many days (1–31). Default 7. Or give dateEnd instead.
- includeLists: include grocery/to-do list summaries. Default true.`,
    {
      date: z.string().optional().describe("First day. Default today."),
      dateEnd: z.string().optional().describe("Last day (YYYY-MM-DD). Overrides days."),
      days: z.number().int().min(1).max(MAX_DAYS).optional().describe("Number of days. Default 7."),
      includeLists: z.boolean().optional().describe("Include list summaries. Default true."),
    },
    async ({ date, dateEnd, days, includeLists }) => {
      try {
        const config = getConfig();
        const tz = config.timezone;
        const { start, end } = resolveRange(date, dateEnd, days, tz);
        const dayList = eachDay(start, end);

        const [events, choresResult, meals, lists] = await Promise.all([
          getCalendarEvents({ dateMin: start, dateMax: end, timezone: tz }),
          getChores({ after: start, before: end, includeLate: true, includeUpForGrabs: true }),
          loadMeals(start, end),
          includeLists === false ? Promise.resolve(null) : getLists().catch(() => null),
        ]);

        const intervals = events.map((e) => eventToInterval(e as { id: string; attributes: Record<string, unknown> }, tz)).filter((i): i is Interval => i !== null);
        const byDay = groupByDay(intervals, dayList, tz);
        const assignee = new Map(choresResult.categories.map((c) => [c.id, c.attributes.label ?? "someone"]));
        const choresByDay = new Map<string, string[]>(dayList.map((d) => [d, []]));
        const late: string[] = [];
        for (const chore of choresResult.chores) {
          const a = chore.attributes;
          const catId = chore.relationships?.category?.data?.id;
          const who = catId ? assignee.get(catId) : a.up_for_grabs ? "up for grabs" : undefined;
          const line = `${isChoreDone(a.status) ? "[x]" : "[ ]"} ${a.summary}${a.routine ? " [routine]" : ""}${who ? ` (${who})` : ""}${a.start_time ? ` at ${a.start_time}` : ""}${a.reward_points ? `, ${a.reward_points} pts` : ""} [chore ID: ${chore.id}]`;
          if (a.start < start && !isChoreDone(a.status)) late.push(`${line}, due ${formatDay(a.start)}`);
          else choresByDay.get(a.start)?.push(line);
        }

        const out: string[] = [`Week overview, ${formatDay(start)} to ${formatDay(end)} (${tz}):`];
        for (const d of dayList) {
          out.push("", `${formatDay(d)}`);
          const evs = byDay.get(d) ?? [];
          for (const i of evs) out.push(`  ${i.allDay ? "all day" : formatRange(i.start, i.end, tz)}: ${i.summary}`);
          for (const c of choresByDay.get(d) ?? []) out.push(`  chore ${c}`);
          if (meals) {
            for (const cat of meals.categories) {
              const what = meals.byKey.get(`${d}|${mealCategoryName(cat)}`);
              if (what) out.push(`  ${mealCategoryName(cat).toLowerCase()}: ${what}`);
            }
          }
          if (evs.length === 0 && (choresByDay.get(d) ?? []).length === 0 && !hasMealOn(meals, d)) out.push("  (nothing scheduled)");
        }

        if (late.length) out.push("", "Overdue chores:", ...late.map((l) => `  chore ${l}`));

        const all = findConflicts(intervals);
        const conflicts = all.filter((c) => !c.duplicate);
        const duplicates = all.filter((c) => c.duplicate);
        out.push("", conflicts.length ? "Conflicts:" : "Conflicts: none");
        for (const c of conflicts) {
          out.push(`  ${formatDay(dateOf(c.overlapStart, tz))}: "${c.a.summary}" and "${c.b.summary}" overlap ${formatRange(c.overlapStart, c.overlapEnd, tz)}`);
        }
        if (duplicates.length) {
          out.push("", "Duplicate feed entries (the same event listed twice, not a clash):");
          for (const c of duplicates) out.push(`  ${formatDay(dateOf(c.overlapStart, tz))}: "${c.a.summary}" = "${c.b.summary}" ${formatRange(c.a.start, c.a.end, tz)}`);
        }

        if (meals === null) out.push("", "Meals: not available on this account (Skylight Plus).");

        if (lists) {
          out.push("", "Lists:");
          for (const list of lists) {
            try {
              const { items } = await getListWithItems(list.id);
              const pending = items.filter((i) => i.attributes.status !== "completed");
              const shown = pending.slice(0, MAX_LIST_ITEMS_SHOWN).map((i) => i.attributes.label).join(", ");
              const more = pending.length > MAX_LIST_ITEMS_SHOWN ? `, +${pending.length - MAX_LIST_ITEMS_SHOWN} more` : "";
              out.push(`  ${list.attributes.label} (${list.attributes.kind === "shopping" ? "shopping" : "to-do"}${list.attributes.default_grocery_list ? ", default grocery" : ""}): ${pending.length} pending${pending.length ? `: ${shown}${more}` : ""} [list ID: ${list.id}]`);
            } catch {
              out.push(`  ${list.attributes.label}: (could not load items)`);
            }
          }
        }

        return text(out.join("\n"));
      } catch (error) {
        return text(formatErrorForMcp(error), true);
      }
    }
  );

  server.tool(
    "find_conflicts",
    `Find calendar events that overlap in time within a date range. All-day events never count as conflicts. A subscribed feed that lists the same event twice (same start, end and title apart from a note like "Arrive 20 minutes early") is reported separately as a duplicate, not a conflict.

Returns each overlapping pair with the overlap window, or "none".`,
    {
      date: z.string().optional().describe("First day. Default today."),
      dateEnd: z.string().optional().describe("Last day. Default 7 days."),
      days: z.number().int().min(1).max(MAX_DAYS).optional(),
    },
    async ({ date, dateEnd, days }) => {
      try {
        const tz = getConfig().timezone;
        const { start, end } = resolveRange(date, dateEnd, days, tz);
        const events = await getCalendarEvents({ dateMin: start, dateMax: end, timezone: tz });
        const intervals = events.map((e) => eventToInterval(e as { id: string; attributes: Record<string, unknown> }, tz)).filter((i): i is Interval => i !== null);
        const all = findConflicts(intervals);
        const conflicts = all.filter((c) => !c.duplicate);
        const duplicates = all.filter((c) => c.duplicate);
        const dupLines = duplicates.map(
          (c) => `- ${formatDay(dateOf(c.overlapStart, tz))}: "${c.a.summary}" and "${c.b.summary}" ${formatRange(c.a.start, c.a.end, tz)} [event IDs: ${c.a.id}, ${c.b.id}]`
        );
        const dupBlock = dupLines.length
          ? `\n\nDuplicate feed entries (the same event listed twice by a subscribed calendar, so not a clash):\n\n${dupLines.join("\n")}`
          : "";
        if (conflicts.length === 0) return text(`No conflicts between ${formatDay(start)} and ${formatDay(end)}.${dupBlock}`);
        const lines = conflicts.map(
          (c) => `- ${formatDay(dateOf(c.overlapStart, tz))}: "${c.a.summary}" (${formatRange(c.a.start, c.a.end, tz)}) and "${c.b.summary}" (${formatRange(c.b.start, c.b.end, tz)}) overlap ${formatRange(c.overlapStart, c.overlapEnd, tz)} [event IDs: ${c.a.id}, ${c.b.id}]`
        );
        return text(`Conflicts between ${formatDay(start)} and ${formatDay(end)}:\n\n${lines.join("\n")}${dupBlock}`);
      } catch (error) {
        return text(formatErrorForMcp(error), true);
      }
    }
  );

  server.tool(
    "find_free_slots",
    `Find free time of at least a given length on each day, between an earliest and latest time, around the calendar's timed events. All-day events are not treated as busy.

Use for "when could we do X this week?" questions.`,
    {
      date: z.string().optional().describe("First day. Default today."),
      dateEnd: z.string().optional().describe("Last day. Default 7 days."),
      days: z.number().int().min(1).max(MAX_DAYS).optional(),
      durationMinutes: z.number().int().min(5).max(24 * 60).optional().describe("Minimum slot length. Default 60."),
      earliest: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("Window start, HH:MM local. Default 08:00."),
      latest: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("Window end, HH:MM local. Default 21:00."),
    },
    async ({ date, dateEnd, days, durationMinutes, earliest, latest }) => {
      try {
        const tz = getConfig().timezone;
        const { start, end } = resolveRange(date, dateEnd, days, tz);
        const events = await getCalendarEvents({ dateMin: start, dateMax: end, timezone: tz });
        const intervals = events.map((e) => eventToInterval(e as { id: string; attributes: Record<string, unknown> }, tz)).filter((i): i is Interval => i !== null);
        const slots = findFreeSlots(intervals, eachDay(start, end), {
          earliest: earliest ?? "08:00",
          latest: latest ?? "21:00",
          minMinutes: durationMinutes ?? 60,
          timeZone: tz,
        });
        if (slots.length === 0) return text(`No free slots of ${durationMinutes ?? 60}+ minutes between ${earliest ?? "08:00"} and ${latest ?? "21:00"} from ${formatDay(start)} to ${formatDay(end)}.`);
        const byDay = new Map<string, string[]>();
        for (const s of slots) {
          const list = byDay.get(s.date) ?? [];
          list.push(`${formatRange(s.start, s.end, tz)} (${Math.floor(s.minutes / 60)}h${s.minutes % 60 ? ` ${s.minutes % 60}m` : ""})`);
          byDay.set(s.date, list);
        }
        const lines = [...byDay.entries()].map(([d, l]) => `- ${formatDay(d)}: ${l.join("; ")}`);
        return text(`Free slots of ${durationMinutes ?? 60}+ minutes, ${earliest ?? "08:00"}–${latest ?? "21:00"} (${tz}):\n\n${lines.join("\n")}`);
      } catch (error) {
        return text(formatErrorForMcp(error), true);
      }
    }
  );

  server.tool(
    "plan_week_meals",
    `Schedule several meals in one call - Plus subscription required.

Each entry names a date, a meal (category name like "Dinner", default Dinner), and either a free-text summary ("Thai green curry") or a saved recipeId. A slot that already has a meal is skipped and reported, never overwritten. Use dryRun first to see what would change.

Parameters:
- meals: list of { date, meal?, summary?, recipeId?, note?, description? }
  - note: family notes shown on the meal (500 characters max)
  - description: the app's "Instructions or ingredients" field (2000 characters max)
  note and description are written with a second request per meal after it is created; if that second step fails the reply says the meal was added but its note or instructions were not.
- dryRun: report the plan without writing. Default false.
- addRecipesToGroceryList: for entries with a recipeId, also push that recipe's ingredients to the grocery list. Default false.`,
    {
      meals: z
        .array(
          z.object({
            date: z.string().describe("YYYY-MM-DD, 'today', 'tomorrow', or a weekday name"),
            meal: z.string().optional().describe("Category name, e.g. Dinner (default), Lunch, Breakfast, Snack"),
            summary: z.string().max(200).optional().describe("Free-text meal name"),
            recipeId: z.string().optional().describe("Saved recipe ID"),
            note: z.string().max(500).optional().describe("Family notes for the meal"),
            description: z.string().max(2000).optional().describe("Instructions or ingredients text"),
          })
        )
        .min(1)
        .max(31),
      dryRun: z.boolean().optional(),
      addRecipesToGroceryList: z.boolean().optional(),
    },
    async ({ meals, dryRun, addRecipesToGroceryList }) => {
      try {
        const tz = getConfig().timezone;
        const categories = await getMealCategories();
        const byName = new Map(categories.map((c) => [mealCategoryName(c).toLowerCase(), c]));

        // Resolve and validate everything before writing anything.
        const resolved: Array<{ date: string; category: MealCategoryResource; summary?: string; recipeId?: string; note?: string; description?: string; label: string }> = [];
        const problems: string[] = [];
        for (const m of meals) {
          const date = parseDate(m.date, tz);
          const category = byName.get((m.meal ?? "dinner").toLowerCase());
          if (!category) {
            problems.push(`${m.date}: no meal category called "${m.meal}". Available: ${[...byName.keys()].join(", ")}`);
            continue;
          }
          if (!m.summary?.trim() && !m.recipeId) {
            problems.push(`${m.date} ${mealCategoryName(category)}: give a summary or a recipeId`);
            continue;
          }
          resolved.push({
            date,
            category,
            summary: m.summary?.trim() || undefined,
            recipeId: m.recipeId,
            note: m.note?.trim() || undefined,
            description: m.description?.trim() || undefined,
            label: m.summary?.trim() || `recipe ${m.recipeId}`,
          });
        }
        if (problems.length) return text(`Nothing written. Fix these first:\n- ${problems.join("\n- ")}`, true);

        const dates = resolved.map((r) => r.date).sort();
        const existing = await loadMeals(dates[0], dates[dates.length - 1]);
        const taken = existing?.byKey ?? new Map<string, string>();

        const lines: string[] = [];
        let written = 0;
        for (const r of resolved) {
          const key = `${r.date}|${mealCategoryName(r.category)}`;
          const current = taken.get(key);
          if (current) {
            lines.push(`- ${formatDay(r.date)} ${mealCategoryName(r.category)}: skipped, already "${current}"`);
            continue;
          }
          if (dryRun) {
            const withText = [r.note ? "note" : "", r.description ? "instructions" : ""].filter(Boolean).join(" and ");
            lines.push(`- ${formatDay(r.date)} ${mealCategoryName(r.category)}: would add "${r.label}"${withText ? ` with ${withText}` : ""}`);
            continue;
          }
          try {
            const sitting = await createMealSitting({ date: r.date, mealCategoryId: r.category.id, summary: r.summary, recipeId: r.recipeId });
            written++;
            taken.set(key, r.label);
            let extra = "";
            if (addRecipesToGroceryList && r.recipeId) {
              try {
                await addRecipeToGroceryList(r.recipeId);
                extra = ", ingredients added to grocery list";
              } catch (e) {
                extra = `, grocery push failed: ${e instanceof Error ? e.message : String(e)}`;
              }
            }
            if (r.note || r.description) {
              try {
                const created = await findMealSitting(sitting.id, r.date);
                if (!created) throw new Error("the new meal was not found to attach text to");
                await updateMealSitting({ existing: created, date: r.date, note: r.note, description: r.description, mealCategoryId: r.category.id });
                extra += `${r.note ? ", note set" : ""}${r.description ? ", instructions set" : ""}`;
              } catch (e) {
                extra += `, NOTE/INSTRUCTIONS NOT SET (meal was added): ${e instanceof Error ? e.message : String(e)}`;
              }
            }
            lines.push(`- ${formatDay(r.date)} ${mealCategoryName(r.category)}: added "${r.label}" [sitting ID: ${sitting.id}]${extra}`);
          } catch (e) {
            lines.push(`- ${formatDay(r.date)} ${mealCategoryName(r.category)}: FAILED "${r.label}": ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const head = dryRun ? "Dry run, nothing written:" : `Wrote ${written} of ${resolved.length}:`;
        return text(`${head}\n${lines.join("\n")}`);
      } catch (error) {
        return text(formatErrorForMcp(error), true);
      }
    }
  );
}

function hasMealOn(meals: Awaited<ReturnType<typeof loadMeals>>, date: string): boolean {
  if (!meals) return false;
  for (const key of meals.byKey.keys()) if (key.startsWith(`${date}|`)) return true;
  return false;
}

function dateOf(epochMs: number, tz: string): string {
  return new Date(epochMs).toLocaleDateString("en-CA", { timeZone: tz });
}
