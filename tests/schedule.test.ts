import { describe, expect, it } from "vitest";
import {
  addDays,
  dateInZone,
  eachDay,
  eventToInterval,
  findConflicts,
  findFreeSlots,
  formatRange,
  groupByDay,
  toLocalParts,
  zonedToEpoch,
  type Interval,
} from "../src/utils/schedule.js";

const LA = "America/Los_Angeles";

function timed(date: string, from: string, to: string, summary = "x"): Interval {
  return { start: zonedToEpoch(date, from, LA), end: zonedToEpoch(date, to, LA), allDay: false, summary, kind: "t" };
}

describe("zone math", () => {
  it("round-trips wall time in LA", () => {
    const t = zonedToEpoch("2026-10-29", "17:00", LA);
    expect(toLocalParts(t, LA)).toMatchObject({ year: 2026, month: 10, day: 29, hour: 17, minute: 0 });
    expect(new Date(t).toISOString()).toBe("2026-10-30T00:00:00.000Z"); // PDT = UTC-7
  });

  it("handles fall-back day: Nov 1 2026 has 25 hours in LA", () => {
    const start = zonedToEpoch("2026-11-01", "00:00", LA);
    const end = zonedToEpoch("2026-11-02", "00:00", LA);
    expect((end - start) / 3_600_000).toBe(25);
    // 4:20 PM on Nov 1 is PST (UTC-8)
    expect(new Date(zonedToEpoch("2026-11-01", "16:20", LA)).toISOString()).toBe("2026-11-02T00:20:00.000Z");
  });

  it("handles spring-forward gap: 2:30 AM Mar 8 2026 does not exist, resolves after the gap", () => {
    const t = zonedToEpoch("2026-03-08", "02:30", LA);
    const p = toLocalParts(t, LA);
    expect(p.day).toBe(8);
    expect(p.hour).toBeGreaterThanOrEqual(3);
  });

  it("date helpers", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(eachDay("2026-10-30", "2026-11-01")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(dateInZone(Date.UTC(2026, 9, 30, 3, 0), LA)).toBe("2026-10-29"); // 8pm PDT previous day
  });
});

describe("eventToInterval", () => {
  it("maps a timed Skylight event using its offset", () => {
    const i = eventToInterval(
      { id: "1", attributes: { summary: "Bball", all_day: false, starts_at: "2026-10-30T18:00:00.000-07:00", ends_at: "2026-10-30T19:00:00.000-07:00" } },
      LA
    )!;
    expect(formatRange(i.start, i.end, LA)).toBe("6:00 PM–7:00 PM");
    expect(i.allDay).toBe(false);
  });

  it("maps an all-day event to local midnight..next midnight (25h across fall-back)", () => {
    const i = eventToInterval(
      { id: "2", attributes: { summary: "DST", all_day: true, starts_at: "2026-11-01T00:00:00.000-07:00", ends_at: "2026-11-02T00:00:00.000-08:00" } },
      LA
    )!;
    expect(i.allDay).toBe(true);
    expect((i.end - i.start) / 3_600_000).toBe(25);
  });

  it("returns null without a start", () => {
    expect(eventToInterval({ id: "3", attributes: { summary: "?" } }, LA)).toBeNull();
  });
});

describe("findConflicts", () => {
  it("finds overlapping timed events and ignores all-day and adjacent ones", () => {
    const allDay: Interval = { start: zonedToEpoch("2026-11-05", "00:00", LA), end: zonedToEpoch("2026-11-06", "00:00", LA), allDay: true, summary: "bday", kind: "t" };
    const c = findConflicts([
      timed("2026-11-05", "16:00", "19:00", "Healdsburg"),
      timed("2026-11-05", "17:00", "19:00", "Bball pics"),
      timed("2026-11-05", "19:00", "20:00", "Dinner"), // adjacent, not overlapping
      allDay,
    ]);
    expect(c).toHaveLength(1);
    expect([c[0].a.summary, c[0].b.summary].sort()).toEqual(["Bball pics", "Healdsburg"]);
    expect(formatRange(c[0].overlapStart, c[0].overlapEnd, LA)).toBe("5:00 PM–7:00 PM");
  });
});

describe("findConflicts: feed duplicates", () => {
  const feed = (from: string, to: string, summary: string, source = "ics_link"): Interval => ({ ...timed("2026-11-08", from, to, summary), source });

  it("calls the same feed entry listed twice a duplicate, not a conflict", () => {
    const c = findConflicts([
      feed("18:30", "19:30", "Game: Team vs Rivals (Arrive 20 minutes early)"),
      feed("18:30", "19:30", "Game: Team vs Rivals"),
    ]);
    expect(c).toHaveLength(1);
    expect(c[0].duplicate).toBe(true);
  });

  it("still reports a real clash between two feed events at overlapping times", () => {
    const c = findConflicts([feed("18:30", "19:30", "Game: Team vs Rivals"), feed("19:00", "20:00", "Game: Team vs Rivals")]);
    expect(c[0].duplicate).toBe(false);
  });

  it("needs both the same start and the same end", () => {
    expect(findConflicts([feed("18:30", "19:30", "Game"), feed("19:00", "19:30", "Game")])[0].duplicate).toBe(false); // same end only
    expect(findConflicts([feed("18:30", "19:30", "Game"), feed("18:30", "20:00", "Game")])[0].duplicate).toBe(false); // same start only
  });

  it("does not hide a different feed event at the same time", () => {
    const c = findConflicts([feed("18:30", "19:30", "Game: Team vs Rivals"), feed("18:30", "19:30", "Practice")]);
    expect(c[0].duplicate).toBe(false);
  });

  it("never calls two Google or Skylight events at the same time duplicates (may be a real double-booking)", () => {
    for (const source of ["google", "skylight"]) {
      const c = findConflicts([feed("18:30", "19:30", "Dentist", source), feed("18:30", "19:30", "Dentist", source)]);
      expect(c[0].duplicate).toBe(false);
    }
  });

  it("does not treat a feed event and a Google event of the same name as duplicates", () => {
    const c = findConflicts([feed("18:30", "19:30", "Game", "ics_link"), feed("18:30", "19:30", "Game", "google")]);
    expect(c[0].duplicate).toBe(false);
  });
});

describe("findFreeSlots", () => {
  it("returns gaps within the window of at least the minimum length", () => {
    const slots = findFreeSlots(
      [timed("2026-11-03", "15:30", "17:30", "tryouts"), timed("2026-11-03", "19:00", "19:30", "call")],
      ["2026-11-03"],
      { earliest: "08:00", latest: "21:00", minMinutes: 60, timeZone: LA }
    );
    expect(slots.map((s) => formatRange(s.start, s.end, LA))).toEqual(["8:00 AM–3:30 PM", "5:30 PM–7:00 PM", "7:30 PM–9:00 PM"]);
    expect(slots[1].minutes).toBe(90);
  });

  it("an event spanning the whole window leaves nothing", () => {
    expect(findFreeSlots([timed("2026-11-03", "07:00", "22:00")], ["2026-11-03"], { earliest: "08:00", latest: "21:00", minMinutes: 30, timeZone: LA })).toEqual([]);
  });

  it("free day yields the whole window", () => {
    const s = findFreeSlots([], ["2026-11-03"], { earliest: "08:00", latest: "21:00", minMinutes: 30, timeZone: LA });
    expect(s).toHaveLength(1);
    expect(s[0].minutes).toBe(13 * 60);
  });
});

describe("groupByDay", () => {
  it("places timed events on their local day and all-day events on each day they cover", () => {
    const days = eachDay("2026-10-31", "2026-11-02");
    const twoDay: Interval = { start: zonedToEpoch("2026-10-31", "00:00", LA), end: zonedToEpoch("2026-11-02", "00:00", LA), allDay: true, summary: "trip", kind: "t" };
    const g = groupByDay([twoDay, timed("2026-11-01", "16:20", "17:30", "game")], days, LA);
    expect(g.get("2026-10-31")!.map((i) => i.summary)).toEqual(["trip"]);
    expect(g.get("2026-11-01")!.map((i) => i.summary)).toEqual(["trip", "game"]);
    expect(g.get("2026-11-02")!.map((i) => i.summary)).toEqual([]);
  });
});
