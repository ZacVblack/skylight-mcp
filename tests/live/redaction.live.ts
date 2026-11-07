import { expect, it } from "vitest";
import { liveSuite } from "./harness.js";
import { scanForLeaks } from "./leak-scan.js";

// Does any read tool print something shaped like a secret from the REAL account?
// The mocked redaction tests use invented data; this is the check against yours.
//
// Read-only. The report holds the tool name, a kind of finding and a count, never
// the text (tests/leak-scan.test.ts proves the scanner cannot print input).
//
// Not covered: get_albums. The live harness registers no photo tools (uploads share that
// switch), so it does not exist here. Albums were empty when last audited by hand.
//
// A finding means "open that tool's output on your own machine and look"; it can
// be a harmless long link. No finding means none of these shapes appeared in this
// account's data today, not that none ever will.

const PLUS_ONLY = new Set(["get_meal_categories", "get_meal_sittings", "get_recipes", "get_rewards", "get_reward_points"]);

const READS = [
  "get_frame_info",
  "get_family_members",
  "get_devices",
  "get_colors",
  "get_avatars",
  "get_labels",
  "get_source_calendars",
  "get_calendar_events",
  "get_chores",
  "get_task_box",
  "get_lists",
  "get_meal_categories",
  "get_meal_sittings",
  "get_recipes",
  "get_rewards",
  "get_reward_points",
  "get_messages",
  "get_week_overview",
  "find_conflicts",
];

liveSuite("redaction against real data", { tags: ["read", "security"] }, (ctx) => {
  it("no read tool prints a secret-shaped value", async () => {
    const problems: string[] = [];
    const clean: string[] = [];
    const skipped: string[] = [];

    for (const tool of READS) {
      if (PLUS_ONLY.has(tool) && !ctx.hasPlus) {
        skipped.push(tool);
        continue;
      }
      // A window wide enough to include feeds and several weeks of events.
      const args = tool === "get_calendar_events" ? { date: ctx.today(), dateEnd: ctx.daysFromToday(60) } : {};
      let text: string;
      try {
        const result = await ctx.call(tool, args);
        text = result.text;
        if (result.isError) {
          // Status only: an error text can echo request details.
          problems.push(`${tool}: the tool returned an error, so it was NOT scanned`);
          continue;
        }
      } catch {
        problems.push(`${tool}: the call threw, so it was NOT scanned`);
        continue;
      }
      const findings = scanForLeaks(text);
      if (findings.length === 0) clean.push(tool);
      else problems.push(`${tool}: ${findings.map((f) => `${f.kind} under "${f.key}" x${f.count}`).join(", ")}`);
    }

    ctx.note(`scanned clean: ${clean.join(", ") || "none"}`);
    ctx.note(`skipped (no Plus): ${skipped.join(", ") || "none"}`);
    expect(problems, `secret-shaped output (kind and count only):\n${problems.join("\n")}`).toEqual([]);
  });
});
