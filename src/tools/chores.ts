import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getChores, createChore, updateChore, deleteChore, isChoreDone, parseOccurrenceId, completeChoreOccurrence, deleteChoreOccurrence, updateChoreOccurrence, createRoutine, buildWeeklyRule, WEEK_DAYS } from "../api/endpoints/chores.js";
import { resolveProfile, resolveProfileIds } from "../api/endpoints/categories.js";
import { getTodayDate, getDateOffset, parseDate, parseTime, formatDateForDisplay } from "../utils/dates.js";
import { formatErrorForMcp } from "../utils/errors.js";
import { getConfig } from "../config.js";

export function registerChoreTools(server: McpServer): void {
  // get_chores tool
  server.tool(
    "get_chores",
    `Get chores from Skylight.

Use this to answer:
- "What chores do I need to do today?"
- "Show me this week's chores"
- "What's on the chore chart?"
- "What chores does [name] have?"

Returns chores with their assignees, due dates, and completion status.`,
    {
      date: z
        .string()
        .optional()
        .describe("Start date (YYYY-MM-DD or 'today'). Defaults to today."),
      dateEnd: z
        .string()
        .optional()
        .describe("End date (YYYY-MM-DD). Defaults to 7 days from start."),
      includeLate: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include overdue chores from past dates"),
      assignee: z
        .string()
        .optional()
        .describe("Filter by family member name (e.g., 'Casey', 'Mom')"),
      status: z
        .enum(["pending", "completed", "all"])
        .optional()
        .default("pending")
        .describe("Filter by completion status"),
    },
    async ({ date, dateEnd, includeLate, assignee, status }) => {
      try {
        const config = getConfig();
        const startDate = date ? parseDate(date, config.timezone) : getTodayDate(config.timezone);
        const endDate = dateEnd ? parseDate(dateEnd, config.timezone) : getDateOffset(7, config.timezone);

        const result = await getChores({
          after: startDate,
          before: endDate,
          includeLate: includeLate ?? true,
          includeUpForGrabs: true,
        });

        let chores = result.chores;

        // Filter by status
        if (status !== "all") {
          const wantDone = status === "completed";
          chores = chores.filter((chore) => isChoreDone(chore.attributes.status) === wantDone);
        }

        // Build category lookup for assignee names
        const categoryMap = new Map(result.categories.map((c) => [c.id, c.attributes.label ?? "Unknown"]));

        // Filter by assignee if specified: exact profile name, so "Ben" never matches "Benjamin"
        if (assignee) {
          const wanted = (await resolveProfile(assignee)).id;
          chores = chores.filter((chore) => chore.relationships?.category?.data?.id === wanted);
        }

        if (chores.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No ${status === "all" ? "" : status + " "}chores found${assignee ? ` for ${assignee}` : ""}.`,
              },
            ],
          };
        }

        // Format chores for display
        const choreList = chores
          .map((chore) => {
            const attrs = chore.attributes;
            const categoryId = chore.relationships?.category?.data?.id;
            const assigneeName = categoryId ? categoryMap.get(categoryId) : null;

            const parts = [
              `- ${attrs.summary}`,
              `  Date: ${formatDateForDisplay(attrs.start)}${attrs.start_time ? ` at ${attrs.start_time}` : ""}`,
              `  Status: ${attrs.status}`,
            ];

            if (assigneeName) {
              parts.push(`  Assigned to: ${assigneeName}`);
            } else if (attrs.up_for_grabs) {
              parts.push(`  Assigned to: nobody (up for grabs)`);
            }

            if (attrs.routine) {
              parts.push(`  Routine: Yes (a habit that repeats; shows on the routine chart)`);
            }

            if (attrs.recurring) {
              parts.push(`  Recurring: Yes${attrs.recurrence_set ? ` (${attrs.recurrence_set})` : ""}`);
            }

            if (attrs.reward_points) {
              parts.push(`  Reward points: ${attrs.reward_points}`);
            }

            return parts.join("\n");
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Chores:\n\n${choreList}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatErrorForMcp(error),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // create_chore tool
  server.tool(
    "create_chore",
    `Add a new one-off chore to Skylight for one family member.

Use this when the user wants to:
- Add a task like "empty the dishwasher" on a date
- Assign a chore to a family member

An assignee is required: Skylight rejects a chore with no profile (HTTP 422). Recurring chores are not supported here (only the routine shape has been captured): use create_routine for repeating tasks.

The chore will appear on the Skylight display.`,
    {
      summary: z.string().describe("Chore description (e.g., 'Empty the dishwasher')"),
      date: z
        .string()
        .optional()
        .describe("Due date (YYYY-MM-DD or 'today', 'tomorrow', day name). Defaults to today."),
      time: z
        .string()
        .optional()
        .describe("Due time (e.g., '10:00 AM', '14:30'). Optional."),
      assignee: z
        .string()
        .describe("Family member's exact profile name (e.g., 'Casey'). Required."),
      rewardPoints: z
        .number()
        .optional()
        .describe("Reward points (stars) for completing this chore"),
    },
    async ({ summary, date, time, assignee, rewardPoints }) => {
      try {
        const config = getConfig();
        const choreDate = date ? parseDate(date, config.timezone) : getTodayDate(config.timezone);

        // Resolve assignee to category ID (exact name; refuses partial matches)
        const categoryId = (await resolveProfile(assignee)).id;

        const created = await createChore({
          summary,
          start: choreDate,
          startTime: time ? parseTime(time) : undefined,
          categoryIds: [categoryId],
          rewardPoints,
        });
        const chore = created[0];

        const parts = [
          `Created chore: "${chore.attributes.summary}" (ID: ${chore.id})`,
          `Date: ${formatDateForDisplay(chore.attributes.start)}${chore.attributes.start_time ? ` at ${chore.attributes.start_time}` : ""}`,
          `Assigned to: ${assignee}`,
        ];

        return {
          content: [
            {
              type: "text" as const,
              text: parts.join("\n"),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatErrorForMcp(error),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // update_chore tool
  server.tool(
    "update_chore",
    `Update an existing chore in Skylight.

Use this when:
- (To mark a routine or chore done, use complete_chore, not this tool)
- Changing chore assignment: "Reassign the trash to Casey"
- Updating chore details: "Change the time for the homework chore"

Parameters:
- choreId (required): ID of the chore (from get_chores)
- summary: New description for the chore
- status: not supported here; use complete_chore
- date: New due date
- time: New due time
- assignee: New family member assignment

Recurring chores and routines (ids like 12345-2026-11-03-0600): only summary (rename) and the weekly schedule (days plus timeOfDay, together) can be changed; date, time, assignee and rewardPoints are refused because they have not been captured. Skylight gives the chore a NEW id after every edit, and the reply says what it is. Changing the schedule of a habit-tracked routine can reset its streak history, so it needs acknowledgeReset: true after the user agrees.

Returns: The updated chore details.`,
    {
      choreId: z.string().describe("ID of the chore to update"),
      summary: z.string().optional().describe("New chore description"),
      status: z.enum(["pending", "completed"]).optional().describe("Not supported: use complete_chore to mark a chore done or not done"),
      date: z.string().optional().describe("New due date (YYYY-MM-DD or 'today', 'tomorrow')"),
      time: z.string().nullable().optional().describe("New due time (e.g., '10:00 AM', or null to clear)"),
      assignee: z.string().nullable().optional().describe("New family member assignment (or null to unassign)"),
      rewardPoints: z.number().nullable().optional().describe("New reward points (or null to clear)"),
      days: z.array(z.enum(WEEK_DAYS as unknown as [string, ...string[]])).optional().describe("Recurring chores only: weekdays the routine repeats on (MO TU WE TH FR SA SU). Give with timeOfDay."),
      timeOfDay: z.enum(["morning", "afternoon", "evening"]).optional().describe("Recurring chores only: 'In the' part of day. Give with days."),
      acknowledgeReset: z.boolean().optional().default(false).describe("Set true only after the user agrees that a schedule change may reset the routine's streak history"),
    },
    async ({ choreId, summary, status, date, time, assignee, rewardPoints, days, timeOfDay, acknowledgeReset }) => {
      try {
        if (status !== undefined) {
          return {
            content: [
              {
                type: "text" as const,
                text: "update_chore cannot change completion: Skylight records completions on a separate endpoint, and sending a status here does not award stars or update streaks. Use complete_chore with the chore's id from get_chores. Nothing was changed.",
              },
            ],
            isError: true,
          };
        }
        const occurrence = parseOccurrenceId(choreId);
        if (occurrence) {
          const refuse = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
          if (date !== undefined || time !== undefined || assignee !== undefined || rewardPoints !== undefined) {
            return refuse("For recurring chores and routines only summary and the weekly schedule (days + timeOfDay) can be changed here; date, time, assignee and rewardPoints have not been captured. Nothing was changed.");
          }
          if ((days === undefined) !== (timeOfDay === undefined)) {
            return refuse("Give days and timeOfDay together to change a schedule. Nothing was changed.");
          }
          if (days !== undefined && days.length === 0) return refuse("days cannot be empty. Nothing was changed.");
          if (summary === undefined && days === undefined) return refuse("Nothing to change: give a summary, or days with timeOfDay.");
          if (days !== undefined && !acknowledgeReset) {
            return refuse("Changing the schedule of a routine can reset its streak history, and Skylight gives the chore a new id. Tell the user, and call again with acknowledgeReset: true after they agree. Nothing was changed.");
          }
          const changes: { summary?: string; recurrenceSet?: string[] } = {};
          if (summary !== undefined) changes.summary = summary;
          if (days !== undefined && timeOfDay !== undefined) changes.recurrenceSet = [buildWeeklyRule(days as typeof WEEK_DAYS[number][], timeOfDay)];
          const result = await updateChoreOccurrence(choreId, changes);
          const lines = [`Updated "${result.summary ?? choreId}".`];
          if (result.recurrenceSet) lines.push(`Schedule: ${result.recurrenceSet.join("; ")}`);
          lines.push(result.newId ? `Skylight re-keyed this chore: the series id is now ${result.newId}. Occurrence ids from before this edit are stale; run get_chores again.` : "Run get_chores again; ids may have changed.");
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }
        const config = getConfig();
        const updates: Parameters<typeof updateChore>[1] = {};

        if (summary !== undefined) updates.summary = summary;
        if (date !== undefined) updates.start = parseDate(date, config.timezone);
        if (time !== undefined) updates.startTime = time ? parseTime(time) : null;
        if (rewardPoints !== undefined) updates.rewardPoints = rewardPoints;

        // Handle assignee
        if (assignee !== undefined) {
          if (assignee === null) {
            updates.categoryId = null;
          } else {
            updates.categoryId = (await resolveProfile(assignee)).id;
          }
        }

        const chore = await updateChore(choreId, updates);
        return {
          content: [
            {
              type: "text" as const,
              text: `Updated chore: "${chore.attributes.summary}"`,
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

  // create_routine tool
  server.tool(
    "create_routine",
    `Create a routine: a weekly recurring chore that shows on the routine chart for one or more family members.

Use this when the user wants a repeating habit like "brush teeth every morning" for specific people. A separate routine is created for each profile.

Parameters:
- summary (required): routine name
- profiles (required): family member names, as in get_family_members
- days (required): weekdays it repeats on (MO TU WE TH FR SA SU)
- timeOfDay (required): morning, afternoon or evening
- startDate: first day (YYYY-MM-DD or 'today'); defaults to today
- trackHabit: track streaks (default false)
- rewardPoints: stars per completion
- emojiIcon: optional emoji

Only weekly schedules are supported (every day = all seven days). Returns the new series ids.`,
    {
      summary: z.string().min(1).describe("Routine name"),
      profiles: z.array(z.string()).min(1).describe("Family member names"),
      days: z.array(z.enum(WEEK_DAYS as unknown as [string, ...string[]])).min(1).describe("Weekdays: MO TU WE TH FR SA SU"),
      timeOfDay: z.enum(["morning", "afternoon", "evening"]).describe("In the morning, afternoon or evening"),
      startDate: z.string().optional().describe("First day (YYYY-MM-DD or 'today'). Defaults to today."),
      trackHabit: z.boolean().optional().default(false).describe("Track streaks"),
      rewardPoints: z.number().optional().describe("Stars per completion"),
      emojiIcon: z.string().optional().describe("Optional emoji"),
    },
    async ({ summary, profiles, days, timeOfDay, startDate, trackHabit, rewardPoints, emojiIcon }) => {
      try {
        const config = getConfig();
        const start = startDate ? parseDate(startDate, config.timezone) : getTodayDate(config.timezone);
        const resolved = await resolveProfileIds(profiles);
        const created = await createRoutine({
          summary,
          start,
          categoryIds: resolved.ids,
          recurrenceSet: [buildWeeklyRule(days as typeof WEEK_DAYS[number][], timeOfDay)],
          trackHabit,
          rewardPoints: rewardPoints ?? null,
          emojiIcon: emojiIcon ?? null,
        });
        const text = created.length
          ? `Created routine "${summary}" for ${resolved.labels.join(", ")} (${timeOfDay}, ${days.join(",")}). Series ids: ${created.map((c) => c.id).join(", ")}.`
          : `Skylight accepted the request but returned no routine; check the app.`;
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // complete_chore tool (local only: see LOCAL_ONLY_TOOLS in registry.ts)
  server.tool(
    "complete_chore",
    `Mark one occurrence of a recurring chore or routine complete, or undo that.

This is visible to the family and has real effects: completing a chore with a reward awards stars, and completing a routine extends its streak, both shown on the Skylight display. Undoing restores the status and the stars, but a routine's "longest streak" record cannot be reduced.

Without confirm: true this only previews what would happen and changes nothing. Show the preview to the user and get an explicit yes before calling again with confirm: true.

Parameters:
- choreId (required): the occurrence id from get_chores. For recurring chores and routines it looks like 12345-2026-11-03-0600. One-off chores are not supported.
- complete: true (default) to mark done, false to mark not done
- confirm: must be true to make the change`,
    {
      choreId: z.string().describe("Occurrence id from get_chores, e.g. 12345-2026-11-03-0600"),
      complete: z.boolean().optional().default(true).describe("true to mark complete, false to mark not complete"),
      confirm: z.boolean().optional().default(false).describe("Must be true to make the change; otherwise a preview is returned"),
    },
    async ({ choreId, complete, confirm }) => {
      try {
        const occurrence = parseOccurrenceId(choreId);
        if (!occurrence) {
          return {
            content: [
              {
                type: "text" as const,
                text: `"${choreId}" is not a recurring-chore occurrence id (expected something like 12345-2026-11-03-0600, from get_chores). Completing one-off chores is not supported yet. Nothing was changed.`,
              },
            ],
            isError: true,
          };
        }

        const verb = complete ? "mark complete" : "mark not complete";
        if (!confirm) {
          const warnings = complete
            ? "This shows on the family's Skylight display, awards any stars attached to the chore, and extends a routine's streak."
            : "This shows on the family's Skylight display and removes the stars and streak credit for that day. A routine's longest-streak record is not reduced.";
          return {
            content: [
              {
                type: "text" as const,
                text: `Preview only, nothing changed. Would ${verb} occurrence ${occurrence.instanceDate} ${occurrence.instanceTime} of chore series ${occurrence.seriesId}.\n${warnings}\nCall again with confirm: true after the user says yes.`,
              },
            ],
          };
        }

        const config = getConfig();
        const result = await completeChoreOccurrence(occurrence, complete, getTodayDate(config.timezone));
        const lines = [`${complete ? "Marked complete" : "Marked not complete"}: "${result.summary ?? occurrence.seriesId}" (${occurrence.instanceDate} ${occurrence.instanceTime}). Status now: ${result.status ?? "unknown"}.`];
        if (result.pointsBalance !== null) lines.push(`Points balance: ${result.pointsBalance}`);
        if (result.currentStreak !== null) lines.push(`Streak: ${result.currentStreak} (longest ${result.longestStreak ?? "unknown"})`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // delete_chore tool
  server.tool(
    "delete_chore",
    `Delete a chore from Skylight.

Use this when:
- Removing an old or irrelevant chore
- Deleting a chore that was added by mistake

Parameters:
- choreId (required): ID of the chore to delete (from get_chores)
- scope: required for recurring chores and routines (ids like 12345-2026-11-03-0600). "future" deletes this day and every later day ("Delete this and future tasks" in the app); "all" deletes the whole series ("Delete all tasks in series"). Ignored for one-off chores.
- confirm: must be true to delete; without it nothing is deleted and a preview is returned.

Note: This permanently removes the chore. Deleting a routine also loses its streak history. Skylight returns no body, so the tool reads the chores back and reports whether the occurrence is gone.`,
    {
      choreId: z.string().describe("ID of the chore to delete"),
      scope: z.enum(["future", "all"]).optional().describe("Recurring chores only: 'future' = this and later days, 'all' = the whole series"),
      confirm: z.boolean().optional().default(false).describe("Must be true to delete; otherwise only a preview is returned"),
    },
    async ({ choreId, scope, confirm }) => {
      try {
        const occurrence = parseOccurrenceId(choreId);
        if (occurrence) {
          if (!scope) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `"${choreId}" is a recurring chore or routine, so say how much to delete: scope "future" (this day and every later day) or scope "all" (the whole series). Nothing was changed.`,
                },
              ],
              isError: true,
            };
          }
          const what = scope === "all" ? `the whole series ${occurrence.seriesId} (every day, past and future)` : `${occurrence.instanceDate} and every later day of series ${occurrence.seriesId}`;
          if (!confirm) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Preview only, nothing deleted. Would permanently delete ${what}. If it is a habit-tracked routine, its streak history goes too. Call again with confirm: true after the user says yes.`,
                },
              ],
            };
          }
          await deleteChoreOccurrence(choreId, scope);
          let verdict = "Could not read the chores back to confirm.";
          try {
            const { chores } = await getChores({ after: occurrence.instanceDate, before: occurrence.instanceDate, includeLate: false, includeUpForGrabs: true });
            verdict = chores.some((c) => c.id === choreId) ? "Skylight accepted the request but the occurrence is still listed; check the app." : "Confirmed: it no longer appears.";
          } catch {
            // read-back is best effort; the delete itself already succeeded
          }
          return { content: [{ type: "text" as const, text: `Deleted ${what}. ${verdict}` }] };
        }
        if (scope) {
          return {
            content: [{ type: "text" as const, text: `scope only applies to recurring chores and routines; "${choreId}" is a one-off chore. Nothing was changed. Call again without scope.` }],
            isError: true,
          };
        }
        if (!confirm) {
          return {
            content: [{ type: "text" as const, text: `Preview only, nothing deleted. Would permanently delete chore ${choreId}. Call again with confirm: true after the user says yes.` }],
          };
        }
        await deleteChore(choreId);
        return { content: [{ type: "text" as const, text: `Deleted chore (ID: ${choreId})` }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );
}
