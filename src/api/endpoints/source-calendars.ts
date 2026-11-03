/**
 * Adding and removing subscribed calendar feeds (Calendar URL in the Skylight app).
 *
 * Captured from the web app: adding is `POST /webcal_accounts` with one field,
 * `sync_url`; Skylight fetches the feed itself, names the calendar from the feed,
 * and creates the source calendar and its label. Removing is
 * `DELETE /source_calendars/{id}`. The create response echoes `sync_url`, and a
 * feed address works like a password, so nothing here returns or logs it.
 */

import { getClient } from "../client.js";
import { SkylightError } from "../../utils/errors.js";

const FEED_SCHEMES = new Set(["https:", "http:", "webcal:", "webcals:"]);

export class FeedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedAddressError";
  }
}

export type FeedCheck = { ok: true; url: string; host: string } | { ok: false; reason: string };

/** Check an address before anything is sent: a web or webcal address, nothing else. */
export function checkFeedUrl(input: string): FeedCheck {
  const url = input.trim();
  if (!url) return { ok: false, reason: "No address entered." };
  if (/\s/.test(url)) return { ok: false, reason: "The address contains spaces. Paste only the link." };
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (!scheme || !FEED_SCHEMES.has(`${scheme[1]!.toLowerCase()}:`)) {
    return { ok: false, reason: "The address must start with https://, http://, webcal:// or webcals://." };
  }
  // Pasting twice (nothing is shown while pasting) joins two addresses into one string.
  if ((url.match(/(?:https?|webcals?):\/\//gi) ?? []).length > 1) {
    return { ok: false, reason: "That looks like more than one address pasted together. Paste the link once." };
  }
  try {
    // URL() does not parse webcal: the same way everywhere, so parse as https.
    const host = new URL(url.replace(/^[a-z]+:/i, "https:")).hostname;
    if (!host) return { ok: false, reason: "That is not a valid web address." };
    return { ok: true, url, host };
  } catch {
    return { ok: false, reason: "That is not a valid web address." };
  }
}

export type AddFeedResult =
  | { status: "added"; host: string; name?: string }
  | { status: "already_synced"; host: string };

/** Remove anything address-shaped from an error message, plus the exact address sent. */
export function scrubFeedText(text: string, url: string): string {
  let out = url ? text.split(url).join("(feed address hidden)") : text;
  out = out.replace(/\b(?:https?|webcals?):\/\/\S+/gi, "(feed address hidden)");
  return out;
}

export async function addCalendarFeed(address: string): Promise<AddFeedResult> {
  const check = checkFeedUrl(address);
  if (!check.ok) throw new FeedAddressError(check.reason);
  try {
    const response = await getClient().request<{ data?: { attributes?: { name?: unknown } } }>(
      "/api/frames/{frameId}/webcal_accounts",
      { method: "POST", body: { sync_url: check.url } }
    );
    // Only the calendar's name and the feed host leave this function. The response
    // also carries the address; it is dropped here.
    const name = response.data?.attributes?.name;
    return { status: "added", host: check.host, name: typeof name === "string" && name.trim() ? name.trim() : undefined };
  } catch (error) {
    if (error instanceof SkylightError) {
      if (error.statusCode === 422 && /already synced/i.test(error.message)) {
        return { status: "already_synced", host: check.host };
      }
      throw new SkylightError(scrubFeedText(error.message, check.url), error.code, error.statusCode, error.recoverable);
    }
    throw error;
  }
}

export async function removeSourceCalendar(id: string): Promise<void> {
  if (!/^\d+$/.test(id)) throw new Error("Calendar ID must be numeric (see get_source_calendars).");
  await getClient().request(`/api/frames/{frameId}/source_calendars/${id}`, { method: "DELETE" });
}

/**
 * Replace the set of categories (profiles and labels) a synced calendar is linked to.
 *
 * Captured from the web app: `PUT /source_calendars/{id}/source_calendar_categorizations`
 * with `{ categorizations: [{ category_id }] }`. It is a full replacement, so callers must
 * send the complete wanted set or they silently drop the existing label. The response is the
 * calendar record including its feed address; nothing from it is returned.
 */
export async function setSourceCalendarCategories(id: string, categoryIds: string[]): Promise<void> {
  if (!/^\d+$/.test(id)) throw new Error("Calendar ID must be numeric (see get_source_calendars).");
  if (categoryIds.length === 0) throw new Error("Refusing to send an empty set: its effect on Skylight has not been verified.");
  if (categoryIds.some((c) => !/^\d+$/.test(c))) throw new Error("Category IDs must be numeric.");
  await getClient().request(`/api/frames/{frameId}/source_calendars/${id}/source_calendar_categorizations`, {
    method: "PUT",
    body: { categorizations: categoryIds.map((category_id) => ({ category_id })) },
  });
}

export const MAX_CALENDAR_NAME = 100;

/** A calendar name: non-empty, one line, not a link (a pasted feed address must never become a visible name). */
export function checkCalendarName(input: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = input.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, reason: "The name cannot be blank." };
  if (name.length > MAX_CALENDAR_NAME) return { ok: false, reason: `The name is longer than ${MAX_CALENDAR_NAME} characters.` };
  if (/:\/\//.test(name)) return { ok: false, reason: "The name looks like a web address. Give a plain name." };
  return { ok: true, name };
}

/**
 * Rename a synced calendar. Captured from the web app: `PUT /source_calendars/{id}` with
 * `{ label }` (a blank label is a 422). The response is the calendar record including its feed
 * address; nothing from it is returned.
 */
export async function renameSourceCalendar(id: string, name: string): Promise<void> {
  if (!/^\d+$/.test(id)) throw new Error("Calendar ID must be numeric (see get_source_calendars).");
  const check = checkCalendarName(name);
  if (!check.ok) throw new Error(check.reason);
  await getClient().request(`/api/frames/{frameId}/source_calendars/${id}`, { method: "PUT", body: { label: check.name } });
}

/**
 * Skylight answers a write before its own list reflects it (seen live: a delete returned 200,
 * the immediate read-back still listed the calendar, and a moment later it was gone). So a
 * read-back re-checks a few times before it calls the write a failure.
 */
export const readBackPolicy = { attempts: 4, delayMs: 500 };

export async function readBackUntil<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<{ ok: boolean; value: T }> {
  let value = await read();
  for (let i = 1; i < readBackPolicy.attempts && !done(value); i++) {
    await new Promise((resolve) => setTimeout(resolve, readBackPolicy.delayMs));
    value = await read();
  }
  return { ok: done(value), value };
}
