import { getClient } from "../client.js";
import { isoWithOffset } from "./messages.js";
import { zonedToEpoch } from "../../utils/schedule.js";
import type {
  CalendarEventsResponse,
  CalendarEventResource,
  CalendarEventResponse,
  SourceCalendarsResponse,
  SourceCalendarResource,
  CreateCalendarEventRequest,
  UpdateCalendarEventRequest,
} from "../types.js";

export interface GetCalendarEventsOptions {
  dateMin: string;
  dateMax: string;
  timezone?: string;
  include?: string;
}

/**
 * Add days to a date string in YYYY-MM-DD format
 */
function addDays(dateStr: string, days: number): string {
  const date = new Date(dateStr + "T00:00:00");
  date.setDate(date.getDate() + days);
  return date.toISOString().split("T")[0];
}

/**
 * Get calendar events for a date range
 * Note: The API treats date_max as exclusive, so we add 1 day to include events on the end date
 */
export async function getCalendarEvents(
  options: GetCalendarEventsOptions
): Promise<CalendarEventResource[]> {
  const client = getClient();

  // API treats date_max as exclusive, so add 1 day to include events on the end date
  const adjustedDateMax = addDays(options.dateMax, 1);

  const response = await client.get<CalendarEventsResponse>(
    "/api/frames/{frameId}/calendar_events",
    {
      date_min: options.dateMin,
      date_max: adjustedDateMax,
      timezone: options.timezone ?? client.timezone,
      // Without this the list names at most one profile per event (captured from the web app,
      // which always sends it), so a two-person event would read back as one person.
      include: options.include ?? "categories",
    }
  );
  return response.data;
}

/**
 * Get source calendars (connected calendar accounts)
 */
export async function getSourceCalendars(): Promise<SourceCalendarResource[]> {
  const client = getClient();
  const response = await client.get<SourceCalendarsResponse>(
    "/api/frames/{frameId}/source_calendars"
  );
  return response.data;
}

/**
 * Create a calendar event
 */
export async function createCalendarEvent(
  data: CreateCalendarEventRequest
): Promise<CalendarEventResource> {
  const client = getClient();
  const response = await client.post<CalendarEventResponse>(
    "/api/frames/{frameId}/calendar_events",
    data
  );
  return response.data;
}

/**
 * How much of a repeating series a change reaches. Captured from the Skylight web app
 * (2026-11-07): "one" is this occurrence, "future" is this and every later one, "all" is the
 * whole series. An edit with "future" is refused by Skylight's API (400); a delete accepts all three.
 */
export type EventScope = "one" | "future" | "all";

/**
 * Update a calendar event. For an occurrence of a repeating event pass `applyTo`
 * ("one" or "all"; the app sends it in the JSON body). Leave it out for a one-off event.
 */
export async function updateCalendarEvent(
  eventId: string,
  data: UpdateCalendarEventRequest,
  applyTo?: Exclude<EventScope, "future">
): Promise<CalendarEventResource> {
  const client = getClient();
  const response = await client.request<CalendarEventResponse>(
    `/api/frames/{frameId}/calendar_events/${eventId}`,
    { method: "PUT", body: applyTo ? { ...data, apply_to: applyTo } : data }
  );
  return response.data;
}

/**
 * Delete a calendar event. For an occurrence of a repeating event pass `applyTo`
 * (the app sends it as the `apply_to` query parameter on a DELETE with no body).
 */
export async function deleteCalendarEvent(eventId: string, applyTo?: EventScope): Promise<void> {
  const client = getClient();
  await client.request(`/api/frames/{frameId}/calendar_events/${eventId}`, {
    method: "DELETE",
    params: applyTo ? { apply_to: applyTo } : undefined,
  });
}

/**
 * Skylight reads a start/end time with no offset as UTC, even when a timezone is
 * sent, so "08:00" landed at 01:00 Pacific. Give a local wall-clock time the
 * frame zone's offset. Times that already carry Z or an offset, and date-only
 * values (all-day events), pass through unchanged.
 */
export function withFrameOffset(value: string, timeZone: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return value;
  const seconds = m[3] ? Number(m[3]) : 0;
  return isoWithOffset(zonedToEpoch(m[1]!, m[2]!, timeZone) + seconds * 1000, timeZone);
}
