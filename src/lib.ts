/**
 * Library entry point (experimental). The only module an importer may load:
 * package.json `exports` lists this file and nothing else.
 *
 *   import { createSkylight } from "@davidwoods/skylight-mcp";
 *
 * Guarantees, each covered by tests/library-*.test.ts from the importer's side:
 * - The API host is pinned in code. There is no host, base URL or fetch option; an
 *   unknown option is refused, not ignored.
 * - Returned objects are plain JSON-safe DTOs. They never carry emails, event uids,
 *   calendar or account ids, or a subscription feed address.
 * - No function takes a URL or a feed address (so the feed-address helper is not exported either).
 * - Importing this module starts nothing and reads nothing from process.argv.
 *
 * Phase 1 is read-only. Writes, deletes, messages, source-calendar management and
 * login are deliberately not exported.
 *
 * Honest limit: an importer holds a live bearer token and can do whatever the token
 * allows. These guards stop accidents and token leakage, not a malicious importer.
 */

import type { Config } from "./config.js";
import { SkylightClient } from "./api/client.js";
import type { CredentialStore } from "./api/credential-types.js";
import { runWithContext } from "./context.js";
import { getCalendarEvents, getSourceCalendars } from "./api/endpoints/calendar.js";
import { getCategories } from "./api/endpoints/categories.js";
import { getChores } from "./api/endpoints/chores.js";
import { getListWithItems, getLists } from "./api/endpoints/lists.js";
import { getMealCategories, getMealSittings, getRecipes, mealCategoryName } from "./api/endpoints/meals.js";
import { isChoreDone } from "./api/endpoints/chores.js";
import { addDays } from "./utils/schedule.js";
import { redactFeedUrl } from "./utils/redact.js";
import type { CalendarEventResource, CategoryResource, ChoreResource, SourceCalendarResource } from "./api/types.js";

export type { CredentialStore };

/** Where the sign-in comes from: a store that refreshes it, or a fixed token that does not. */
export type SkylightCredential = CredentialStore | { token: string };

export interface CreateSkylightOptions {
  /** Household id: digits, from the Skylight web app's URLs. */
  frameId: string;
  /** IANA zone, for example "America/Los_Angeles". */
  timezone: string;
  credential: SkylightCredential;
}

/**
 * An event. `id` is opaque: a repeating event's occurrence ids embed the start time and
 * CHANGE after a time edit, so never store or compare ids across edits. `seriesId` is the
 * series number for occurrences of a repeating event, else null.
 */
export interface EventDto {
  id: string;
  title: string;
  /** ISO 8601 with offset, or a local-midnight stamp for all-day events. */
  start: string | null;
  end: string | null;
  allDay: boolean;
  location: string | null;
  profiles: string[];
  labels: string[];
  recurring: boolean;
  seriesId: string | null;
  editable: boolean;
  source: "skylight" | "google" | "feed" | "other";
}

export interface SourceDto {
  id: string;
  /** An email-shaped label is replaced, so no address leaves the library. */
  label: string;
  kind: "google" | "feed" | "other";
  role: string | null;
  editable: boolean;
  /** Scheme and host of a subscription feed only; null otherwise. */
  host: string | null;
}

export interface ProfileDto {
  id: string;
  label: string;
  color: string | null;
}

export interface ChoreDto {
  id: string;
  title: string;
  date: string | null;
  time: string | null;
  status: string;
  done: boolean;
  profile: string | null;
  upForGrabs: boolean;
  routine: boolean;
  recurring: boolean;
  points: number | null;
}

export interface MealSittingDto {
  id: string;
  dates: string[];
  title: string | null;
  category: string | null;
  recipeId: string | null;
  recurring: boolean;
}

export interface RecipeDto {
  id: string;
  title: string | null;
}

export interface MealCategoryDto {
  id: string;
  name: string;
}

export interface ListDto {
  id: string;
  label: string;
  kind: string;
  color: string | null;
}

export interface ListItemDto {
  id: string;
  label: string;
  done: boolean;
  section: string | null;
}

export interface Skylight {
  calendar: {
    /** Events from `from` to `to`, both YYYY-MM-DD, both days included. */
    events(range: { from: string; to: string }): Promise<EventDto[]>;
    sources(): Promise<SourceDto[]>;
  };
  profiles: { list(): Promise<ProfileDto[]> };
  chores: { list(options: { date: string; profile?: string }): Promise<ChoreDto[]> };
  meals: {
    sittings(range: { from: string; to: string }): Promise<MealSittingDto[]>;
    recipes(): Promise<RecipeDto[]>;
    categories(): Promise<MealCategoryDto[]>;
  };
  lists: {
    list(): Promise<ListDto[]>;
    items(listId: string): Promise<ListItemDto[]>;
  };
}

// ---------------------------------------------------------------------------
// Validation: refuse, never ignore.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+/;
const OPTION_KEYS = new Set(["frameId", "timezone", "credential"]);

function assertDate(value: unknown, name: string): string {
  if (typeof value !== "string" || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${name} must be a date, YYYY-MM-DD.`);
  }
  return value;
}

function assertRange(range: { from: string; to: string }): { from: string; to: string } {
  const from = assertDate(range?.from, "from");
  const to = assertDate(range?.to, "to");
  if (to < from) throw new Error("to is before from.");
  return { from, to };
}

function isStore(value: unknown): value is CredentialStore {
  const v = value as Record<string, unknown> | null;
  return !!v && typeof v === "object" && typeof v.read === "function" && typeof v.write === "function" && typeof v.delete === "function";
}

function validateOptions(options: CreateSkylightOptions): { config: Config; store: CredentialStore | null } {
  if (!options || typeof options !== "object") throw new Error("createSkylight needs an options object.");
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) throw new Error(`Unknown option "${key}". The API host is fixed and cannot be configured.`);
  }
  const { frameId, timezone, credential } = options;
  if (typeof frameId !== "string" || !/^\d+$/.test(frameId)) throw new Error("frameId must be the household's numeric id.");
  if (typeof timezone !== "string") throw new Error("timezone must be an IANA zone name.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error("timezone must be an IANA zone name.");
  }
  if (isStore(credential)) {
    return { config: { frameId, timezone, authType: "bearer" }, store: credential };
  }
  const keys = credential && typeof credential === "object" ? Object.keys(credential) : [];
  if (keys.length === 1 && keys[0] === "token" && typeof (credential as { token: unknown }).token === "string" && (credential as { token: string }).token) {
    return { config: { frameId, timezone, authType: "bearer", token: (credential as { token: string }).token }, store: null };
  }
  throw new Error("credential must be a credential store or { token }.");
}

// ---------------------------------------------------------------------------
// Projection: raw JSON:API in, DTOs out. Every field is named here; nothing is spread.

function categoryIds(event: CalendarEventResource): string[] {
  const ids = new Set<string>();
  for (const ref of event.relationships?.categories?.data ?? []) if (ref?.id) ids.add(String(ref.id));
  const single = event.relationships?.category?.data?.id;
  if (single) ids.add(String(single));
  const fromAttrs = event.attributes.category_ids;
  if (Array.isArray(fromAttrs)) for (const id of fromAttrs) ids.add(String(id));
  return [...ids];
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function toEvent(event: CalendarEventResource, categories: Map<string, CategoryResource>): EventDto {
  const a = event.attributes;
  const profiles: string[] = [];
  const labels: string[] = [];
  for (const id of categoryIds(event)) {
    const c = categories.get(id);
    const label = str(c?.attributes.label);
    if (!c || !label) continue;
    (c.attributes.linked_to_profile === true ? profiles : labels).push(label);
  }
  const id = String(event.id);
  const composite = /^(\d+)-\d+$/.exec(id);
  const source = a.source === "skylight" ? "skylight" : a.source === "google" ? "google" : a.source === "ics_link" ? "feed" : "other";
  return {
    id,
    title: str(a.summary) ?? "",
    start: str(a.starts_at),
    end: str(a.ends_at),
    allDay: a.all_day === true,
    location: str(a.location),
    profiles,
    labels,
    recurring: a.recurring === true || a.recurring_config === true,
    seriesId: composite ? composite[1]! : null,
    editable: a.editable !== false,
    source,
  };
}

function toSource(cal: SourceCalendarResource): SourceDto {
  const a = cal.attributes;
  const kind = a.kind === "gmail" ? "google" : a.kind === "webcal" ? "feed" : "other";
  let label = str(a.label) ?? "";
  if (EMAIL.test(label)) label = kind === "google" ? "Google calendar" : "Calendar";
  const sourceId = str(a.source_id);
  const hostMatch = kind === "feed" && sourceId ? /^([a-z]+:\/\/[^/]+)/i.exec(redactFeedUrl(sourceId)) : null;
  return {
    id: String(cal.id),
    label,
    kind,
    role: str(a.role),
    editable: a.editable === true,
    host: hostMatch ? hostMatch[1]! : null,
  };
}

function toChore(chore: ChoreResource, names: Map<string, string>): ChoreDto {
  const a = chore.attributes;
  const cid = chore.relationships?.category?.data?.id;
  return {
    id: String(chore.id),
    title: str(a.summary) ?? "",
    date: str(a.start),
    time: str(a.start_time),
    status: str(a.status) ?? "",
    done: isChoreDone(a.status),
    profile: cid ? (names.get(String(cid)) ?? null) : null,
    upForGrabs: a.up_for_grabs === true,
    routine: a.routine === true,
    recurring: a.recurring === true,
    points: typeof a.reward_points === "number" ? a.reward_points : null,
  };
}

// ---------------------------------------------------------------------------

export function createSkylight(options: CreateSkylightOptions): Skylight {
  const { config, store } = validateOptions(options);
  const client = new SkylightClient(config, store);
  const run = <T>(fn: () => Promise<T>): Promise<T> => runWithContext({ client, config }, fn);

  return {
    calendar: {
      events: (range) =>
        run(async () => {
          const { from, to } = assertRange(range);
          const [events, categories] = await Promise.all([
            getCalendarEvents({ dateMin: from, dateMax: to, timezone: config.timezone }),
            getCategories(),
          ]);
          const byId = new Map(categories.map((c) => [String(c.id), c]));
          return events.map((e) => toEvent(e, byId));
        }),
      sources: () => run(async () => (await getSourceCalendars()).map(toSource)),
    },
    profiles: {
      list: () =>
        run(async () =>
          (await getCategories())
            .filter((c) => c.attributes.linked_to_profile === true && str(c.attributes.label))
            .map((c) => ({ id: String(c.id), label: c.attributes.label as string, color: str(c.attributes.color) }))
        ),
    },
    chores: {
      list: (opts) =>
        run(async () => {
          const date = assertDate(opts?.date, "date");
          const result = await getChores({ after: date, before: date, includeLate: false, includeUpForGrabs: true });
          const names = new Map(result.categories.map((c) => [String(c.id), c.attributes.label ?? ""]));
          let chores = result.chores.map((c) => toChore(c, names));
          if (opts.profile !== undefined) {
            if (typeof opts.profile !== "string") throw new Error("profile must be a profile name.");
            const wanted = opts.profile.trim().toLowerCase();
            chores = chores.filter((c) => c.profile?.toLowerCase() === wanted);
          }
          return chores;
        }),
    },
    meals: {
      sittings: (range) =>
        run(async () => {
          const { from, to } = assertRange(range);
          const [sittings, categories] = await Promise.all([
            getMealSittings({ dateMin: from, dateMax: addDays(to, 1) }),
            getMealCategories(),
          ]);
          const names = new Map(categories.map((c) => [String(c.id), mealCategoryName(c)]));
          return sittings.map((s) => {
            const a = s.attributes;
            const dates = a.instances?.length ? a.instances : a.date ? [a.date] : [];
            const cid = s.relationships?.meal_category?.data?.id;
            const rid = s.relationships?.meal_recipe?.data?.id;
            return {
              id: String(s.id),
              dates: dates.filter((d) => DATE.test(d) && d >= from && d <= to),
              title: str(a.summary),
              category: cid ? (names.get(String(cid)) ?? null) : null,
              recipeId: rid ? String(rid) : null,
              recurring: a.recurring === true || Boolean(a.rrule),
            };
          });
        }),
      recipes: () =>
        run(async () => (await getRecipes()).map((r) => ({ id: String(r.id), title: str(r.attributes.summary) }))),
      categories: () =>
        run(async () => (await getMealCategories()).map((c) => ({ id: String(c.id), name: mealCategoryName(c) }))),
    },
    lists: {
      list: () =>
        run(async () =>
          (await getLists()).map((l) => ({
            id: String(l.id),
            label: str(l.attributes.label) ?? "",
            kind: str(l.attributes.kind) ?? "",
            color: str(l.attributes.color),
          }))
        ),
      items: (listId) =>
        run(async () => {
          if (typeof listId !== "string" || !/^\d+$/.test(listId)) throw new Error("listId must be a numeric list id.");
          const { items } = await getListWithItems(listId);
          return items.map((i) => ({
            id: String(i.id),
            label: str(i.attributes.label) ?? "",
            done: i.attributes.status === "completed",
            section: str(i.attributes.section),
          }));
        }),
    },
  };
}
