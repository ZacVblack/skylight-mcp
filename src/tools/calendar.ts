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
import { formatAttribute } from "../utils/redact.js";
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

  // get_source_calendars tool
  server.tool(
    "get_source_calendars",
    `Get connected calendar sources synced to Skylight.

Use this to answer:
- "Which calendars are synced to Skylight?"
- "What calendar accounts are connected?"

Returns a list of connected calendar sources (Google, iCloud, etc.).`,
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
