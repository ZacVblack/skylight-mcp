/**
 * Pure schedule math: time zones, intervals, conflicts and free slots.
 *
 * Everything here works in epoch milliseconds plus an IANA time zone, using
 * Intl for the zone rules. No library. Written so that DST transitions and
 * all-day events (which Skylight gives as midnight-to-midnight local ranges)
 * are handled explicitly rather than by accident.
 */

export interface Interval {
  /** Epoch ms, inclusive. */
  start: number;
  /** Epoch ms, exclusive. */
  end: number;
  allDay: boolean;
  summary: string;
  /** Free-form origin, e.g. "calendar", "chore". */
  kind: string;
  id?: string;
  /** Where the event came from (Skylight's `source`, e.g. "google", "ics_link", "skylight"). */
  source?: string;
}

export interface Conflict {
  a: Interval;
  b: Interval;
  /** True when a and b are the same subscribed-feed entry listed twice, not two real commitments. */
  duplicate?: boolean;
  /** Overlap window, epoch ms. */
  overlapStart: number;
  overlapEnd: number;
}

export interface FreeSlot {
  /** YYYY-MM-DD in the zone. */
  date: string;
  start: number;
  end: number;
  minutes: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of an instant in a zone. */
export function toLocalParts(epochMs: number, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(new Date(epochMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** Zone offset in ms at an instant (UTC = local + offset... i.e. local - utc). */
export function offsetAt(epochMs: number, timeZone: string): number {
  const p = toLocalParts(epochMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Epoch ms for a wall-clock time in a zone. Handles DST: a nonexistent time
 * (spring-forward gap) resolves to the instant after the gap; an ambiguous
 * time (fall-back) resolves to the earlier instant.
 */
export function zonedToEpoch(date: string, time: string, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm, 0);
  // First guess using the offset at the wall time interpreted as UTC, then refine.
  let guess = wall - offsetAt(wall, timeZone);
  const refined = wall - offsetAt(guess, timeZone);
  if (refined !== guess) {
    // Two candidate offsets around a transition. Pick the one that round-trips.
    const candidates = [guess, refined];
    const ok = candidates.filter((c) => {
      const p = toLocalParts(c, timeZone);
      return p.hour === hh && p.minute === mm && p.day === d;
    });
    guess = ok.length ? Math.min(...ok) : Math.max(guess, refined);
  }
  return guess;
}

/** YYYY-MM-DD of an instant in a zone. */
export function dateInZone(epochMs: number, timeZone: string): string {
  const p = toLocalParts(epochMs, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Add days to a YYYY-MM-DD string (calendar days, no zone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d + days);
  return new Date(t).toISOString().slice(0, 10);
}

/** Inclusive list of YYYY-MM-DD from start to end. */
export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** "9:00 AM" style, in zone. */
export function formatTime(epochMs: number, timeZone: string): string {
  return new Date(epochMs).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
}

export function formatRange(start: number, end: number, timeZone: string): string {
  return `${formatTime(start, timeZone)}–${formatTime(end, timeZone)}`;
}

/** "Thu, Oct 29" for a YYYY-MM-DD. */
export function formatDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Build an interval from a Skylight calendar event. `starts_at`/`ends_at`
 * are ISO strings with offsets; all-day events are local midnight ranges
 * whose end is the following midnight (exclusive).
 */
export function eventToInterval(
  event: { id: string; attributes: Record<string, unknown> },
  timeZone: string
): Interval | null {
  const a = event.attributes;
  const summary = typeof a.summary === "string" ? a.summary : "(untitled)";
  const allDay = a.all_day === true;
  const startRaw = typeof a.starts_at === "string" ? a.starts_at : null;
  const endRaw = typeof a.ends_at === "string" ? a.ends_at : null;
  if (!startRaw) return null;

  if (allDay) {
    // Use the local date of the start, and the local date of the end (exclusive).
    const startDate = startRaw.slice(0, 10);
    const endDate = endRaw ? endRaw.slice(0, 10) : addDays(startDate, 1);
    return {
      start: zonedToEpoch(startDate, "00:00", timeZone),
      end: zonedToEpoch(endDate > startDate ? endDate : addDays(startDate, 1), "00:00", timeZone),
      allDay: true,
      summary,
      kind: "calendar",
      id: event.id,
      source: typeof a.source === "string" ? a.source : undefined,
    };
  }

  const start = Date.parse(startRaw);
  const end = endRaw ? Date.parse(endRaw) : start + 60 * 60 * 1000;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return {
    start,
    end: Math.max(end, start),
    allDay: false,
    summary,
    kind: "calendar",
    id: event.id,
    source: typeof a.source === "string" ? a.source : undefined,
  };
}

/** Title with case, spacing and trailing "(...)" notes such as "(Arrive 20 minutes early)" removed. */
function baseTitle(summary: string): string {
  let t = summary.trim().toLowerCase();
  for (;;) {
    const next = t.replace(/\s*\([^()]*\)\s*$/, "");
    if (next === t) break;
    t = next;
  }
  return t.replace(/\s+/g, " ");
}

/**
 * A subscribed feed that lists the same game twice (one copy with an "Arrive N minutes early"
 * suffix) is one commitment, not a clash. Deliberately narrow: both events from a feed, identical
 * start and end, and the same title apart from trailing notes. Two Google or Skylight events at
 * the same time are never called duplicates, because that may be a real double-booking.
 */
export function isFeedDuplicate(a: Interval, b: Interval): boolean {
  return (
    a.source === "ics_link" &&
    b.source === "ics_link" &&
    a.start === b.start &&
    a.end === b.end &&
    baseTitle(a.summary) === baseTitle(b.summary)
  );
}

/** Timed intervals that overlap. All-day items never conflict. */
export function findConflicts(intervals: Interval[]): Conflict[] {
  const timed = intervals.filter((i) => !i.allDay && i.end > i.start).sort((x, y) => x.start - y.start);
  const out: Conflict[] = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i];
      const b = timed[j];
      if (b.start >= a.end) break; // sorted by start; nothing later can overlap a
      const overlapStart = Math.max(a.start, b.start);
      const overlapEnd = Math.min(a.end, b.end);
      if (overlapEnd > overlapStart) out.push({ a, b, overlapStart, overlapEnd, duplicate: isFeedDuplicate(a, b) });
    }
  }
  return out;
}

export interface FreeSlotOptions {
  /** HH:MM local, inclusive window start. */
  earliest: string;
  /** HH:MM local, window end. */
  latest: string;
  minMinutes: number;
  timeZone: string;
}

/** Gaps of at least `minMinutes` within each day's window, around timed intervals. */
export function findFreeSlots(intervals: Interval[], days: string[], options: FreeSlotOptions): FreeSlot[] {
  const timed = intervals.filter((i) => !i.allDay && i.end > i.start).sort((x, y) => x.start - y.start);
  const out: FreeSlot[] = [];
  for (const date of days) {
    const windowStart = zonedToEpoch(date, options.earliest, options.timeZone);
    const windowEnd = zonedToEpoch(date, options.latest, options.timeZone);
    if (windowEnd <= windowStart) continue;
    let cursor = windowStart;
    for (const t of timed) {
      if (t.end <= cursor || t.start >= windowEnd) continue;
      if (t.start > cursor) push(date, cursor, Math.min(t.start, windowEnd));
      cursor = Math.max(cursor, t.end);
      if (cursor >= windowEnd) break;
    }
    if (cursor < windowEnd) push(date, cursor, windowEnd);
  }
  return out;

  function push(date: string, start: number, end: number): void {
    const minutes = Math.floor((end - start) / 60_000);
    if (minutes >= options.minMinutes) out.push({ date, start, end, minutes });
  }
}

/** Group intervals by the local date they start on (multi-day all-day events appear on each day). */
export function groupByDay(intervals: Interval[], days: string[], timeZone: string): Map<string, Interval[]> {
  const map = new Map<string, Interval[]>(days.map((d) => [d, []]));
  for (const i of intervals) {
    if (i.allDay) {
      const first = dateInZone(i.start, timeZone);
      const last = dateInZone(i.end - 1, timeZone); // end is exclusive midnight
      for (const d of eachDay(first, last)) map.get(d)?.push(i);
    } else {
      map.get(dateInZone(i.start, timeZone))?.push(i);
    }
  }
  for (const list of map.values()) list.sort((x, y) => Number(y.allDay) - Number(x.allDay) || x.start - y.start);
  return map;
}
