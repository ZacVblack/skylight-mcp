import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getCalendarEvents,
  getSourceCalendars,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  withFrameOffset,
} from "../api/endpoints/calendar.js";
import { getTodayDate, parseDate, formatDateForDisplay } from "../utils/dates.js";
import { formatErrorForMcp } from "../utils/errors.js";
import { formatAttribute, redactFeedUrl } from "../utils/redact.js";
import { checkCalendarName, readBackUntil, removeSourceCalendar, renameSourceCalendar, setSourceCalendarCategories } from "../api/endpoints/source-calendars.js";
import { getConfig } from "../config.js";
import { RepeatError, planRepeat } from "../utils/recurrence.js";
import { getCategories, resolveProfileIds } from "../api/endpoints/categories.js";
import type { CalendarEventResource } from "../api/types.js";

// Fields the event listing carries that identify people or accounts and tell a model nothing it
// can act on. Everything else is still printed, so new Skylight fields show up without a code change.
const HIDDEN_EVENT_FIELDS = new Set([
  "owner_email",
  "calendar_id",
  "calendar_account_id",
  "invited_emails",
  "uid",
  "supports_notification_settings",
]);

/** Profile names an event is assigned to, or [] when none or not determinable. */
export function eventProfileNames(
  event: CalendarEventResource,
  labelById: Map<string, string>
): string[] {
  const ids = new Set<string>();
  for (const ref of event.relationships?.categories?.data ?? []) if (ref?.id) ids.add(String(ref.id));
  const single = event.relationships?.category?.data?.id;
  if (single) ids.add(String(single));
  const fromAttrs = event.attributes.category_ids;
  if (Array.isArray(fromAttrs)) for (const id of fromAttrs) ids.add(String(id));
  return [...ids].map((id) => labelById.get(id)).filter((n): n is string => Boolean(n));
}

/** One event as text: no emails, calendar ids or UIDs, and the assigned profiles when known. */
export function formatEventForTool(event: CalendarEventResource, labelById: Map<string, string>): string {
  const parts: string[] = [];
  const who = eventProfileNames(event, labelById);
  if (who.length) parts.push(`  profiles: ${who.join(", ")}`);
  for (const [key, value] of Object.entries(event.attributes)) {
    if (HIDDEN_EVENT_FIELDS.has(key)) continue;
    if (value !== null && value !== undefined) parts.push(`  ${key}: ${formatAttribute(key, value)}`);
  }
  return `- Event (ID: ${event.id})\n${parts.join("\n")}`;
}

// A repeating event's occurrences have ids like 12345-1804032000: the series number, then the
// occurrence's start in UTC epoch seconds (captured 2026-11-07). A one-off event has a plain number.
const OCCURRENCE_ID = /^\d+-\d+$/;

const SCOPE_EFFECT: Record<"one" | "future" | "all", (date: string) => string> = {
  one: (date) => `ONLY the occurrence on ${date}`,
  future: (date) => `the occurrence on ${date} AND every later occurrence (the series would end before ${date})`,
  all: () => "the WHOLE series: every occurrence, past and future, including ones edited on their own",
};

/** Events from Skylight itself or a Google calendar are editable through Skylight's API (checked 2026-11-07); feeds are read-only. */
function assertWritableSource(a: Record<string, unknown>, title: string, verb: string): void {
  if (a.source !== "skylight" && a.source !== "google") {
    throw new Error(`"${title}" comes from ${String(a.source ?? "another calendar")}, a read-only subscription. Skylight cannot change it; change it at its source. Nothing was ${verb}.`);
  }
  if (a.editable === false) throw new Error(`"${title}" is not editable. Nothing was ${verb}.`);
}

/** The profile ids an event is currently assigned to (what the app re-sends with an edit). */
function eventCategoryIds(event: CalendarEventResource): string[] {
  const ids = new Set<string>();
  for (const ref of event.relationships?.categories?.data ?? []) if (ref?.id) ids.add(String(ref.id));
  const single = event.relationships?.category?.data?.id;
  if (single) ids.add(String(single));
  return [...ids];
}


const GOOGLE_LOOKAROUND_DAYS = 90;

/**
 * Resolve a linked Google calendar by its name (label) for a write. Skylight's create call
 * needs the Google calendar address (source_id) and a calendar account id; the account id is
 * not on the source-calendar record, so it is read from an existing event on that calendar
 * near the new event's date. Refuses rather than guesses. Ids stay inside the call: only the
 * label is ever shown.
 */
async function resolveGoogleTarget(name: string, startsAt: string, tz: string): Promise<{ label: string; calendarId: string; accountId: string }> {
  const want = name.trim().toLowerCase();
  const gmail = (await getSourceCalendars()).filter((c) => c.attributes.kind === "gmail");
  const labelOf = (c: (typeof gmail)[number]) => String(c.attributes.label ?? "").trim();
  const known = gmail.map(labelOf).join(", ") || "none";
  const matches = gmail.filter((c) => labelOf(c).toLowerCase() === want);
  if (matches.length === 0) throw new Error(`No linked Google calendar named "${name}". Linked Google calendars: ${known}. Nothing was created.`);
  if (matches.length > 1) throw new Error(`More than one linked Google calendar is named "${name}". Nothing was created.`);
  const cal = matches[0]!;
  if (cal.attributes.editable === false || cal.attributes.role === "reader") {
    throw new Error(`"${labelOf(cal)}" is read-only for this account, so events cannot be written to it. Nothing was created.`);
  }
  const calendarId = String(cal.attributes.source_id ?? "");
  if (!calendarId) throw new Error(`"${labelOf(cal)}" has no calendar address in Skylight. Nothing was created.`);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(startsAt.trim());
  const centre = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Date.now();
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const events = await getCalendarEvents({
    dateMin: iso(centre - GOOGLE_LOOKAROUND_DAYS * 86_400_000),
    dateMax: iso(centre + GOOGLE_LOOKAROUND_DAYS * 86_400_000),
    timezone: tz,
  });
  for (const e of events) {
    const a = e.attributes as Record<string, unknown>;
    if (a.calendar_id === calendarId && typeof a.calendar_account_id === "string" && a.calendar_account_id) {
      return { label: labelOf(cal), calendarId, accountId: a.calendar_account_id };
    }
  }
  throw new Error(`Cannot write to "${labelOf(cal)}": no existing event on it within ${GOOGLE_LOOKAROUND_DAYS} days of the new event, so its account cannot be determined. Add one event to it in the Skylight app, or ask without a calendar to use Skylight's own calendar. Nothing was created.`);
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function registerCalendarTools(server: McpServer, available?: ReadonlySet<string>): void {
  // get_calendar_events tool
  server.tool(
    "get_calendar_events",
    `Get calendar events from Skylight.

Use this to answer questions like:
- "What's on my calendar today?"
- "What do we have scheduled this weekend?"
- "Are there any events on Friday?"

Returns a list of events with their titles, times, and details.`,
    {
      date: z
        .string()
        .optional()
        .describe("Start date (YYYY-MM-DD or 'today', 'tomorrow', day name). Defaults to today."),
      dateEnd: z
        .string()
        .optional()
        .describe("End date (YYYY-MM-DD). Defaults to same as start date."),
    },
    async ({ date, dateEnd }) => {
      try {
        const config = getConfig();
        const startDate = date ? parseDate(date, config.timezone) : getTodayDate(config.timezone);
        const endDate = dateEnd ? parseDate(dateEnd, config.timezone) : startDate;

        const events = await getCalendarEvents({
          dateMin: startDate,
          dateMax: endDate,
          timezone: config.timezone,
        });

        if (events.length === 0) {
          const dateRange =
            startDate === endDate
              ? formatDateForDisplay(startDate)
              : `${formatDateForDisplay(startDate)} to ${formatDateForDisplay(endDate)}`;
          return {
            content: [
              {
                type: "text" as const,
                text: `No calendar events found for ${dateRange}.`,
              },
            ],
          };
        }

        // Profile names are a best-effort extra: a failed lookup must not hide the events.
        const labelById = new Map<string, string>();
        try {
          for (const c of await getCategories()) if (c.attributes.label) labelById.set(String(c.id), c.attributes.label);
        } catch {
          /* leave empty */
        }
        const eventList = events.map((event) => formatEventForTool(event, labelById)).join("\n\n");

        const dateRange =
          startDate === endDate
            ? formatDateForDisplay(startDate)
            : `${formatDateForDisplay(startDate)} to ${formatDateForDisplay(endDate)}`;

        return {
          content: [
            {
              type: "text" as const,
              text: `Calendar events for ${dateRange}:\n\n${eventList}`,
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

  // delete_source_calendar tool
  server.tool(
    "delete_source_calendar",
    `Stop syncing a subscribed calendar feed (a team, school or league schedule) to Skylight.

DESTRUCTIVE: the feed's events disappear from the family calendar and the wall display
until the feed is added again. The feed itself is not changed. Only subscribed feeds
(kind: webcal) can be removed here; a Google or other account calendar must be removed
in the Skylight app.

Two-step. Without confirm it only previews which calendar would go. Show the user the
name and get a clear yes before calling with confirm: true. After removing it reads the
list back and reports whether the calendar is really gone. Get the ID from
get_source_calendars. Feed addresses are never shown, only the host.`,
    {
      calendarId: z.string().describe("Numeric calendar ID from get_source_calendars."),
      confirm: z.boolean().optional().describe("Must be true to actually remove. Default false: preview only."),
    },
    async ({ calendarId, confirm }) => {
      try {
        const id = calendarId.trim();
        if (!/^\d+$/.test(id)) throw new Error("Calendar ID must be numeric (see get_source_calendars).");
        const calendars = await getSourceCalendars();
        const found = calendars.find((c) => String(c.id) === id);
        if (!found) throw new Error(`No synced calendar with ID ${id}. Use get_source_calendars to list them.`);
        const attrs = found.attributes as Record<string, unknown>;
        const label = typeof attrs.label === "string" ? attrs.label : `calendar ${id}`;
        if (attrs.kind !== "webcal") {
          throw new Error(
            `"${label}" is an account calendar (${String(attrs.kind)}), not a subscribed feed. Remove it in the Skylight app; this tool only removes feeds.`
          );
        }
        if (attrs.default_for_new_events === true) {
          throw new Error(`"${label}" is where new events are saved. Change that default in the Skylight app first.`);
        }
        const host = typeof attrs.source_id === "string" ? redactFeedUrl(attrs.source_id) : "feed";
        if (confirm !== true) {
          return {
            content: [
              {
                type: "text" as const,
                text: `NOT REMOVED. This would stop syncing "${label}" (${host}). Its events would disappear from the family calendar and the wall display until the feed is added again.\n\nIf the user approves, call delete_source_calendar again with confirm: true.`,
              },
            ],
          };
        }
        await removeSourceCalendar(id);
        const gone = await readBackUntil(getSourceCalendars, (list) => !list.some((c) => String(c.id) === id));
        if (!gone.ok) {
          throw new Error(`Skylight accepted the remove call but "${label}" is still listed. Do not assume it is gone; check the app.`);
        }
        return { content: [{ type: "text" as const, text: `Removed "${label}" (${host}). Confirmed gone from the synced calendars list.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatErrorForMcp(error) }], isError: true };
      }
    }
  );

  // update_source_calendar_profiles tool
  server.tool(
    "update_source_calendar_profiles",
    `Link a subscribed calendar feed (a team, school or league schedule) to family profiles, or unlink it.
This is the "Link profiles" checkboxes on the app's Edit Calendar screen: events from the feed
then show under those profiles' colors.

Two-step. Without confirm it previews who is linked now and who would be. Show the user and
get a clear yes before calling with confirm: true; the change shows on the family's devices.
Profile names are matched exactly (case-insensitive); an unknown or ambiguous name is rejected.
The calendar's label is never touched. Only subscribed feeds (kind: webcal) are supported.
After changing it reads the calendar back and reports what is really linked. Get the ID
from get_source_calendars. Feed addresses are never shown.`,
    {
      calendarId: z.string().describe("Numeric calendar ID from get_source_calendars."),
      link: z.array(z.string()).optional().describe("Profile names to link."),
      unlink: z.array(z.string()).optional().describe("Profile names to unlink."),
      confirm: z.boolean().optional().describe("Must be true to actually change. Default false: preview only."),
    },
    async ({ calendarId, link, unlink, confirm }) => {
      try {
        const id = calendarId.trim();
        if (!/^\d+$/.test(id)) throw new Error("Calendar ID must be numeric (see get_source_calendars).");
        if (!(link?.length || unlink?.length)) throw new Error("Give profile names to link or unlink.");
        const calendars = await getSourceCalendars();
        const found = calendars.find((c) => String(c.id) === id);
        if (!found) throw new Error(`No synced calendar with ID ${id}. Use get_source_calendars to list them.`);
        const attrs = found.attributes as Record<string, unknown>;
        const label = typeof attrs.label === "string" ? attrs.label : `calendar ${id}`;
        if (attrs.kind !== "webcal") {
          throw new Error(`"${label}" is an account calendar (${String(attrs.kind)}). Only subscribed feeds are supported here; use the Skylight app.`);
        }
        const currentData = found.relationships?.categories?.data;
        if (!Array.isArray(currentData)) {
          throw new Error(`Skylight did not report which profiles "${label}" is linked to, so nothing was changed.`);
        }
        const current = currentData.map((c) => String(c.id));
        const toLink = link?.length ? await resolveProfileIds(link) : { ids: [], labels: [] };
        const toUnlink = unlink?.length ? await resolveProfileIds(unlink) : { ids: [], labels: [] };
        const both = toLink.labels.filter((_, i) => toUnlink.ids.includes(toLink.ids[i]!));
        if (both.length > 0) throw new Error(`Cannot link and unlink the same profile: ${both.join(", ")}.`);
        const wanted = [...new Set([...current, ...toLink.ids])].filter((c) => !toUnlink.ids.includes(c));
        if (wanted.length === 0) {
          throw new Error(`That would leave "${label}" with no profile or label at all, which has not been verified against Skylight. Nothing was changed.`);
        }
        const all = await getCategories();
        const nameOf = (cid: string): string => all.find((c) => c.id === cid)?.attributes.label ?? `category ${cid}`;
        const isProfile = (cid: string): boolean => all.find((c) => c.id === cid)?.attributes.linked_to_profile === true;
        const describe = (ids: string[]): string => {
          const profiles = ids.filter(isProfile).map(nameOf);
          const labels = ids.filter((c) => !isProfile(c)).map(nameOf);
          return `profiles: ${profiles.join(", ") || "none"}${labels.length ? `; labels kept: ${labels.join(", ")}` : ""}`;
        };
        const same = wanted.length === current.length && wanted.every((c) => current.includes(c));
        if (same) {
          return { content: [{ type: "text" as const, text: `No change needed. "${label}" is already linked this way (${describe(current)}).` }] };
        }
        if (confirm !== true) {
          return {
            content: [
              {
                type: "text" as const,
                text: `NOT CHANGED. "${label}"\nNow:   ${describe(current)}\nAfter: ${describe(wanted)}\n\nIf the user approves, call update_source_calendar_profiles again with the same arguments and confirm: true.`,
              },
            ],
          };
        }
        await setSourceCalendarCategories(id, wanted);
        const idsOf = (list: Awaited<ReturnType<typeof getSourceCalendars>>): string[] =>
          (list.find((c) => String(c.id) === id)?.relationships?.categories?.data ?? []).map((c) => String(c.id));
        const matches = (list: Awaited<ReturnType<typeof getSourceCalendars>>): boolean => {
          const got = idsOf(list);
          return got.length === wanted.length && wanted.every((c) => got.includes(c));
        };
        const settled = await readBackUntil(getSourceCalendars, matches);
        const afterIds = idsOf(settled.value);
        if (!settled.ok) {
          throw new Error(`Skylight accepted the change but "${label}" now shows ${describe(afterIds)}, not what was asked. Check the app.`);
        }
        return { content: [{ type: "text" as const, text: `Updated "${label}". Now ${describe(afterIds)}. Confirmed by reading it back.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatErrorForMcp(error) }], isError: true };
      }
    }
  );

  // rename_source_calendar tool
  server.tool(
    "rename_source_calendar",
    `Rename a subscribed calendar feed (a team, school or league schedule) as it appears in Skylight.
Skylight names a feed from the feed itself, which is often long; this shortens it. The feed
and its events are not changed. Only subscribed feeds (kind: webcal) are supported.

Two-step. Without confirm it previews the old and new name. Show the user and get a clear yes
before calling with confirm: true; the new name shows on the family's devices. After renaming
it reads the calendar back and checks the name changed and the linked profiles did not.
Get the ID from get_source_calendars. Feed addresses are never shown.`,
    {
      calendarId: z.string().describe("Numeric calendar ID from get_source_calendars."),
      name: z.string().describe("The new name, plain text, up to 100 characters."),
      confirm: z.boolean().optional().describe("Must be true to actually rename. Default false: preview only."),
    },
    async ({ calendarId, name, confirm }) => {
      try {
        const id = calendarId.trim();
        if (!/^\d+$/.test(id)) throw new Error("Calendar ID must be numeric (see get_source_calendars).");
        const check = checkCalendarName(name);
        if (!check.ok) throw new Error(check.reason);
        const found = (await getSourceCalendars()).find((c) => String(c.id) === id);
        if (!found) throw new Error(`No synced calendar with ID ${id}. Use get_source_calendars to list them.`);
        const attrs = found.attributes as Record<string, unknown>;
        const oldName = typeof attrs.label === "string" ? attrs.label : `calendar ${id}`;
        if (attrs.kind !== "webcal") {
          throw new Error(`"${oldName}" is an account calendar (${String(attrs.kind)}). Only subscribed feeds are supported here; use the Skylight app.`);
        }
        if (oldName === check.name) {
          return { content: [{ type: "text" as const, text: `No change needed. The calendar is already called "${oldName}".` }] };
        }
        if (confirm !== true) {
          return {
            content: [
              {
                type: "text" as const,
                text: `NOT RENAMED. "${oldName}" would become "${check.name}".\n\nIf the user approves, call rename_source_calendar again with the same arguments and confirm: true.`,
              },
            ],
          };
        }
        const linkedBefore = (found.relationships?.categories?.data ?? []).map((c) => String(c.id)).sort();
        await renameSourceCalendar(id, check.name);
        const nameIn = (list: Awaited<ReturnType<typeof getSourceCalendars>>): unknown =>
          (list.find((c) => String(c.id) === id)?.attributes as Record<string, unknown> | undefined)?.label;
        const renamed = await readBackUntil(getSourceCalendars, (list) => nameIn(list) === check.name);
        const after = renamed.value.find((c) => String(c.id) === id);
        const afterName = nameIn(renamed.value);
        if (!renamed.ok) {
          throw new Error(`Skylight accepted the rename but the calendar is still called "${String(afterName)}". Check the app.`);
        }
        const linkedAfter = (after?.relationships?.categories?.data ?? []).map((c) => String(c.id)).sort();
        if (linkedBefore.join(",") !== linkedAfter.join(",")) {
          throw new Error(`Renamed to "${check.name}", but its linked profiles changed unexpectedly. Check the calendar in the app.`);
        }
        return { content: [{ type: "text" as const, text: `Renamed "${oldName}" to "${check.name}". Confirmed by reading it back; linked profiles unchanged.` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatErrorForMcp(error) }], isError: true };
      }
    }
  );

  // Name only the tools this server actually exposes (the hosted server omits the feed-removal tool).
  const manageTools = joinNames(["rename_source_calendar", "update_source_calendar_profiles", "delete_source_calendar"].filter((n) => !available || available.has(n)));

  // get_source_calendars tool
  server.tool(
    "get_source_calendars",
    `Get connected calendar sources synced to Skylight.

Use this to answer:
- "Which calendars are synced to Skylight?"
- "What calendar accounts are connected?"

Returns a list of connected calendar sources (Google, iCloud, etc.).

Ways to add a calendar in Skylight's "Sync Calendar" screen, and what this server can do:
- Calendar URL (a subscription link: a team, school, league or iCloud published calendar):
  the user runs "skylight-mcp calendars add" in a terminal (the link is a secret, so it is
  never typed into chat). Once added, ${manageTools} manage it.
- Google, Outlook/Hotmail/Live, iCloud, Cozi, TeamSnap: the user signs in inside the Skylight
  app. Not possible here. Calendars added this way (kind: gmail) can be read but not removed here.
- US Holidays and Individual Events: set up in the app (a built-in feed and local events).
Only feeds (kind: webcal) are one-way; Skylight cannot write back to them.`,
    {},
    async () => {
      try {
        const calendars = await getSourceCalendars();

        if (calendars.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No calendar sources are connected to Skylight.",
              },
            ],
          };
        }

        const calendarList = calendars
          .map((cal) => {
            const attrs = cal.attributes;
            const parts: string[] = [`- Calendar (ID: ${cal.id})`];

            for (const [key, value] of Object.entries(attrs)) {
              if (value !== null && value !== undefined) {
                // Feed URLs are bearer-like secrets; show only the host.
                parts.push(`  ${key}: ${formatAttribute(key, value)}`);
              }
            }

            return parts.join("\n");
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Connected calendar sources:\n\n${calendarList}`,
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

  // create_calendar_event tool
  server.tool(
    "create_calendar_event",
    `Create a new calendar event in Skylight.

Use this when:
- Scheduling a new event: "Add a dentist appointment on Friday at 2pm"
- Creating family activities: "Schedule soccer practice every Saturday at 10am"
- Adding reminders: "Put Mom's birthday on the calendar"

Parameters:
- summary (required): Event title (e.g., "Dentist Appointment")
- startsAt (required): Start time in ISO format or natural language
- endsAt (required): End time in ISO format or natural language
- allDay: Set to true for all-day events
- description: Additional notes for the event
- location: Where the event takes place
- profiles: Profile names to assign (e.g. ["Alex"]); categoryIds is the ID fallback
- repeat: makes a repeating series. { frequency: "daily" | "weekly", interval (weekly 1-4, daily 1-7), byDay (weekly; must be the weekday of startsAt), and exactly one of until (YYYY-MM-DD, inclusive) or count }. Max 104 occurrences and 2 years; no open-ended series; no monthly or yearly yet.
- calendar: name of a linked Google calendar (see get_source_calendars, kind gmail). Only when the person asks for it. Omit it and the event goes to Skylight's own calendar, which does NOT appear in Google. With it the event (or series) is written to that Google calendar and shows for everyone who shares it, so it needs confirm: true like a series.
- confirm: required for a series or when calendar is given. Without confirm: true nothing is created; you get a preview (a series lists every date; a calendar names it). Show it to the person, get their yes, then call again with confirm: true.

REPEATING SERIES: give startsAt/endsAt as local times with no offset; all-day and more than one profile are refused. Without calendar the series is created on Skylight's own calendar (verified live 2026-11-08): it shows on the Skylight displays and app, and is NOT written to Google, so people who only use Google Calendar will not see it. With calendar it is written to that Google calendar (not yet verified live). This tool does not check conflicts: call find_conflicts over the series dates first. To undo a series, delete_calendar_event with scope "all".

Returns: The created event details.

Related: get_family_members lists the profile names and IDs.`,
    {
      summary: z.string().describe("Event title (e.g., 'Dentist Appointment')"),
      startsAt: z.string().describe("Start time (ISO format like '2025-01-15T14:00:00')"),
      endsAt: z.string().describe("End time (ISO format like '2025-01-15T15:00:00')"),
      allDay: z.boolean().optional().default(false).describe("True for all-day events"),
      description: z.string().optional().describe("Additional notes for the event"),
      location: z.string().optional().describe("Event location"),
      profiles: z.array(z.string()).optional().describe("Profile names to assign, e.g. [\"Alex\", \"Jordan\"] (see get_family_members)."),
      categoryIds: z.array(z.string()).optional().describe("Profile IDs to assign. Prefer profiles."),
      repeat: z
        .object({
          frequency: z.enum(["daily", "weekly"]),
          interval: z.number().int().optional(),
          byDay: z.enum(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]).optional(),
          until: z.string().optional().describe("Last date, YYYY-MM-DD, inclusive"),
          count: z.number().int().optional().describe("Number of occurrences"),
        })
        .strict()
        .optional()
        .describe("Make this a repeating series (see the tool description)."),
      calendar: z.string().optional().describe("Name of a linked Google calendar to write to (see get_source_calendars). Only when the person asks; default is Skylight's own calendar."),
      confirm: z.boolean().optional().describe("Series or calendar only: must be true to create; otherwise a preview is returned."),
    },
    async ({ summary, startsAt, endsAt, allDay, description, location, profiles, categoryIds, repeat, calendar, confirm }) => {
      try {
        const config = getConfig();
        if (profiles?.length && categoryIds?.length) throw new Error("Give profiles or categoryIds, not both.");
        const resolved = profiles?.length ? (await resolveProfileIds(profiles)).ids : categoryIds;
        const target = calendar ? await resolveGoogleTarget(calendar, startsAt, config.timezone) : undefined;
        const destination = target
          ? `Goes to the Google calendar "${target.label}": it shows for everyone who shares that calendar, with Google's default reminders. Delete it later with delete_calendar_event.`
          : "Goes to Skylight's own calendar: it shows on the Skylight displays and app and is not written to Google.";
        let rrule: string[] | undefined;
        if (repeat) {
          if (allDay) throw new RepeatError("All-day repeating events are not supported yet; use the Skylight app.");
          if ((resolved?.length ?? 0) > 1) throw new RepeatError("A repeating series with more than one profile is not supported yet; give one profile or none.");
          const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?$/.exec(startsAt.trim());
          if (!m) throw new RepeatError("For a repeating event give startsAt as local time YYYY-MM-DDTHH:MM with no offset or Z.");
          const startMs = Date.parse(withFrameOffset(startsAt, config.timezone));
          const endMs = Date.parse(withFrameOffset(endsAt, config.timezone));
          if (Number.isNaN(endMs) || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/.test(endsAt.trim())) {
            throw new RepeatError("For a repeating event give endsAt as local time YYYY-MM-DDTHH:MM with no offset or Z.");
          }
          const plan = planRepeat(repeat, m[1]!, m[2]!, endMs <= startMs, config.timezone, Date.now());
          rrule = [plan.rrule];
          if (confirm !== true) {
            const dates = plan.occurrences.map((o) => o.date);
            return {
              content: [
                {
                  type: "text" as const,
                  text: [
                    `PREVIEW, nothing created. "${summary}" would repeat ${repeat.frequency} (every ${repeat.interval ?? 1}), ${dates.length} occurrence${dates.length === 1 ? "" : "s"}, ${startsAt.trim().slice(11, 16)} to ${endsAt.trim().slice(11, 16)} (${config.timezone}).`,
                    `Dates: ${dates.join(", ")}`,
                    profiles?.length ? `Profile: ${profiles.join(", ")}` : "Profile: none",
                    destination,
                    "Conflicts were not checked by this tool; run find_conflicts over these dates first.",
                    "To create it, show this to the person and call again with the same arguments and confirm: true. To undo later: delete_calendar_event with scope \"all\".",
                  ].join("\n"),
                },
              ],
            };
          }
        } else if (target) {
          if (confirm !== true) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: [
                    `PREVIEW, nothing created. "${summary}", ${startsAt.trim()} to ${endsAt.trim()} (${config.timezone})${allDay ? ", all day" : ""}.`,
                    profiles?.length ? `Profile: ${profiles.join(", ")}` : "Profile: none",
                    destination,
                    "Conflicts were not checked by this tool; run find_conflicts first.",
                    "To create it, show this to the person and call again with the same arguments and confirm: true.",
                  ].join("\n"),
                },
              ],
            };
          }
        } else if (confirm !== undefined) {
          throw new Error("confirm applies to repeating series and to events written to a Google calendar only.");
        }
        const event = await createCalendarEvent({
          summary,
          starts_at: withFrameOffset(startsAt, config.timezone),
          ends_at: withFrameOffset(endsAt, config.timezone),
          all_day: allDay,
          description,
          location,
          category_ids: resolved,
          timezone: config.timezone,
          kind: "standard",
          ...(rrule ? { rrule } : {}),
          ...(target ? { calendar_id: target.calendarId, calendar_account_id: target.accountId } : {}),
        });

        return {
          content: [
            {
              type: "text" as const,
              text: rrule
                ? `Created repeating series "${summary}" (ID: ${event.id}, rule ${rrule[0]})${target ? ` on the Google calendar "${target.label}"` : ""}. Read it back with get_calendar_events before telling anyone it is done.`
                : `Created calendar event "${summary}" (ID: ${event.id})${target ? ` on the Google calendar "${target.label}". Read it back with get_calendar_events before telling anyone it is done` : ""}`,
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

  // update_calendar_event tool
  server.tool(
    "update_calendar_event",
    `Update an existing calendar event.

Use this when:
- Changing event time: "Move the dentist appointment to 3pm"
- Updating event details: "Add location to the meeting"
- Renaming an event: "Change 'Doctor' to 'Dr. Smith checkup'"

Parameters:
- eventId (required): ID of the event to update (from get_calendar_events)
- summary: New title for the event
- startsAt: New start time (ISO format)
- endsAt: New end time (ISO format)
- description: Updated notes
- location: Updated location
- profiles / categoryIds: Updated family member assignments

REPEATING EVENTS (the id looks like 12345-1804032000): also give
- date (required): the occurrence's date, YYYY-MM-DD, from get_calendar_events
- scope (required): "one" changes only that occurrence (it becomes its own event, detached from the series); "all" changes the whole series AND overwrites any earlier edit made to a single occurrence. There is no "future" scope: Skylight's API refuses it, so do not offer it.
For a repeating event only the title (summary), the family member assignment and the time of day (startsAt and endsAt, both on the occurrence's date) can be changed here; notes, location and all-day edits on a series have not been verified, so make those in the Skylight app. A time change is verified live for both scopes: "all" moves every occurrence and keeps one series; "one" detaches that occurrence as its own event at the new time and leaves the rest of the series alone. Ids change (series occurrence ids embed the start time; a detached event gets a new plain id), so always re-read before the next call.
Events on a Google calendar are updated at Google too, for everyone who shares that calendar.

Returns: The updated event details.`,
    {
      eventId: z.string().describe("ID of the event to update"),
      summary: z.string().optional().describe("New event title"),
      startsAt: z.string().optional().describe("New start time (ISO format)"),
      endsAt: z.string().optional().describe("New end time (ISO format)"),
      allDay: z.boolean().optional().describe("Change to all-day event"),
      description: z.string().optional().describe("Updated notes"),
      location: z.string().optional().describe("Updated location"),
      profiles: z.array(z.string()).optional().describe("Profile names to assign instead of the current ones, e.g. [\"Alex\"]."),
      categoryIds: z.array(z.string()).optional().describe("Profile IDs to assign. Prefer profiles."),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Repeating events only: the occurrence's date, YYYY-MM-DD"),
      scope: z.enum(["one", "all"]).optional().describe("Repeating events only: \"one\" = this occurrence only; \"all\" = the whole series (overwrites earlier single-occurrence edits). No \"future\": Skylight refuses it."),
    },
    async ({ eventId, summary, startsAt, endsAt, allDay, description, location, profiles, categoryIds, date, scope }) => {
      try {
        if (profiles?.length && categoryIds?.length) throw new Error("Give profiles or categoryIds, not both.");
        const tz = getConfig().timezone;
        const repeating = OCCURRENCE_ID.test(eventId);

        if (!repeating && scope) {
          throw new Error(`scope only applies to repeating events (ids like 12345-1804032000); "${eventId}" is not one. Nothing was changed. Call again without scope.`);
        }

        if (repeating) {
          if (!scope) {
            throw new Error(`"${eventId}" is an occurrence of a repeating event, so say how much to change: scope "one" (only that occurrence) or scope "all" (the whole series, overwriting earlier single-occurrence edits). "future" is not available: Skylight refuses it. Nothing was changed.`);
          }
          if (!date) throw new Error(`A repeating event needs the occurrence's date (YYYY-MM-DD, from get_calendar_events). Nothing was changed.`);
          if (allDay !== undefined || description !== undefined || location !== undefined) {
            throw new Error("For a repeating event only the title, the family member assignment and the start and end time can be changed here; all-day, notes and location edits on a series are not verified. Make those in the Skylight app. Nothing was changed.");
          }
          if ((startsAt === undefined) !== (endsAt === undefined)) {
            throw new Error("To change a repeating event's time give both startsAt and endsAt. Nothing was changed.");
          }
          if (startsAt !== undefined && endsAt !== undefined) {
            const timeRe = /^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}(?::\d{2})?$/;
            const sm = timeRe.exec(startsAt.trim());
            const em = timeRe.exec(endsAt.trim());
            if (!sm || !em) throw new Error("For a repeating event give startsAt and endsAt as local times YYYY-MM-DDTHH:MM with no offset or Z. Nothing was changed.");
            if (sm[1] !== date || em[1] !== date) {
              throw new Error(`A time change on a repeating event keeps its date: startsAt and endsAt must be on the occurrence's date (${date}); only the time of day changes. Nothing was changed.`);
            }
            if (Date.parse(withFrameOffset(endsAt, tz)) <= Date.parse(withFrameOffset(startsAt, tz))) {
              throw new Error("endsAt must be after startsAt. Nothing was changed.");
            }
          }
          if (summary === undefined && !profiles?.length && categoryIds === undefined && startsAt === undefined) {
            throw new Error("Nothing to change: give a new summary, profiles or a new start and end time. Nothing was changed.");
          }
          const dayEvents = await getCalendarEvents({ dateMin: date, dateMax: date, timezone: tz });
          const event = dayEvents.find((e) => String(e.id) === eventId);
          if (!event) throw new Error(`No event with ID ${eventId} on ${date}. Nothing was changed. Check the ID and date with get_calendar_events.`);
          const a = event.attributes as Record<string, unknown>;
          const title = String(a.summary ?? "(untitled)");
          assertWritableSource(a, title, "changed");
          if (a.master_event_id || !(a.recurring === true || a.recurring_config === true)) {
            throw new Error(`"${title}" is not an occurrence of a repeating series. Nothing was changed.`);
          }
          // The Skylight app always sends the profile assignment with an edit; send the current
          // one unless a new one was asked for, so a title change cannot clear it.
          const current = eventCategoryIds(event);
          const categoryIdsToSend = profiles?.length ? (await resolveProfileIds(profiles)).ids : categoryIds !== undefined ? categoryIds : current;
          const updates: Record<string, unknown> = { category_ids: categoryIdsToSend };
          if (summary !== undefined) updates.summary = summary;
          if (startsAt !== undefined && endsAt !== undefined) {
            updates.starts_at = withFrameOffset(startsAt, tz);
            updates.ends_at = withFrameOffset(endsAt, tz);
            updates.timezone = tz;
          }
          const updated = await updateCalendarEvent(eventId, updates, scope);
          const newTitle = String((updated.attributes as Record<string, unknown>).summary ?? title);
          const what = scope === "one"
            ? `only the occurrence on ${date}; it is now its own event, detached from the series. Skylight's reply does not carry the new event's ID, so read it back with get_calendar_events (the ID changes) before editing or deleting it`
            : `the whole series (every occurrence, including any that had been edited on their own)`;
          return {
            content: [{ type: "text" as const, text: `Updated "${title}" to "${newTitle}": ${what}.` }],
          };
        }

        const updates: Record<string, unknown> = {};
        if (summary !== undefined) updates.summary = summary;
        if (startsAt !== undefined) updates.starts_at = withFrameOffset(startsAt, tz);
        if (endsAt !== undefined) updates.ends_at = withFrameOffset(endsAt, tz);
        if (allDay !== undefined) updates.all_day = allDay;
        if (description !== undefined) updates.description = description;
        if (location !== undefined) updates.location = location;
        if (profiles?.length) updates.category_ids = (await resolveProfileIds(profiles)).ids;
        else if (categoryIds !== undefined) updates.category_ids = categoryIds;

        const event = await updateCalendarEvent(eventId, updates);

        return {
          content: [
            {
              type: "text" as const,
              text: `Updated calendar event (ID: ${event.id})`,
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

  // delete_calendar_event tool
  server.tool(
    "delete_calendar_event",
    `Delete one calendar event, or part of a repeating one. Preview first, then confirm.

Use this when:
- Canceling an event: "Remove the dentist appointment"
- Ending a repeating event: "Cancel soccer from March 30 on"
- Undoing an event this server created by mistake

Parameters:
- eventId (required): ID of the event (from get_calendar_events). For a repeating event this is the occurrence's id, like 12345-1804032000.
- date (required): the event's date, YYYY-MM-DD (used to find and show the event)
- scope: REQUIRED for a repeating event, not allowed for a one-off one. "one" deletes only that occurrence; "future" deletes it and every later one (the series ends before it); "all" deletes the whole series, past and future, including occurrences edited on their own.
- confirm: must be true to delete. Without it nothing is deleted and the event is shown.

Always show the user the preview and wait for a yes to that exact event and scope before calling again with confirm: true. It cannot be undone.
Events on a Google calendar are deleted at Google too, for everyone who shares that calendar.

Refused, with the reason: events from a subscribed feed (read-only), events that are not editable, an occurrence that was edited on its own (delete it in the Skylight app; not verified), and a repeating event with no scope.`,
    {
      eventId: z.string().describe("ID of the event to delete"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("The event's date, YYYY-MM-DD"),
      scope: z.enum(["one", "future", "all"]).optional().describe("Repeating events only: \"one\" = this occurrence; \"future\" = this and every later one; \"all\" = the whole series"),
      confirm: z.boolean().optional().default(false).describe("Must be true to delete; otherwise only a preview is returned"),
    },
    async ({ eventId, date, scope, confirm }) => {
      try {
        const tz = getConfig().timezone;
        const dayEvents = await getCalendarEvents({ dateMin: date, dateMax: date, timezone: tz });
        const event = dayEvents.find((e) => String(e.id) === eventId);
        if (!event) throw new Error(`No event with ID ${eventId} on ${date}. Nothing was deleted. Check the ID and date with get_calendar_events.`);

        const a = event.attributes as Record<string, unknown>;
        const title = String(a.summary ?? "(untitled)");
        assertWritableSource(a, title, "deleted");
        if (a.master_event_id) {
          throw new Error(`"${title}" is an occurrence that was edited on its own, and what a delete does to it is not verified. Nothing was deleted. Delete it in the Skylight app.`);
        }
        const series = a.recurring === true || a.recurring_config === true;
        if (series && !scope) {
          throw new Error(`"${title}" is a repeating event, so say how much to delete: scope "one" (only ${date}), "future" (${date} and every later one) or "all" (the whole series). Nothing was deleted.`);
        }
        if (!series && scope) {
          throw new Error(`scope only applies to repeating events; "${title}" is a one-off event. Nothing was deleted. Call again without scope.`);
        }

        const labelById = new Map<string, string>();
        try {
          for (const c of await getCategories()) if (c.attributes.label) labelById.set(String(c.id), c.attributes.label);
        } catch {
          /* names are a best-effort extra */
        }
        const shown = formatEventForTool(event, labelById);
        const effect = scope ? SCOPE_EFFECT[scope](date) : "this one event";
        const shared = a.source === "google" ? "\nIt is synced from a Google calendar, so this also removes it there, for everyone who shares that calendar." : "";

        if (!confirm) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Preview only, nothing deleted. This would permanently delete ${effect}:\n\n${shown}${shared}\n\nShow the user this event and the scope. If they say yes to exactly this, call delete_calendar_event again with the same eventId, date${scope ? ", scope" : ""} and confirm: true.`,
              },
            ],
          };
        }

        await deleteCalendarEvent(eventId, scope);
        const check = await readBackUntil(
          () => getCalendarEvents({ dateMin: date, dateMax: date, timezone: tz }),
          (list) => !list.some((e) => String(e.id) === eventId)
        );
        if (!check.ok) {
          throw new Error(`The delete was sent but "${title}" still shows on ${date}. Check the Skylight app before trying again.`);
        }
        return {
          content: [{ type: "text" as const, text: `Deleted ${effect}: "${title}" (ID: ${eventId}). Confirmed gone by reading ${date} back.` }],
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
