import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createTaskBoxItem, deleteTaskBoxItem, listTaskBoxItems } from "../api/endpoints/taskbox.js";
import { getChores } from "../api/endpoints/chores.js";
import { getConfig } from "../config.js";
import { getDateOffset, getTodayDate } from "../utils/dates.js";
import { formatErrorForMcp } from "../utils/errors.js";

export function registerTaskTools(server: McpServer): void {
  // get_task_box tool
  server.tool(
    "get_task_box",
    `List the Skylight task box.

The task box is a library of reusable chore and routine templates (for example "Take out trash" or "Brush teeth"), not scheduled work. Items have no assignee and no date; scheduling one creates a chore, which get_chores and get_week_overview show.

Use this when the user asks what is in the task box, or before adding a task to avoid a duplicate.`,
    {},
    async () => {
      try {
        const items = await listTaskBoxItems();
        if (items.length === 0) {
          return { content: [{ type: "text" as const, text: "The task box is empty." }] };
        }
        const line = (item: (typeof items)[number]): string => {
          const a = item.attributes;
          const extras: string[] = [];
          if (a.reward_points) extras.push(`${a.reward_points} points`);
          const emoji = a.emoji_icon ? `${a.emoji_icon} ` : "";
          return `- ${emoji}${a.summary}${extras.length ? ` (${extras.join(", ")})` : ""} (ID: ${item.id})`;
        };
        const chores = items.filter((i) => !i.attributes.routine);
        const routines = items.filter((i) => i.attributes.routine);
        const parts: string[] = [`Task box: ${items.length} items`];
        if (chores.length) parts.push("", "Chores:", ...chores.map(line));
        if (routines.length) parts.push("", "Routines:", ...routines.map(line));
        return { content: [{ type: "text" as const, text: parts.join("\n") }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // delete_task_box_item tool
  server.tool(
    "delete_task_box_item",
    `Delete one Task Box template by ID (from get_task_box).

Use this when a template is left over, for example after the app saved one when a chore was added ("Save to Task Box"), or when the user asks to remove a template.

The Task Box is a library of templates. A template and a scheduled chore are separate records with no link between them: deleting a template does not remove chores already scheduled from it (observed for a one-off chore), and deleting a chore does not remove its template. Nothing is ever matched by name; this deletes exactly the ID given.

Parameters:
- itemId (required): the template ID shown by get_task_box
- confirm: must be true to delete; without it nothing is deleted and a preview is returned. The preview names the template and lists scheduled chores with the same name over the next 90 days, labelled "same name, link unverified".

Note: This permanently removes the template. The tool reads the Task Box back afterwards and reports whether it is gone.`,
    {
      itemId: z.string().describe("ID of the Task Box item to delete (from get_task_box)"),
      confirm: z.boolean().optional().default(false).describe("Must be true to delete; otherwise only a preview is returned"),
    },
    async ({ itemId, confirm }) => {
      try {
        const items = await listTaskBoxItems();
        const item = items.find((i) => String(i.id) === itemId);
        if (!item) {
          return {
            content: [{ type: "text" as const, text: `No Task Box item with ID ${itemId}. Nothing deleted. Read the current IDs with get_task_box.` }],
            isError: true,
          };
        }
        const name = item.attributes.summary;
        const kind = item.attributes.routine ? "routine template" : "chore template";

        if (!confirm) {
          const tz = getConfig().timezone;
          const { chores } = await getChores({ after: getTodayDate(tz), before: getDateOffset(90, tz) });
          const same = chores.filter((c) => c.attributes.summary === name);
          const lines = [
            `Preview only, nothing deleted. Would permanently delete the ${kind} "${name}" (ID: ${itemId}).`,
            same.length > 0
              ? `Same name, link unverified: ${same.length} scheduled chore${same.length === 1 ? "" : "s"} named "${name}" in the next 90 days. They are separate records and would stay.`
              : `No scheduled chores named "${name}" in the next 90 days.`,
            "Call again with confirm: true after the user says yes.",
          ];
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }

        await deleteTaskBoxItem(itemId);
        const after = await listTaskBoxItems();
        const gone = !after.some((i) => String(i.id) === itemId);
        return {
          content: [
            {
              type: "text" as const,
              text: gone
                ? `Deleted ${kind} "${name}" (ID: ${itemId}). Read back: it is no longer in the Task Box.`
                : `Skylight accepted the delete but the Task Box still lists ID ${itemId}. Check get_task_box before retrying.`,
            },
          ],
          isError: !gone,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // create_task tool
  server.tool(
    "create_task",
    `Add a task to the Skylight task box.

The task box holds unscheduled tasks that can later be assigned to specific dates.

Use this when the user says:
- "Add XYZ to my task list"
- "Remind me to do ABC" (without a specific date)
- "Put 'clean garage' on the task box"

The task will appear on the Skylight display in the task box.`,
    {
      summary: z.string().describe("Task description"),
      emoji: z
        .string()
        .optional()
        .describe("Emoji icon for the task (e.g., '🧹', '📞')"),
      rewardPoints: z
        .number()
        .optional()
        .describe("Reward points for completing this task (for gamification)"),
      routine: z
        .boolean()
        .optional()
        .default(false)
        .describe("Is this a routine task?"),
    },
    async ({ summary, emoji, rewardPoints, routine }) => {
      try {
        const task = await createTaskBoxItem({
          summary,
          emojiIcon: emoji,
          rewardPoints,
          routine: routine ?? false,
        });

        const parts = [`Created task: "${task.attributes.summary}"`];

        if (task.attributes.emoji_icon) {
          parts.push(`Emoji: ${task.attributes.emoji_icon}`);
        }

        if (task.attributes.reward_points) {
          parts.push(`Reward points: ${task.attributes.reward_points}`);
        }

        parts.push(`\nThe task has been added to the Skylight task box.`);

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
}
