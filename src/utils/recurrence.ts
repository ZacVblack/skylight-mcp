import { addDays, zonedToEpoch } from "./schedule.js";

/**
 * Repeating-event rules for create_calendar_event.
 *
 * Only what has been captured from the Skylight web app is sent: one RFC 5545 string with
 * FREQ, INTERVAL, WKST, UNTIL (UTC, T235959Z) and, for weekly, one BYDAY. COUNT is never sent;
 * a count is turned into the UNTIL of the last occurrence. Daily is the same shape with the
 * BYDAY dropped, and is unverified until the live suite has run it.
 */

export const MAX_OCCURRENCES = 104;
export const MAX_SPAN_DAYS = 731;

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
export type DayCode = (typeof DAY_CODES)[number];

export interface RepeatInput {
  frequency: "daily" | "weekly";
  interval?: number;
  byDay?: DayCode;
  until?: string;
  count?: number;
}

export interface Occurrence {
  date: string;
  startEpoch: number;
}

export interface RepeatPlan {
  rrule: string;
  occurrences: Occurrence[];
  weekday: DayCode;
}

export class RepeatError extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function weekdayOf(date: string): DayCode {
  const [y, m, d] = date.split("-").map(Number);
  return DAY_CODES[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
}

function utcStamp(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Expand a repeat request. `startDate`/`startTime` are the first occurrence's local wall clock in
 * `timeZone`. Throws RepeatError with a message that says what to change.
 */
export function planRepeat(
  input: RepeatInput,
  startDate: string,
  startTime: string,
  endsBeforeStart: boolean,
  timeZone: string,
  nowMs: number
): RepeatPlan {
  const known = new Set(["frequency", "interval", "byDay", "until", "count"]);
  for (const k of Object.keys(input)) if (!known.has(k)) throw new RepeatError(`Unknown repeat field "${k}".`);
  if (input.frequency !== "daily" && input.frequency !== "weekly") {
    throw new RepeatError('repeat.frequency must be "daily" or "weekly". Monthly and yearly are not supported yet.');
  }
  if (!DATE_RE.test(startDate)) throw new RepeatError("A repeating event needs a start with a date and time, not a date alone.");
  if (endsBeforeStart) throw new RepeatError("endsAt is before startsAt.");

  const interval = input.interval ?? 1;
  const maxInterval = input.frequency === "weekly" ? 4 : 7;
  if (!Number.isInteger(interval) || interval < 1 || interval > maxInterval) {
    throw new RepeatError(`repeat.interval must be a whole number from 1 to ${maxInterval}.`);
  }

  const hasUntil = input.until !== undefined;
  const hasCount = input.count !== undefined;
  if (hasUntil === hasCount) throw new RepeatError("Give exactly one of repeat.until (YYYY-MM-DD) or repeat.count. An open-ended series is not allowed.");
  if (hasUntil && !DATE_RE.test(input.until!)) throw new RepeatError("repeat.until must be YYYY-MM-DD.");
  if (hasCount && (!Number.isInteger(input.count) || input.count! < 1)) throw new RepeatError("repeat.count must be a whole number of at least 1.");
  if (hasCount && input.count! > MAX_OCCURRENCES) throw new RepeatError(`A series is limited to ${MAX_OCCURRENCES} occurrences.`);

  const weekday = weekdayOf(startDate);
  if (input.frequency === "weekly") {
    if (input.byDay !== undefined && input.byDay !== weekday) {
      throw new RepeatError(`repeat.byDay (${input.byDay}) does not match the weekday of startsAt (${weekday}). Change startsAt or byDay so they agree.`);
    }
  } else if (input.byDay !== undefined) {
    throw new RepeatError("repeat.byDay applies to weekly series only.");
  }

  const first = zonedToEpoch(startDate, startTime, timeZone);
  if (first <= nowMs) throw new RepeatError("startsAt is in the past.");

  const step = input.frequency === "weekly" ? 7 * interval : interval;
  const lastAllowed = hasUntil ? input.until! : addDays(startDate, MAX_SPAN_DAYS);
  if (hasUntil && input.until! < startDate) throw new RepeatError("repeat.until is before the first occurrence.");
  if (hasUntil && input.until! > addDays(startDate, MAX_SPAN_DAYS)) throw new RepeatError(`A series is limited to ${MAX_SPAN_DAYS} days.`);

  const occurrences: Occurrence[] = [];
  for (let date = startDate; date <= lastAllowed; date = addDays(date, step)) {
    occurrences.push({ date, startEpoch: zonedToEpoch(date, startTime, timeZone) });
    if (hasCount && occurrences.length === input.count) break;
    if (occurrences.length > MAX_OCCURRENCES) throw new RepeatError(`A series is limited to ${MAX_OCCURRENCES} occurrences.`);
  }
  if (hasCount && occurrences.length < input.count!) throw new RepeatError(`A series is limited to ${MAX_SPAN_DAYS} days.`);

  // UNTIL is the end of the UTC day on which the last occurrence starts, so that occurrence is
  // included (the app does the same) and the next one, at least a day later, is not.
  const untilStamp = utcStamp(occurrences[occurrences.length - 1]!.startEpoch);
  const parts = [`FREQ=${input.frequency.toUpperCase()}`, `INTERVAL=${interval}`, `UNTIL=${untilStamp}T235959Z`, "WKST=SU"];
  if (input.frequency === "weekly") parts.push(`BYDAY=${weekday}`);
  return { rrule: `RRULE:${parts.join(";")}`, occurrences, weekday };
}
