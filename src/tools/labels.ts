/**
 * Calendar labels: the categories that are not family members.
 *
 * The iOS app can delete a label (Manage Label > Delete Label); the web app
 * cannot (its Manage Label shows only Convert to Profile and a Merge that never
 * enables; both seen 2026-11-03). The iOS dialog states the effect, and this
 * tool repeats it: events that carry ONLY this label are removed from Skylight;
 * events with another profile or label stay and lose this one; a calendar synced
 * only for this label is unsynced. Two guards never relax: a profile is never
 * deleted, and a label a synced calendar writes to is never deleted (that would
 * unsync the feed).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deleteCategory, getCategories, labelDeleteRefusal } from "../api/endpoints/categories.js";
import { getCalendarEvents } from "../api/endpoints/calendar.js";
import { readBackUntil } from "../api/endpoints/source-calendars.js";
import { getConfig } from "../config.js";
import { getTodayDate } from "../utils/dates.js";
import { formatErrorForMcp } from "../utils/errors.js";
import type { CalendarEventResource, CategoryResource } from "../api/types.js";

const LOOKAHEAD_DAYS = 365;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function categoryIdsOf(event: CalendarEventResource): string[] {
  const ids = new Set<string>();
  for (const ref of event.relationships?.categories?.data ?? []) if (ref?.id) ids.add(String(ref.id));
  const single = event.relationships?.category?.data?.id;
  if (single) ids.add(String(single));
  const fromAttrs = event.attributes.category_ids;
  if (Array.isArray(fromAttrs)) for (const id of fromAttrs) ids.add(String(id));
  return [...ids];
}

interface LabelUsage {
  /** Upcoming events that carry the label at all. */
  counts: Map<string, number>;
  /** Upcoming events that carry ONLY this label: the ones a delete removes. */
  sole: Map<string, CalendarEventResource[]>;
}

/** Usage per category id, from one list call over the next year. */
async function labelUsage(): Promise<LabelUsage> {
  const tz = getConfig().timezone;
  const today = getTodayDate(tz);
  const events = await getCalendarEvents({ dateMin: today, dateMax: addDays(today, LOOKAHEAD_DAYS), timezone: tz });
  const counts = new Map<string, number>();
  const sole = new Map<string, CalendarEventResource[]>();
  for (const e of events) {
    const ids = categoryIdsOf(e);
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    if (ids.length === 1) {
      const list = sole.get(ids[0]!) ?? [];
      list.push(e);
      sole.set(ids[0]!, list);
    }
  }
  return { counts, sole };
}

function eventLine(e: CalendarEventResource): string {
  const when = e.attributes.all_day ? String(e.attributes.starts_at ?? "").slice(0, 10) : String(e.attributes.starts_at ?? "").slice(0, 16).replace("T", " ");
  return `  - ${when} ${e.attributes.summary ?? "(untitled)"} [event ID: ${e.id}]`;
}

function isLabel(cat: CategoryResource): boolean {
  return !cat.attributes.linked_to_profile;
}

function describe(cat: CategoryResource, count: number): string {
  const feeds = cat.relationships?.source_calendars?.data ?? [];
  const bits = [`${count} upcoming event${count === 1 ? "" : "s"} in the next ${LOOKAHEAD_DAYS} days`];
  if (feeds.length > 0) bits.push(`written to by ${feeds.length} synced calendar${feeds.length === 1 ? "" : "s"}`);
  return `- ${cat.attributes.label ?? "(unnamed)"} [label ID: ${cat.id}]: ${bits.join(", ")}`;
}

export function registerLabelTools(server: McpServer): void {
  server.tool(
    "get_labels",
    `List the calendar labels (groupings such as a team, a school year or a holiday feed; not family members) with how many upcoming events use each.

Use this to answer:
- "Which labels are still in use?"
- "Which labels can be cleaned up?"

A label with no upcoming events and no synced calendar is unused. Labels are not profiles: get_family_members lists the people.`,
    {},
    async () => {
      try {
        const [cats, { counts }] = await Promise.all([getCategories(false), labelUsage()]);
        const labels = cats.filter(isLabel);
        if (labels.length === 0) return { content: [{ type: "text" as const, text: "No labels." }] };
        const lines = labels
          .sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || (a.attributes.label ?? "").localeCompare(b.attributes.label ?? ""))
          .map((c) => describe(c, counts.get(c.id) ?? 0));
        return { content: [{ type: "text" as const, text: `Labels:\n${lines.join("\n")}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatErrorForMcp(error) }], isError: true };
      }
    }
  );

  server.tool(
    "delete_label",
    `Delete one calendar label. Preview first, then confirm. The Skylight app cannot do this.

Parameters:
- labelId (required): from get_labels
- confirm: must be true to delete. Without it nothing is deleted and the label is shown with its upcoming-event count.

Always show the user the preview and wait for a yes to that exact label before calling again with confirm: true.

What a delete does (as the Skylight app states it): events that carry ONLY this label are removed from Skylight; events that also have a profile or another label stay and lose this one. The preview lists the upcoming events that would be removed.

Refused, with the reason, even with confirm: a profile (a family member), and a label a synced calendar still writes to (deleting it would unsync that calendar).`,
    {
      labelId: z.string().regex(/^\d+$/).describe("Label ID from get_labels"),
      confirm: z.boolean().default(false).describe("Must be true to delete; otherwise only a preview is returned"),
    },
    async ({ labelId, confirm }) => {
      const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
      try {
        const cats = await getCategories(false);
        const cat = cats.find((c) => c.id === labelId);
        if (!cat) return fail(`No label with ID ${labelId}. Nothing was deleted. Check get_labels.`);
        const refusal = labelDeleteRefusal(cat);
        if (refusal) return fail(`${refusal} Nothing was deleted.`);
        const { counts, sole } = await labelUsage();
        const count = counts.get(cat.id) ?? 0;
        const removed = sole.get(cat.id) ?? [];
        const shared = count - removed.length;
        const line = describe(cat, count);
        const effect = [
          removed.length > 0
            ? `${removed.length} upcoming event${removed.length === 1 ? " carries" : "s carry"} only this label and would be REMOVED from Skylight:\n${removed.map(eventLine).join("\n")}`
            : "No upcoming event carries only this label, so no event would be removed.",
          shared > 0 ? `${shared} upcoming event${shared === 1 ? " also has a profile or another label; it stays and loses" : "s also have a profile or another label; they stay and lose"} this label.` : "",
          "Past events are not shown here; the same rule applies to them.",
        ].filter(Boolean).join("\n");
        if (!confirm) {
          return {
            content: [{
              type: "text" as const,
              text: `Preview only, nothing deleted. This would permanently delete the label:\n${line}\n\n${effect}\n\nShow the user this. If they say yes to exactly this label, call delete_label again with the same labelId and confirm: true.`,
            }],
          };
        }
        await deleteCategory(cat.id);
        const back = await readBackUntil(() => getCategories(false), (all) => !all.some((c) => c.id === cat.id));
        if (!back.ok) {
          return fail(`Skylight accepted the delete but "${cat.attributes.label}" still shows in the label list. Check the Skylight app.`);
        }
        return { content: [{ type: "text" as const, text: `Deleted label "${cat.attributes.label}" (ID: ${cat.id})${removed.length > 0 ? `, and with it ${removed.length} upcoming event${removed.length === 1 ? "" : "s"} that carried only this label` : ""}. Confirmed gone by reading the label list back.` }] };
      } catch (error) {
        return fail(formatErrorForMcp(error));
      }
    }
  );
}
