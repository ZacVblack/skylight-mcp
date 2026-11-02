import { getClient } from "../client.js";
import { addDays } from "../../utils/schedule.js";

// Meal types
export interface MealCategoryResource {
  type: "meal_category";
  id: string;
  attributes: {
    /** Skylight calls the display name `label`; older code assumed `name`. */
    label?: string;
    name?: string;
    color?: string;
    position?: number;
    [key: string]: unknown;
  };
}

/** Display name of a meal category, whichever field the API used. */
export function mealCategoryName(category: MealCategoryResource): string {
  return category.attributes.label ?? category.attributes.name ?? "Unnamed";
}

export interface MealRecipeResource {
  type: "meal_recipe";
  id: string;
  attributes: {
    summary?: string;
    description?: string | null;
    [key: string]: unknown;
  };
  relationships?: {
    meal_category?: {
      data: { type: string; id: string } | null;
    };
  };
}

export interface MealSittingResource {
  type: "meal_sitting";
  id: string;
  attributes: {
    /** Free-text meal name, e.g. "Thai green curry". May be empty when a recipe is linked. */
    summary?: string | null;
    /** Dates (YYYY-MM-DD) this sitting appears on. */
    instances?: string[];
    date?: string;
    meal_time?: string;
    [key: string]: unknown;
  };
  relationships?: {
    meal_recipe?: {
      data: { type: string; id: string } | null;
    };
    meal_category?: {
      data: { type: string; id: string } | null;
    };
  };
}

interface MealCategoriesResponse {
  data: MealCategoryResource[];
}

interface MealRecipesResponse {
  data: MealRecipeResource[];
  included?: MealCategoryResource[];
}

interface MealRecipeResponse {
  data: MealRecipeResource;
  included?: MealCategoryResource[];
}

interface MealSittingsResponse {
  data: MealSittingResource[];
  included?: MealRecipeResource[];
}

/**
 * Get meal categories (Breakfast, Lunch, Dinner, etc.)
 */
export async function getMealCategories(): Promise<MealCategoryResource[]> {
  const client = getClient();
  const response = await client.get<MealCategoriesResponse>(
    "/api/frames/{frameId}/meals/categories"
  );
  return response.data;
}

export interface GetRecipesOptions {
  include?: string;
}

/**
 * Get all recipes
 */
export async function getRecipes(options: GetRecipesOptions = {}): Promise<MealRecipeResource[]> {
  const client = getClient();
  const response = await client.get<MealRecipesResponse>(
    "/api/frames/{frameId}/meals/recipes",
    { include: options.include ?? "meal_category" }
  );
  return response.data;
}

/**
 * Get a specific recipe
 */
export async function getRecipe(recipeId: string): Promise<MealRecipeResource> {
  const client = getClient();
  const response = await client.get<MealRecipeResponse>(
    `/api/frames/{frameId}/meals/recipes/${recipeId}`,
    { include: "meal_category" }
  );
  return response.data;
}

export interface CreateRecipeOptions {
  summary: string;
  description?: string;
  mealCategoryId?: string;
}

/**
 * Create a new recipe
 */
export async function createRecipe(options: CreateRecipeOptions): Promise<MealRecipeResource> {
  const client = getClient();
  const body: Record<string, unknown> = {
    summary: options.summary,
    description: options.description ?? null,
  };
  if (options.mealCategoryId) {
    body.meal_category_id = options.mealCategoryId;
  }
  const response = await client.post<MealRecipeResponse>(
    "/api/frames/{frameId}/meals/recipes",
    body
  );
  return response.data;
}

export interface UpdateRecipeOptions {
  summary?: string;
  description?: string | null;
  mealCategoryId?: string | null;
}

/**
 * Update a recipe
 */
export async function updateRecipe(
  recipeId: string,
  options: UpdateRecipeOptions
): Promise<MealRecipeResource> {
  const client = getClient();
  const body: Record<string, unknown> = {};
  if (options.summary !== undefined) body.summary = options.summary;
  if (options.description !== undefined) body.description = options.description;
  if (options.mealCategoryId !== undefined) body.meal_category_id = options.mealCategoryId;

  const response = await client.request<MealRecipeResponse>(
    `/api/frames/{frameId}/meals/recipes/${recipeId}`,
    { method: "PATCH", body }
  );
  return response.data;
}

/**
 * Delete a recipe
 */
export async function deleteRecipe(recipeId: string): Promise<void> {
  const client = getClient();
  await client.request(`/api/frames/{frameId}/meals/recipes/${recipeId}`, {
    method: "DELETE",
  });
}

/**
 * Add recipe ingredients to grocery list
 */
export async function addRecipeToGroceryList(recipeId: string): Promise<void> {
  const client = getClient();
  await client.post(
    `/api/frames/{frameId}/meals/recipes/${recipeId}/add_to_grocery_list`,
    {}
  );
}

export interface GetMealSittingsOptions {
  dateMin?: string;
  dateMax?: string;
}

/**
 * Get meal sittings (scheduled meals)
 */
export async function getMealSittings(
  options: GetMealSittingsOptions = {}
): Promise<MealSittingResource[]> {
  const client = getClient();
  const params: Record<string, string | undefined> = {};
  if (options.dateMin) params.date_min = options.dateMin;
  if (options.dateMax) params.date_max = options.dateMax;

  const response = await client.get<MealSittingsResponse>(
    "/api/frames/{frameId}/meals/sittings",
    params
  );
  return response.data;
}

export interface CreateMealSittingOptions {
  date: string;
  mealCategoryId: string;
  /** Free-text meal name. Either this or recipeId should be given. */
  summary?: string;
  recipeId?: string;
  /** Repeat weekly on the weekday of `date`. Only this shape was captured. */
  repeat?: "weekly";
}

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/** Weekday code (SU..SA) of a YYYY-MM-DD date, independent of time zone. */
export function weekdayCode(date: string): string {
  assertIsoDate(date);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return WEEKDAY_CODES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

/** The rule the web app sends for "repeats every 1 week on <weekday>". */
export function weeklyRrule(date: string): string {
  return `FREQ=WEEKLY;INTERVAL=1;WKST=SU;BYDAY=${weekdayCode(date)}`;
}

/**
 * Create a meal sitting (schedule a meal)
 */
export async function createMealSitting(
  options: CreateMealSittingOptions
): Promise<MealSittingResource> {
  const client = getClient();
  const body: Record<string, unknown> = {
    date: options.date,
    meal_category_id: options.mealCategoryId,
  };
  if (options.summary) {
    body.summary = options.summary;
  }
  if (options.recipeId) {
    body.meal_recipe_id = options.recipeId;
  }

  if (options.repeat === "weekly") {
    // A repeating create sends the web app's whole form (captured 2026-11-01).
    // Not verified live from this code path: the body shape and API version.
    const form = {
      date: options.date,
      summary: options.summary ?? "",
      description: "",
      note: "",
      meal_category_id: options.mealCategoryId,
      meal_recipe_id: options.recipeId ?? null,
      profile_ids: [] as string[],
      rrule: weeklyRrule(options.date),
      add_to_grocery_list: false,
      saveToRecipeBox: false,
    };
    const created = await client.request<{ data: MealSittingResource | MealSittingResource[] }>(
      "/api/frames/{frameId}/meals/sittings",
      { method: "POST", body: form, apiVersion: MEAL_EDIT_API_VERSION }
    );
    const first = Array.isArray(created.data) ? created.data[0] : created.data;
    if (!first) throw new Error("Skylight returned an empty response when creating the repeating meal");
    return first;
  }

  // The API answers a create with a list envelope (one element), unlike GET by id.
  const response = await client.post<{ data: MealSittingResource | MealSittingResource[] }>(
    "/api/frames/{frameId}/meals/sittings",
    body
  );
  const data = Array.isArray(response.data) ? response.data[0] : response.data;
  if (!data) throw new Error("Skylight returned an empty response when creating the meal sitting");
  return data;
}

/**
 * Editing and deleting a sitting use the API version the web app sends; the
 * captures behind them were made with it. Create and list keep the repo default.
 */
export const MEAL_EDIT_API_VERSION = "2026-10-15";

/** Sitting ids are numeric. Validate before one ever reaches a URL path. */
export function assertSittingId(id: string): string {
  if (!/^\d{1,12}$/.test(id)) throw new Error("Sitting ID must be numeric (see get_meal_sittings).");
  return id;
}

/** A real calendar date as YYYY-MM-DD, validated before it reaches a URL path. */
export function assertIsoDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const valid = m && new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).toISOString().slice(0, 10) === date;
  if (!valid) throw new Error("Date must be a real calendar date in YYYY-MM-DD form.");
  return date;
}

interface SittingEnvelope {
  data?: MealSittingResource[];
  meta?: { deleted_sitting_ids?: Array<string | number> };
}

function instanceQuery(date: string): Record<string, string> {
  return {
    date_min: date,
    date_max: addDays(date, 1),
    include: "meal_category,meal_recipe,profiles",
  };
}

/**
 * Find the sitting that has an occurrence on `date`. Read under the edit API
 * version so recurring/rrule fields are present for the one-off guard.
 */
export async function findMealSitting(sittingId: string, date: string): Promise<MealSittingResource | null> {
  assertSittingId(sittingId);
  assertIsoDate(date);
  const response = await getClient().request<SittingEnvelope>("/api/frames/{frameId}/meals/sittings", {
    method: "GET",
    params: instanceQuery(date),
    apiVersion: MEAL_EDIT_API_VERSION,
  });
  return (response.data ?? []).find((s) => s.id === sittingId && s.attributes.instances?.includes(date)) ?? null;
}

export type MealKind = "one-off" | "series" | "detached";

/**
 * one-off: not repeating. series: carries an rrule. detached: an occurrence
 * that was edited on its own; it has no rrule but still reports
 * `recurring: true` (captured 2026-11-01).
 */
export function mealKind(sitting: MealSittingResource): MealKind {
  const a = sitting.attributes;
  if (a.rrule) return "series";
  if (a.recurring === true) return "detached";
  return "one-off";
}

/** Editing repeating meals is not supported yet; only one-offs are edited here. */
function assertOneOff(sitting: MealSittingResource): void {
  if (mealKind(sitting) !== "one-off") {
    throw new Error(
      "This meal repeats. Editing an occurrence of a repeating meal is not supported here; use the Skylight app."
    );
  }
}

export type MealDeleteScope = "one" | "future" | "all";

export interface UpdateMealSittingOptions {
  existing: MealSittingResource;
  /** The occurrence being edited (its current date). */
  date: string;
  /** Move the meal to this date. */
  newDate?: string;
  summary?: string;
  note?: string;
  mealCategoryId?: string;
}

/**
 * Edit a one-off sitting the way the web app does: PATCH the whole form to
 * /meals/sittings/{id}/instances/{currentDate}. Fields not being changed are
 * sent back as they are, because the API takes the full form.
 */
export async function updateMealSitting(options: UpdateMealSittingOptions): Promise<void> {
  const { existing } = options;
  assertOneOff(existing);
  const date = assertIsoDate(options.date);
  const target = assertIsoDate(options.newDate ?? date);
  const a = existing.attributes;
  const payload = {
    date: target,
    note: options.note ?? (typeof a.note === "string" ? a.note : ""),
    rrule: null,
    summary: options.summary ?? a.summary ?? "",
    description: typeof a.description === "string" ? a.description : "",
    meal_category_id: options.mealCategoryId ?? existing.relationships?.meal_category?.data?.id ?? null,
    meal_recipe_id: existing.relationships?.meal_recipe?.data?.id ?? null,
    profile_ids: ((existing.relationships as { profiles?: { data?: Array<{ id: string }> } } | undefined)?.profiles?.data ?? []).map(
      (p) => p.id
    ),
    saveToRecipeBox: false,
  };
  await getClient().request<SittingEnvelope>(
    `/api/frames/{frameId}/meals/sittings/${assertSittingId(existing.id)}/instances/${date}`,
    { method: "PATCH", body: payload, params: instanceQuery(date), apiVersion: MEAL_EDIT_API_VERSION }
  );
}

/**
 * Delete a sitting: DELETE /meals/sittings/{id}/instances/{date}, no body.
 * A one-off sends no scope. A repeating series sends `apply_to` (captured
 * 2026-11-01): `one` excludes that date, `future` ends the series before it,
 * `all` removes the whole series. A detached occurrence is refused.
 * Returns whether Skylight's response confirms the removal.
 */
export async function deleteMealSitting(
  existing: MealSittingResource,
  date: string,
  scope: MealDeleteScope = "one"
): Promise<boolean> {
  assertIsoDate(date);
  const id = assertSittingId(existing.id);
  const kind = mealKind(existing);
  if (kind === "detached") {
    throw new Error(
      "This occurrence was edited on its own and is detached from its series. Deleting it is not supported here; use the Skylight app."
    );
  }
  const params = instanceQuery(date);
  if (kind === "series") params.apply_to = scope;
  const response = await getClient().request<SittingEnvelope>(
    `/api/frames/{frameId}/meals/sittings/${id}/instances/${date}`,
    { method: "DELETE", params, apiVersion: MEAL_EDIT_API_VERSION }
  );
  const deleted = (response?.meta?.deleted_sitting_ids ?? []).map(String).includes(id);
  if (kind === "one-off" || scope === "all") return deleted;
  // one / future leave the series in place: it is returned without the date.
  const left = (response.data ?? []).find((s) => s.id === id);
  return !!left && !(left.attributes.instances ?? []).includes(date);
}
