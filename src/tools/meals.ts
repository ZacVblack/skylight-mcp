import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  mealCategoryName,
  getMealCategories,
  getRecipes,
  getRecipe,
  createRecipe,
  updateRecipe,
  deleteRecipe,
  addRecipeToGroceryList,
  getMealSittings,
  createMealSitting,
  findMealSitting,
  updateMealSitting,
  deleteMealSitting,
  mealKind,
  findSeriesStart,
  type MealDeleteScope,
  type MealEditScope,
} from "../api/endpoints/meals.js";
import { parseDate, formatDateForDisplay, getTodayDate, getDateOffset } from "../utils/dates.js";
import { addDays } from "../utils/schedule.js";
import { formatErrorForMcp } from "../utils/errors.js";
import { getConfig } from "../config.js";

export function registerMealTools(server: McpServer): void {
  // get_meal_categories tool
  server.tool(
    "get_meal_categories",
    `Get meal categories (Breakfast, Lunch, Dinner, etc.) - Plus subscription required.

Use this when:
- Finding category IDs for scheduling meals
- Seeing what meal times are available

Returns: List of meal categories with IDs.`,
    {},
    async () => {
      try {
        const categories = await getMealCategories();

        if (categories.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No meal categories found." }],
          };
        }

        const list = categories
          .map((cat) => `- ${mealCategoryName(cat)} (ID: ${cat.id})`)
          .join("\n");

        return {
          content: [{ type: "text" as const, text: `Meal categories:\n\n${list}` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // get_recipes tool
  server.tool(
    "get_recipes",
    `Get all saved recipes - Plus subscription required.

Use this when:
- Browsing available recipes
- Finding a recipe ID for meal planning

Returns: List of recipes with their details.`,
    {},
    async () => {
      try {
        const recipes = await getRecipes();

        if (recipes.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No recipes found." }],
          };
        }

        const list = recipes
          .map((recipe) => {
            const parts = [`- ${recipe.attributes.summary ?? "Untitled"} (ID: ${recipe.id})`];
            if (recipe.attributes.description) {
              parts.push(`  Description: ${recipe.attributes.description}`);
            }
            return parts.join("\n");
          })
          .join("\n\n");

        return {
          content: [{ type: "text" as const, text: `Recipes:\n\n${list}` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // get_recipe tool
  server.tool(
    "get_recipe",
    `Get details for a specific recipe - Plus subscription required.

Parameters:
- recipeId (required): ID of the recipe

Returns: Recipe details including description.`,
    {
      recipeId: z.string().describe("ID of the recipe"),
    },
    async ({ recipeId }) => {
      try {
        const recipe = await getRecipe(recipeId);

        const parts = [`Recipe: ${recipe.attributes.summary ?? "Untitled"}`];
        for (const [key, value] of Object.entries(recipe.attributes)) {
          if (value !== null && value !== undefined && key !== "summary") {
            parts.push(`${key}: ${value}`);
          }
        }

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // create_recipe tool
  server.tool(
    "create_recipe",
    `Create a new recipe - Plus subscription required.

Use this when:
- Adding a new family recipe
- Saving a meal for meal planning

Parameters:
- summary (required): Recipe name
- description: Recipe details or instructions
- mealCategoryId: Category ID (use get_meal_categories)

Returns: The created recipe.`,
    {
      summary: z.string().describe("Recipe name (e.g., 'Spaghetti Bolognese')"),
      description: z.string().optional().describe("Recipe details or instructions"),
      mealCategoryId: z.string().optional().describe("Meal category ID"),
    },
    async ({ summary, description, mealCategoryId }) => {
      try {
        const recipe = await createRecipe({ summary, description, mealCategoryId });
        return {
          content: [
            {
              type: "text" as const,
              text: `Created recipe "${summary}" (ID: ${recipe.id})`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // update_recipe tool
  server.tool(
    "update_recipe",
    `Update an existing recipe - Plus subscription required.

Parameters:
- recipeId (required): ID of the recipe
- summary: New name
- description: New description

Returns: The updated recipe.`,
    {
      recipeId: z.string().describe("ID of the recipe to update"),
      summary: z.string().optional().describe("New recipe name"),
      description: z.string().nullable().optional().describe("New description"),
    },
    async ({ recipeId, summary, description }) => {
      try {
        const updates: Parameters<typeof updateRecipe>[1] = {};
        if (summary !== undefined) updates.summary = summary;
        if (description !== undefined) updates.description = description;

        const recipe = await updateRecipe(recipeId, updates);
        return {
          content: [
            {
              type: "text" as const,
              text: `Updated recipe (ID: ${recipe.id})`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // delete_recipe tool
  server.tool(
    "delete_recipe",
    `Delete a recipe - Plus subscription required.

Parameters:
- recipeId (required): ID of the recipe to delete
- confirm: must be true to delete; without it nothing is deleted and a preview is returned.

Note: This permanently removes the recipe.`,
    {
      recipeId: z.string().describe("ID of the recipe to delete"),
      confirm: z.boolean().optional().default(false).describe("Must be true to delete; otherwise only a preview is returned"),
    },
    async ({ recipeId, confirm }) => {
      try {
        if (!confirm) {
          return {
            content: [{ type: "text" as const, text: `Preview only, nothing deleted. Would permanently delete recipe ${recipeId}. Call again with confirm: true after the user says yes.` }],
          };
        }
        await deleteRecipe(recipeId);
        return {
          content: [{ type: "text" as const, text: `Deleted recipe (ID: ${recipeId})` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // add_recipe_to_grocery_list tool
  server.tool(
    "add_recipe_to_grocery_list",
    `Add a recipe's ingredients to the grocery list - Plus subscription required.

Use this when:
- Planning to make a recipe and need to buy ingredients
- Adding meal ingredients to shopping list

Parameters:
- recipeId (required): ID of the recipe

Returns: Confirmation that ingredients were added.`,
    {
      recipeId: z.string().describe("ID of the recipe"),
    },
    async ({ recipeId }) => {
      try {
        await addRecipeToGroceryList(recipeId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Added recipe ingredients to grocery list`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // get_meal_sittings tool
  server.tool(
    "get_meal_sittings",
    `Get scheduled meals for a date range - Plus subscription required.

Use this when:
- Viewing the meal plan for the week
- Checking what's scheduled for dinner

Parameters:
- date: Start date (defaults to today)
- dateEnd: End date (defaults to 7 days from start)

Returns: List of scheduled meals.`,
    {
      date: z.string().optional().describe("Start date (YYYY-MM-DD or 'today')"),
      dateEnd: z.string().optional().describe("End date (YYYY-MM-DD)"),
    },
    async ({ date, dateEnd }) => {
      try {
        const config = getConfig();
        const startDate = date ? parseDate(date, config.timezone) : getTodayDate(config.timezone);
        const endDate = dateEnd ? parseDate(dateEnd, config.timezone) : getDateOffset(7, config.timezone);

        const sittings = await getMealSittings({
          dateMin: startDate,
          // Skylight's date_max leaves out the end day (a one-day query returns nothing),
          // so ask for one day more; the loop below drops anything past endDate.
          dateMax: addDays(endDate, 1),
        });

        if (sittings.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No meals scheduled for ${formatDateForDisplay(startDate)} to ${formatDateForDisplay(endDate)}.`,
              },
            ],
          };
        }

        // Resolve category ids to names once; recipes are shown by id (fetch with get_recipe).
        const categories = await getMealCategories().catch(() => []);
        const categoryName = new Map(categories.map((c) => [c.id, mealCategoryName(c)]));

        const rows: Array<{ date: string; line: string }> = [];
        for (const sitting of sittings) {
          const dates = sitting.attributes.instances?.length
            ? sitting.attributes.instances
            : [sitting.attributes.date ?? "unknown date"];
          const categoryId = sitting.relationships?.meal_category?.data?.id;
          const category = categoryId ? (categoryName.get(categoryId) ?? `category ${categoryId}`) : "uncategorised";
          const recipeId = sitting.relationships?.meal_recipe?.data?.id;
          const what = sitting.attributes.summary?.trim() || (recipeId ? `recipe ${recipeId}` : "(empty)");
          for (const d of dates) {
            if (d < startDate || d > endDate) continue;
            rows.push({
              date: d,
              line: `- ${formatDateForDisplay(d)} ${category}: ${what}${recipeId ? ` (recipe ID: ${recipeId})` : ""} [sitting ID: ${sitting.id}]`,
            });
          }
        }
        rows.sort((a, b) => a.date.localeCompare(b.date));
        const list = rows.map((r) => r.line).join("\n");

        return {
          content: [{ type: "text" as const, text: `Scheduled meals:\n\n${list}` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // create_meal_sitting tool
  server.tool(
    "create_meal_sitting",
    `Schedule a meal for a specific date - Plus subscription required.

Use this when:
- Planning meals for the week
- Scheduling a recipe for dinner

Parameters:
- date (required): Date for the meal (YYYY-MM-DD)
- mealCategoryId (required): Meal category ID (use get_meal_categories to find "Dinner" etc.)
- summary: What the meal is, as free text, e.g. "Thai green curry". No recipe needed.
- recipeId: A saved recipe to link instead of, or as well as, a summary.
- repeat: "weekly" makes it repeat every week on the same weekday as date, with no end.

Give at least one of summary or recipeId.

Returns: The created meal sitting.`,
    {
      date: z.string().describe("Date for the meal (YYYY-MM-DD or 'today', 'tomorrow')"),
      mealCategoryId: z.string().describe("Meal category ID (e.g., ID for 'Dinner')"),
      summary: z.string().max(200).optional().describe("Meal name as free text, e.g. 'Sheet-pan fajitas'"),
      recipeId: z.string().optional().describe("Saved recipe ID to link"),
      repeat: z.enum(["weekly"]).optional().describe("Repeat every week on date's weekday, no end date"),
    },
    async ({ date, mealCategoryId, summary, recipeId, repeat }) => {
      try {
        if (!summary?.trim() && !recipeId) {
          return {
            content: [{ type: "text" as const, text: "Give a summary (meal name) or a recipeId." }],
            isError: true,
          };
        }
        const config = getConfig();
        const mealDate = parseDate(date, config.timezone);

        const sitting = await createMealSitting({
          date: mealDate,
          mealCategoryId,
          summary: summary?.trim() || undefined,
          recipeId,
          repeat,
        });

        const what = sitting.attributes.summary?.trim() || summary?.trim() || `recipe ${recipeId}`;
        return {
          content: [
            {
              type: "text" as const,
              text: `Scheduled "${what}" for ${formatDateForDisplay(mealDate)}${repeat ? ", repeating weekly" : ""} (sitting ID: ${sitting.id})`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // update_meal_sitting tool
  server.tool(
    "update_meal_sitting",
    `Edit or move a scheduled meal - Plus subscription required.

Use this when:
- Renaming a planned meal, or changing its note or category
- Moving a meal to another day

Parameters:
- sittingId (required): from get_meal_sittings
- date (required): the meal's CURRENT date (YYYY-MM-DD), also from get_meal_sittings
- newDate: move the meal to this date
- summary: new meal name
- note: new note
- mealCategoryId: move to another meal category (use get_meal_categories)

- scope: required for a repeating meal. "one" changes only that date, which becomes a standalone meal with a NEW sitting ID that cannot be edited or deleted here afterwards. "future" changes that date and every later one: the series splits and the later part gets a NEW sitting ID. "all" changes every occurrence, past ones included, keeping the series' start.
- confirm: repeating meals only. Must be true to apply; without it nothing changes and the effect is shown.

Give at least one change. A repeating meal cannot be moved to another day here, and an occurrence that was already edited on its own cannot be edited here; use the Skylight app for those.

Returns: What changed.`,
    {
      sittingId: z.string().describe("Sitting ID from get_meal_sittings"),
      date: z.string().describe("The meal's current date (YYYY-MM-DD)"),
      newDate: z.string().optional().describe("Move the meal to this date (YYYY-MM-DD or 'tomorrow')"),
      summary: z.string().max(200).optional().describe("New meal name"),
      note: z.string().max(500).optional().describe("New note"),
      mealCategoryId: z.string().optional().describe("New meal category ID"),
      scope: z.enum(["one", "future", "all"]).optional().describe("Repeating meals only: one, future or all"),
      confirm: z.boolean().optional().describe("Repeating meals only: set true to apply. Default: preview only."),
    },
    async ({ sittingId, date, newDate, summary, note, mealCategoryId, scope, confirm }) => {
      try {
        if (newDate === undefined && summary === undefined && note === undefined && mealCategoryId === undefined) {
          return {
            content: [{ type: "text" as const, text: "Nothing to change. Give newDate, summary, note or mealCategoryId." }],
            isError: true,
          };
        }
        if (summary !== undefined && !summary.trim()) {
          return { content: [{ type: "text" as const, text: "summary cannot be empty." }], isError: true };
        }
        const config = getConfig();
        const current = parseDate(date, config.timezone);
        const target = newDate ? parseDate(newDate, config.timezone) : undefined;

        const existing = await findMealSitting(sittingId, current);
        if (!existing) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No meal with sitting ID ${sittingId} on ${formatDateForDisplay(current)}. Check get_meal_sittings for the ID and its current date.`,
              },
            ],
            isError: true,
          };
        }

        const was = existing.attributes.summary?.trim() || "(no name)";
        const describeChanges = (): string[] => {
          const out: string[] = [];
          if (summary !== undefined) out.push(`renamed "${was}" to "${summary.trim()}"`);
          if (target && target !== current) out.push(`moved from ${formatDateForDisplay(current)} to ${formatDateForDisplay(target)}`);
          if (note !== undefined) out.push("note updated");
          if (mealCategoryId !== undefined) out.push(`category set to ${mealCategoryId}`);
          return out;
        };

        if (mealKind(existing) === "series") {
          const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
          if (!scope) {
            return fail(
              `"${was}" repeats. Say which occurrences to change with scope: "one" (only ${formatDateForDisplay(current)}), "future" (that date and every later one) or "all" (the whole series). Nothing was changed.`
            );
          }
          if (target && target !== current) {
            return fail("A repeating meal cannot be moved to another day here; use the Skylight app. Nothing was changed.");
          }
          let seriesStart: string | undefined;
          if (scope === "all") {
            seriesStart = (await findSeriesStart(sittingId, current)) ?? undefined;
            if (!seriesStart) {
              return fail(
                "Cannot edit the whole series: its start date could not be determined (Skylight does not state it, and this series may begin more than five years back). Editing without the real start would delete earlier occurrences. Use scope future, or the Skylight app. Nothing was changed."
              );
            }
          }
          const effect: Record<MealEditScope, string> = {
            one: `change only the ${formatDateForDisplay(current)} occurrence of "${was}". It becomes a standalone meal with a NEW sitting ID, and this tool cannot edit or delete it afterwards (use the Skylight app); the series continues without it`,
            future: `change the ${formatDateForDisplay(current)} occurrence of "${was}" and every later one. The series splits: earlier dates stay under the current sitting ID, the rest moves to a NEW sitting ID`,
            all: `change EVERY occurrence of "${was}", past ones included${seriesStart ? ` (the series starts ${formatDateForDisplay(seriesStart)}, which is kept)` : ""}`,
          };
          const list = describeChanges();
          if (!confirm) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `NOT CHANGED. This would ${effect[scope]}: ${list.join("; ")}. Run again with confirm: true to apply.`,
                },
              ],
            };
          }
          const result = await updateMealSitting({
            existing,
            date: current,
            summary: summary?.trim(),
            note,
            mealCategoryId,
            scope,
            seriesStart,
          });
          let tail = "";
          if (scope === "one" || scope === "future") {
            tail = result.sittingId
              ? ` The edited ${scope === "one" ? "occurrence" : "part of the series"} now has sitting ID ${result.sittingId}; the old ID ${sittingId} ${scope === "one" ? "keeps the rest of the series" : "now covers only the earlier dates"}.`
              : " Skylight did not show the new sitting ID in its reply; look it up with get_meal_sittings.";
          } else if (seriesStart) {
            const after = await findSeriesStart(sittingId, current);
            tail =
              after === seriesStart
                ? ` Checked afterwards: the series still starts ${formatDateForDisplay(seriesStart)}.`
                : ` WARNING: the series start now reads ${after ? formatDateForDisplay(after) : "unknown"}, not ${formatDateForDisplay(seriesStart)}. Check get_meal_sittings for missing earlier occurrences.`;
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `Updated ${scope === "all" ? "the whole series" : scope === "future" ? `from ${formatDateForDisplay(current)} onward` : `the ${formatDateForDisplay(current)} occurrence of`} "${was}" (sitting ID: ${sittingId}): ${list.join("; ")}.${tail}`,
              },
            ],
          };
        }

        await updateMealSitting({
          existing,
          date: current,
          newDate: target,
          summary: summary?.trim(),
          note,
          mealCategoryId,
        });

        const changes: string[] = [];
        if (summary !== undefined) changes.push(`renamed "${was}" to "${summary.trim()}"`);
        if (target && target !== current) changes.push(`moved from ${formatDateForDisplay(current)} to ${formatDateForDisplay(target)}`);
        if (note !== undefined) changes.push("note updated");
        if (mealCategoryId !== undefined) changes.push(`category set to ${mealCategoryId}`);
        return {
          content: [{ type: "text" as const, text: `Updated meal (sitting ID: ${sittingId}): ${changes.join("; ")}.` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // delete_meal_sitting tool
  server.tool(
    "delete_meal_sitting",
    `Delete a scheduled meal - Plus subscription required. THIS CANNOT BE UNDONE.

Use this when:
- Removing a meal that was planned by mistake or is no longer happening

Parameters:
- sittingId (required): from get_meal_sittings
- date (required): the meal's date (YYYY-MM-DD)
- scope: for a repeating meal only. "one" (default) removes just that date; "future" removes that date and every later one, keeping earlier ones; "all" removes the whole series, past dates included.
- confirm: must be true to delete. Without it nothing is deleted and what would be removed is shown.

A meal that was edited on its own after being part of a series cannot be deleted here; use the Skylight app.

Returns: Confirmation that Skylight removed the meal.`,
    {
      sittingId: z.string().describe("Sitting ID from get_meal_sittings"),
      date: z.string().describe("The meal's date (YYYY-MM-DD)"),
      scope: z.enum(["one", "future", "all"]).optional().describe("Repeating meals only: one (default), future, or all"),
      confirm: z.boolean().optional().describe("Set true to actually delete. Default: preview only."),
    },
    async ({ sittingId, date, scope, confirm }) => {
      try {
        const config = getConfig();
        const day = parseDate(date, config.timezone);
        const existing = await findMealSitting(sittingId, day);
        if (!existing) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No meal with sitting ID ${sittingId} on ${formatDateForDisplay(day)}. Nothing deleted.`,
              },
            ],
            isError: true,
          };
        }
        const what = existing.attributes.summary?.trim() || "(no name)";
        const kind = mealKind(existing);
        if (kind === "detached") {
          return {
            content: [
              {
                type: "text" as const,
                text: `"${what}" on ${formatDateForDisplay(day)} was edited on its own and is detached from its series. It cannot be deleted here; use the Skylight app. Nothing deleted.`,
              },
            ],
            isError: true,
          };
        }
        const chosen: MealDeleteScope = scope ?? "one";
        const effect =
          kind === "one-off"
            ? `permanently delete "${what}" on ${formatDateForDisplay(day)}`
            : chosen === "one"
              ? `permanently delete only the ${formatDateForDisplay(day)} occurrence of the repeating meal "${what}"; the series continues`
              : chosen === "future"
                ? `permanently delete "${what}" on ${formatDateForDisplay(day)} and every later occurrence; earlier occurrences are kept`
                : `permanently delete the ENTIRE repeating series "${what}", every occurrence including past ones`;
        if (confirm !== true) {
          return {
            content: [
              {
                type: "text" as const,
                text: `NOT DELETED. This would ${effect} (sitting ID: ${sittingId}). Call again with confirm: true to proceed.`,
              },
            ],
          };
        }
        const removed = await deleteMealSitting(existing, day, chosen);
        return {
          content: [
            {
              type: "text" as const,
              text: removed
                ? `Deleted ${kind === "one-off" ? `"${what}" on ${formatDateForDisplay(day)}` : chosen === "all" ? `the whole series "${what}"` : chosen === "future" ? `"${what}" from ${formatDateForDisplay(day)} onward` : `the ${formatDateForDisplay(day)} occurrence of "${what}"`} (sitting ID: ${sittingId}).`
                : `Skylight accepted the request but did not confirm the removal of sitting ${sittingId}. Check get_meal_sittings.`,
            },
          ],
          ...(removed ? {} : { isError: true }),
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );
}
