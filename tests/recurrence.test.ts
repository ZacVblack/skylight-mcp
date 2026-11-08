import { describe, expect, it } from "vitest";
import { MAX_OCCURRENCES, RepeatError, planRepeat, weekdayOf } from "../src/utils/recurrence.js";

const PT = "America/Los_Angeles";
const NOW = Date.UTC(2026, 10, 8, 16, 0, 0);
const plan = (input: Parameters<typeof planRepeat>[0], date = "2027-03-02", time = "16:00", tz = PT) =>
  planRepeat(input, date, time, false, tz, NOW);

describe("planRepeat", () => {
  it("builds the captured weekly rule shape; UNTIL is the UTC day of the last start (Apr 6 is PDT, so 23:00Z the same day; the app's own 0407 was the date typed in its form)", () => {
    const p = plan({ frequency: "weekly", until: "2027-04-06" });
    expect(p.rrule).toBe("RRULE:FREQ=WEEKLY;INTERVAL=1;UNTIL=20270406T235959Z;WKST=SU;BYDAY=TU");
    expect(p.occurrences.map((o) => o.date)).toEqual(["2027-03-02", "2027-03-09", "2027-03-16", "2027-03-23", "2027-03-30", "2027-04-06"]);
  });
  it("turns count into the UNTIL of the last occurrence and never sends COUNT", () => {
    const p = plan({ frequency: "weekly", count: 3 });
    expect(p.occurrences).toHaveLength(3);
    expect(p.rrule).not.toContain("COUNT");
    expect(p.rrule).toContain("UNTIL=20270316T235959Z");
  });
  it("includes an evening occurrence whose UTC day is the next day", () => {
    const p = plan({ frequency: "daily", count: 2 }, "2027-03-02", "19:00");
    expect(p.rrule).toContain("UNTIL=20270304T235959Z");
  });
  it("keeps wall-clock time across the spring DST change", () => {
    const p = plan({ frequency: "weekly", count: 2 }, "2027-03-09", "09:00");
    const h = p.occurrences.map((o) => new Date(o.startEpoch).getUTCHours());
    expect(h).toEqual([17, 16]);
  });
  it("steps by interval", () => {
    expect(plan({ frequency: "weekly", interval: 2, count: 3 }).occurrences.map((o) => o.date)).toEqual(["2027-03-02", "2027-03-16", "2027-03-30"]);
    expect(plan({ frequency: "daily", interval: 3, count: 2 }).occurrences.map((o) => o.date)).toEqual(["2027-03-02", "2027-03-05"]);
  });
  it("derives the weekday and drops BYDAY for daily", () => {
    expect(weekdayOf("2027-03-02")).toBe("TU");
    expect(plan({ frequency: "daily", count: 2 }).rrule).not.toContain("BYDAY");
  });
  it.each([
    ["no end", { frequency: "weekly" }],
    ["both ends", { frequency: "weekly", until: "2027-04-01", count: 2 }],
    ["monthly", { frequency: "monthly" }],
    ["byDay mismatch", { frequency: "weekly", byDay: "MO", count: 2 }],
    ["byDay on daily", { frequency: "daily", byDay: "TU", count: 2 }],
    ["over the cap", { frequency: "daily", count: MAX_OCCURRENCES + 1 }],
    ["interval 0", { frequency: "weekly", interval: 0, count: 2 }],
    ["interval 5 weekly", { frequency: "weekly", interval: 5, count: 2 }],
    ["until before start", { frequency: "weekly", until: "2027-03-01" }],
    ["until too far", { frequency: "daily", until: "2030-01-01" }],
    ["bad until", { frequency: "weekly", until: "April 1" }],
    ["unknown field", { frequency: "weekly", count: 2, rrule: "x" }],
  ])("refuses %s", (_n, input) => {
    expect(() => plan(input as never)).toThrow(RepeatError);
  });
  it("accepts exactly the cap and refuses a span over two years", () => {
    expect(plan({ frequency: "daily", count: MAX_OCCURRENCES }).occurrences).toHaveLength(MAX_OCCURRENCES);
    expect(() => plan({ frequency: "weekly", interval: 4, count: 60 })).toThrow(RepeatError);
  });
  it("the cap is 104, pinned by literal (not by the constant)", () => {
    expect(plan({ frequency: "daily", count: 104 }).occurrences).toHaveLength(104);
    expect(() => plan({ frequency: "daily", count: 105 })).toThrow(/104/);
    expect(() => plan({ frequency: "daily", until: "2027-12-31" })).toThrow(/104/);
  });
  it("refuses a past start and an end before the start", () => {
    expect(() => plan({ frequency: "weekly", count: 2 }, "2026-01-06")).toThrow(/past/);
    expect(() => planRepeat({ frequency: "weekly", count: 2 }, "2027-03-02", "16:00", true, PT, NOW)).toThrow(/endsAt/);
    expect(() => planRepeat({ frequency: "weekly", count: 2 }, "2027-03-02", "16:00", false, PT, NOW)).not.toThrow();
  });
});
