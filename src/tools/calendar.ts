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

export function registerCalendarTools(server: McpServer): void {
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
  never typed into chat). Once added, rename_source_calendar, update_source_calendar_profiles
  and delete_source_calendar manage it.
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
    },
    async ({ summary, startsAt, endsAt, allDay, description, location, profiles, categoryIds }) => {
      try {
        const config = getConfig();
        if (profiles?.length && categoryIds?.length) throw new Error("Give profiles or categoryIds, not both.");
        const resolved = profiles?.length ? (await resolveProfileIds(profiles)).ids : categoryIds;
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
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Created calendar event "${summary}" (ID: ${event.id})`,
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
- categoryIds: Updated family member assignments

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
    },
    async ({ eventId, summary, startsAt, endsAt, allDay, description, location, profiles, categoryIds }) => {
      try {
        if (profiles?.length && categoryIds?.length) throw new Error("Give profiles or categoryIds, not both.");
        const updates: Record<string, unknown> = {};
        if (summary !== undefined) updates.summary = summary;
        const tz = getConfig().timezone;
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
    `Delete a calendar event from Skylight.

Use this when:
- Canceling an event: "Remove the dentist appointment"
- Deleting old events: "Delete the meeting from yesterday"

Parameters:
- eventId (required): ID of the event to delete (from get_calendar_events)

Note: This permanently removes the event. For recurring events, this may only delete one instance.`,
    {
      eventId: z.string().describe("ID of the event to delete"),
    },
    async ({ eventId }) => {
      try {
        await deleteCalendarEvent(eventId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Deleted calendar event (ID: ${eventId})`,
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
}
