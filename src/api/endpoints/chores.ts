import { getClient } from "../client.js";
import type {
  ChoresResponse,
  ChoreResponse,
  ChoreResource,
  CategoryResource,
  UpdateChoreRequest,
} from "../types.js";

/**
 * A chore is done when Skylight says so. The live API reports `complete` (seen on a
 * real chore and in the web app's completion response); older code and docs said
 * `completed`. Accept both so neither a Skylight change nor an old value flips a done chore to pending.
 */
export function isChoreDone(status: string | null | undefined): boolean {
  return status === "complete" || status === "completed";
}

export interface GetChoresOptions {
  after?: string;
  before?: string;
  includeLate?: boolean;
  /** Shared "Up for Grabs" chores. The web app always asks for them; without this they are never returned. */
  includeUpForGrabs?: boolean;
  filterLinkedToProfile?: boolean;
}

export interface GetChoresResult {
  chores: ChoreResource[];
  categories: CategoryResource[];
}

/**
 * Get chores for a date range
 */
export async function getChores(options: GetChoresOptions = {}): Promise<GetChoresResult> {
  const client = getClient();
  const params: Record<string, string | boolean | undefined> = {
    after: options.after,
    before: options.before,
    include_late: options.includeLate,
    include_up_for_grabs: options.includeUpForGrabs,
  };

  if (options.filterLinkedToProfile) {
    params.filter = "linked_to_profile";
  }

  const response = await client.get<ChoresResponse>(
    "/api/frames/{frameId}/chores",
    params
  );

  return {
    chores: response.data,
    categories: response.included ?? [],
  };
}

export interface CreateChoreOptions {
  summary: string;
  start: string;
  startTime?: string;
  /** Profile (category) ids. The API requires at least one: without it Skylight answers 422 "Category is required." */
  categoryIds: string[];
  rewardPoints?: number;
  emojiIcon?: string;
}

/**
 * Create a one-off chore: `POST /chores/create_multiple` with a flat body (captured from the web app,
 * success case). Skylight returns an array, one chore per profile; the first is returned here.
 * Recurrence is not sent: only the routine shape has been captured.
 */
export async function createChore(options: CreateChoreOptions): Promise<ChoreResource[]> {
  const client = getClient();
  const body: Record<string, unknown> = {
    summary: options.summary,
    start: options.start,
    start_time: options.startTime ?? null,
    category_ids: options.categoryIds,
    routine: false,
    up_for_grabs: false,
    recurrence_set: null,
    recurring_until: null,
    renewal_interval: null,
    renewal_unit: null,
  };
  // reward_points is verified for one-off chores (web app capture, 1 star). emoji_icon is known from the routine capture only. Both are sent only when asked for.
  if (options.rewardPoints !== undefined) body.reward_points = options.rewardPoints;
  if (options.emojiIcon !== undefined) body.emoji_icon = options.emojiIcon;

  const response = await client.request<{ data?: ChoreResource[] }>("/api/frames/{frameId}/chores/create_multiple", {
    method: "POST",
    body,
  });
  const created = response.data ?? [];
  if (created.length === 0) throw new Error("Skylight accepted the chore but returned no chore; check get_chores before retrying.");
  return created;
}

export interface UpdateChoreOptions {
  summary?: string;
  start?: string;
  startTime?: string | null;
  status?: string;
  recurring?: boolean;
  recurrenceSet?: string | null;
  categoryId?: string | null;
  rewardPoints?: number | null;
  emojiIcon?: string | null;
}

/**
 * Update an existing chore
 */
export async function updateChore(
  choreId: string,
  options: UpdateChoreOptions
): Promise<ChoreResource> {
  const client = getClient();

  const request: UpdateChoreRequest = {
    data: {
      type: "chore",
      attributes: {},
    },
  };

  // Map options to attributes
  if (options.summary !== undefined) request.data.attributes.summary = options.summary;
  if (options.start !== undefined) request.data.attributes.start = options.start;
  if (options.startTime !== undefined) request.data.attributes.start_time = options.startTime;
  if (options.status !== undefined) request.data.attributes.status = options.status;
  if (options.recurring !== undefined) request.data.attributes.recurring = options.recurring;
  if (options.recurrenceSet !== undefined) request.data.attributes.recurrence_set = options.recurrenceSet;
  if (options.rewardPoints !== undefined) request.data.attributes.reward_points = options.rewardPoints;
  if (options.emojiIcon !== undefined) request.data.attributes.emoji_icon = options.emojiIcon;

  // Handle category relationship
  if (options.categoryId !== undefined) {
    if (options.categoryId === null) {
      request.data.relationships = { category: { data: null } };
    } else {
      request.data.relationships = {
        category: { data: { type: "category", id: options.categoryId } },
      };
    }
  }

  const response = await client.request<ChoreResponse>(
    `/api/frames/{frameId}/chores/${choreId}`,
    { method: "PUT", body: request }
  );

  return response.data;
}

/**
 * Delete a chore
 */
export async function deleteChore(choreId: string): Promise<void> {
  const client = getClient();
  await client.request(`/api/frames/{frameId}/chores/${choreId}`, {
    method: "DELETE",
  });
}

/** A recurring-chore occurrence id: `{series id}-{YYYY-MM-DD}-{HHMM}`. */
const OCCURRENCE_ID = /^(\d+)-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})$/;

export interface ChoreOccurrence {
  seriesId: string;
  instanceDate: string;
  instanceTime: string;
}

/** Split an occurrence id from get_chores into the pieces the completions endpoint wants. Null for any other id (one-off chores, junk). */
export function parseOccurrenceId(id: string): ChoreOccurrence | null {
  const m = OCCURRENCE_ID.exec(id);
  if (!m) return null;
  return { seriesId: m[1], instanceDate: m[2], instanceTime: `${m[3]}:${m[4]}` };
}

export interface CompletionResult {
  summary: string | null;
  status: string | null;
  /** Points balance after the change, when Skylight reports it. */
  pointsBalance: number | null;
  pointsLifetime: number | null;
  currentStreak: number | null;
  longestStreak: number | null;
}

/**
 * Mark one occurrence of a recurring chore (routine) complete or pending.
 * Verified live: the series id goes in the path, the occurrence date/time in the body.
 */
export async function completeChoreOccurrence(
  occurrence: ChoreOccurrence,
  complete: boolean,
  completedOn: string
): Promise<CompletionResult> {
  const client = getClient();
  const body: Record<string, unknown> = complete
    ? { status: "complete", instance_date: occurrence.instanceDate, instance_time: occurrence.instanceTime, completed_on: completedOn }
    : { status: "pending", instance_date: occurrence.instanceDate, instance_time: occurrence.instanceTime };

  const res = await client.request<{
    data?: { attributes?: { summary?: string; status?: string } };
    meta?: { reward_points?: { current_point_balance?: number; lifetime_points_earned?: number } };
    included?: Array<{ type?: string; attributes?: { current_streak?: number; longest_streak?: number } }>;
  }>(`/api/frames/{frameId}/chores/${occurrence.seriesId}/completions`, { method: "PUT", body });

  const tracker = res.included?.find((i) => i.type === "habit_tracker");
  return {
    summary: res.data?.attributes?.summary ?? null,
    status: res.data?.attributes?.status ?? null,
    pointsBalance: res.meta?.reward_points?.current_point_balance ?? null,
    pointsLifetime: res.meta?.reward_points?.lifetime_points_earned ?? null,
    currentStreak: tracker?.attributes?.current_streak ?? null,
    longestStreak: tracker?.attributes?.longest_streak ?? null,
  };
}

export type DeleteScope = "future" | "all";

/**
 * Delete a recurring chore or routine. The app sends `DELETE /chores/{occurrence id}?apply_to=future|all`
 * (captured live; 200 with an empty body). "future" is "this and future tasks", "all" is the whole series.
 */
export async function deleteChoreOccurrence(occurrenceId: string, scope: DeleteScope): Promise<void> {
  const client = getClient();
  await client.request(`/api/frames/{frameId}/chores/${occurrenceId}`, {
    method: "DELETE",
    params: { apply_to: scope },
  });
}

export type TimeOfDay = "morning" | "afternoon" | "evening";
export type WeekDay = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export const WEEK_DAYS: readonly WeekDay[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
/** The web app's "In the" choices: Morning 6, Afternoon 14, Evening 20 (all captured live). */
export const TIME_OF_DAY_HOUR: Record<TimeOfDay, number> = { morning: 6, afternoon: 14, evening: 20 };

/** A weekly routine rule exactly as the web app writes it. Only the weekly shape has been captured. */
export function buildWeeklyRule(days: readonly WeekDay[], timeOfDay: TimeOfDay): string {
  const ordered = WEEK_DAYS.filter((d) => days.includes(d));
  return `RRULE:FREQ=WEEKLY;INTERVAL=1;WKST=SU;BYHOUR=${TIME_OF_DAY_HOUR[timeOfDay]};BYDAY=${ordered.join(",")}`;
}

export interface ChoreEditResult {
  /** Skylight re-keys a chore on every edit: this is the id to use from now on. */
  newId: string | null;
  summary: string | null;
  recurrenceSet: string[] | null;
}

/**
 * Edit a recurring chore or routine. The web app sends a flat body (not JSON:API) to
 * `PUT /chores/{occurrence id}`; both a rename (`{summary}`) and a schedule change
 * (`{recurrence_set}`) were captured live, and each returned a new series id.
 */
export async function updateChoreOccurrence(
  occurrenceId: string,
  changes: { summary?: string; recurrenceSet?: string[] }
): Promise<ChoreEditResult> {
  const client = getClient();
  const body: Record<string, unknown> = {};
  if (changes.summary !== undefined) body.summary = changes.summary;
  if (changes.recurrenceSet !== undefined) body.recurrence_set = changes.recurrenceSet;
  const res = await client.request<{ data?: { id?: string; attributes?: { summary?: string; recurrence_set?: string[] } } }>(
    `/api/frames/{frameId}/chores/${occurrenceId}`,
    { method: "PUT", body }
  );
  return {
    newId: res.data?.id ?? null,
    summary: res.data?.attributes?.summary ?? null,
    recurrenceSet: res.data?.attributes?.recurrence_set ?? null,
  };
}

export interface CreateRoutineOptions {
  summary: string;
  start: string;
  categoryIds: string[];
  recurrenceSet: string[];
  trackHabit: boolean;
  rewardPoints: number | null;
  emojiIcon: string | null;
}

/** Create a routine for one or more profiles: `POST /chores/create_multiple` (captured live), one chore per profile. */
export async function createRoutine(options: CreateRoutineOptions): Promise<Array<{ id: string; summary: string }>> {
  const client = getClient();
  const res = await client.request<{ data?: Array<{ id: string; attributes?: { summary?: string } }> }>(
    "/api/frames/{frameId}/chores/create_multiple",
    {
      method: "POST",
      body: {
        summary: options.summary,
        start: options.start,
        category_ids: options.categoryIds,
        routine: true,
        track_habit: options.trackHabit,
        up_for_grabs: false,
        emoji_icon: options.emojiIcon,
        reward_points: options.rewardPoints,
        recurrence_set: options.recurrenceSet,
        recurring_until: null,
        renewal_interval: null,
        renewal_unit: null,
        start_time: null,
      },
    }
  );
  return (res.data ?? []).map((c) => ({ id: c.id, summary: c.attributes?.summary ?? options.summary }));
}
