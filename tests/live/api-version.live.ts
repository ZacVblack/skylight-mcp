import { expect, it } from "vitest";
import { SKYLIGHT_API_VERSION } from "../../src/api/constants.js";
import { isoWithOffset } from "../../src/api/endpoints/messages.js";
import { addDays, zonedToEpoch } from "../../src/utils/schedule.js";
import { liveSuite } from "./harness.js";
import { diffShapes, isSameShape, itemCount } from "./shape.js";

// Does the response shape of each read endpoint change between our default
// Skylight-Api-Version and the version the iOS app 2.31.0 sends? Skylight changes
// shapes silently under a different version (see the findings doc), so a gap here is a
// risk for every read tool that still sends the default.
//
// Read-only. The report holds key paths, types and item counts only, never values or ids
// (tests/shape.test.ts proves the fingerprint cannot print a value).
//
// The test must be able to fail: `nudges` is the positive control. Messages are the one
// resource where the older version is known to drop fields (the all-devices and
// all-profiles flags), so the older version MUST differ there. If it does not, this test
// cannot see version differences and its "same" results mean nothing.

/** The version the iOS app 2.31.0 sends, captured 2026-11-04. */
const APP_VERSION = "2026-10-15";

/**
 * Differences reviewed and accepted, by endpoint. Only additions under the newer version
 * are accepted, and only under these key-path prefixes. Anything else still fails.
 * - avatars (captured 2026-11-04): the app version adds display_position and reward_animations
 *   (with asset URLs). Our default version does not return them, so nothing of ours changes
 *   unless the default is bumped; before bumping, check that those URLs are redacted.
 */
const ACCEPTED_ADDITIONS: Record<string, string[]> = {
  avatars: ["data[].attributes.display_position", "data[].attributes.reward_animations"],
};

interface Probe {
  name: string;
  endpoint: string;
  params?: Record<string, string | boolean | number | undefined>;
  plusOnly?: boolean;
  /** The older version is expected to differ here. */
  control?: boolean;
}

// The suite body runs at registration, before the live connection exists, so nothing
// that needs the connection (today, timezone, hasPlus, client) may be read out here.
function buildProbes(from: string, to: string, timezone: string): Probe[] {
  const messagesFrom = addDays(from, -60);
  return [
    { name: "frame", endpoint: "/api/frames/{frameId}" },
    { name: "devices", endpoint: "/api/frames/{frameId}/devices" },
    { name: "avatars", endpoint: "/api/avatars" },
    { name: "colors", endpoint: "/api/colors" },
    { name: "categories", endpoint: "/api/frames/{frameId}/categories" },
    { name: "source_calendars", endpoint: "/api/frames/{frameId}/source_calendars" },
    {
      name: "calendar_events",
      endpoint: "/api/frames/{frameId}/calendar_events",
      params: { date_min: from, date_max: to, timezone, include: "categories" },
    },
    { name: "chores", endpoint: "/api/frames/{frameId}/chores", params: { after: from, before: to } },
    { name: "lists", endpoint: "/api/frames/{frameId}/lists" },
    { name: "task_box", endpoint: "/api/frames/{frameId}/task_box/items" },
    {
      name: "nudges",
      endpoint: "/api/frames/{frameId}/nudges",
      params: {
        after: isoWithOffset(zonedToEpoch(messagesFrom, "00:00", timezone), timezone),
        before: isoWithOffset(zonedToEpoch(addDays(from, 1), "00:00", timezone) - 1, timezone),
      },
      control: true,
    },
    { name: "meal_categories", endpoint: "/api/frames/{frameId}/meals/categories", plusOnly: true },
    {
      name: "meal_sittings",
      endpoint: "/api/frames/{frameId}/meals/sittings",
      params: { date_min: from, date_max: to },
      plusOnly: true,
    },
    { name: "recipes", endpoint: "/api/frames/{frameId}/meals/recipes", plusOnly: true },
    { name: "rewards", endpoint: "/api/frames/{frameId}/rewards", plusOnly: true },
    { name: "reward_points", endpoint: "/api/frames/{frameId}/reward_points", plusOnly: true },
  ];
}

function isAccepted(name: string, onlyOld: string[], onlyNew: string[]): boolean {
  const prefixes = ACCEPTED_ADDITIONS[name];
  if (!prefixes || onlyOld.length > 0) return false;
  return onlyNew.every((p) => prefixes.some((prefix) => p.startsWith(prefix)));
}

liveSuite("api version: response shape", { tags: ["read", "contract"] }, (ctx) => {
  it(`default ${SKYLIGHT_API_VERSION} vs app ${APP_VERSION}`, async () => {
    expect(APP_VERSION).not.toBe(SKYLIGHT_API_VERSION);
    const client = ctx.client();
    const probes = buildProbes(ctx.today(), ctx.daysFromToday(35), ctx.timezone);
    const problems: string[] = [];
    const same: string[] = [];
    const accepted: string[] = [];
    const empty: string[] = [];
    let controlResult: "differs" | "same" | "inconclusive" | "error" = "inconclusive";

    for (const probe of probes) {
      if (probe.plusOnly && !ctx.hasPlus) {
        ctx.note(`${probe.name} skipped: account has no Plus`);
        continue;
      }
      const fetchUnder = async (apiVersion: string): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> => {
        try {
          const body = await client.request<unknown>(probe.endpoint, { method: "GET", params: probe.params, apiVersion });
          return { ok: true, body };
        } catch (e) {
          // Status only: an error body can echo request details.
          const status = (e as { statusCode?: number }).statusCode;
          return { ok: false, error: `HTTP ${status ?? "error"}` };
        }
      };
      const oldRes = await fetchUnder(SKYLIGHT_API_VERSION);
      const newRes = await fetchUnder(APP_VERSION);

      if (!oldRes.ok || !newRes.ok) {
        const o = oldRes.ok ? "ok" : oldRes.error;
        const n = newRes.ok ? "ok" : newRes.error;
        if (probe.control) controlResult = "error";
        problems.push(`${probe.name}: ${SKYLIGHT_API_VERSION} -> ${o}; ${APP_VERSION} -> ${n}`);
        continue;
      }

      const counts = [itemCount(oldRes.body), itemCount(newRes.body)];
      // An empty list has no item shape to compare, so "same" would be vacuous.
      if (counts.every((c) => c === 0)) empty.push(probe.name);

      const diff = diffShapes(oldRes.body, newRes.body);
      if (probe.control) {
        if (counts.every((c) => c === 0)) controlResult = "inconclusive";
        else controlResult = isSameShape(diff) ? "same" : "differs";
        ctx.note(
          `control ${probe.name}: ${SKYLIGHT_API_VERSION} only: [${diff.onlyOld.join(", ") || "none"}]; ${APP_VERSION} only: [${diff.onlyNew.join(", ") || "none"}]`,
        );
        continue;
      }
      if (isSameShape(diff)) {
        same.push(probe.name);
      } else if (isAccepted(probe.name, diff.onlyOld, diff.onlyNew)) {
        accepted.push(probe.name);
      } else {
        problems.push(
          `${probe.name}: only under ${SKYLIGHT_API_VERSION}: [${diff.onlyOld.join(", ") || "none"}]; only under ${APP_VERSION}: [${diff.onlyNew.join(", ") || "none"}]`,
        );
      }
    }

    ctx.note(`same shape under both versions: ${same.join(", ") || "none"}`);
    ctx.note(`accepted additions (reviewed): ${accepted.join(", ") || "none"}`);
    ctx.note(`EMPTY under both versions, so item shape was NOT compared: ${empty.join(", ") || "none"}`);
    ctx.note(`positive control (nudges differ under the older version): ${controlResult}`);

    // The control must differ, or this test cannot see version differences.
    if (controlResult === "same") problems.push("control: nudges did NOT differ under the older version, so this test cannot detect version differences");
    // No messages in the window: the control could not run. Not a failure (proving it would need a
    // message that shows on the family's devices), but the note above says so and the result is unproven.
    // The report is the result. A non-empty list fails the test so a difference cannot be missed.
    expect(problems, `shape differences between versions:\n${problems.join("\n")}`).toEqual([]);
  });
});
