import { getClient } from "../client.js";
import { cachedLookup, clearLookupCache } from "../lookup-cache.js";
import type { CategoriesResponse, CategoryResource } from "../types.js";

/**
 * Get all categories (family members/profiles)
 */
export async function getCategories(useCache = true): Promise<CategoryResource[]> {
  return cachedLookup(
    "categories",
    async () => (await getClient().get<CategoriesResponse>("/api/frames/{frameId}/categories")).data,
    !useCache
  );
}

/**
 * Clear the categories cache
 */
export function clearCategoriesCache(): void {
  clearLookupCache();
}

/**
 * Get categories that are linked to profiles (actual family members)
 */
export async function getFamilyMembers(): Promise<CategoryResource[]> {
  const categories = await getCategories();
  return categories.filter((cat) => cat.attributes.linked_to_profile);
}

/**
 * Get categories selected for the chore chart
 */
export async function getChoreChartCategories(): Promise<CategoryResource[]> {
  const categories = await getCategories();
  return categories.filter((cat) => cat.attributes.selected_for_chore_chart);
}

/**
 * Turn profile names into category IDs. Exact match, case-insensitive, no partial
 * matching, so "Alex" never resolves to "Alexander".
 * Unknown names fail with the valid list so nothing is ever sent to a guess.
 */
export async function resolveProfileIds(names: string[]): Promise<{ ids: string[]; labels: string[] }> {
  const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (wanted.length === 0) throw new Error("Give at least one profile name.");
  const poolOf = (all: CategoryResource[]): CategoryResource[] => {
    const linked = all.filter((c) => c.attributes.linked_to_profile);
    return linked.length > 0 ? linked : all;
  };
  let pool = poolOf(await getCategories());
  // A profile added since the list was cached must not be rejected as unknown: look once more, fresh.
  const unknown = (): boolean => wanted.some((n) => !pool.some((c) => c.attributes.label?.toLowerCase() === n.toLowerCase()));
  if (unknown()) pool = poolOf(await getCategories(false));
  const ids: string[] = [];
  const labels: string[] = [];
  for (const name of wanted) {
    const hits = pool.filter((c) => c.attributes.label?.toLowerCase() === name.toLowerCase());
    if (hits.length !== 1) {
      const known = pool.map((c) => c.attributes.label).filter(Boolean).join(", ");
      throw new Error(
        hits.length === 0
          ? `No profile called "${name}". Profiles: ${known}.`
          : `"${name}" matches ${hits.length} profiles; rename one in Skylight. Profiles: ${known}.`
      );
    }
    if (!ids.includes(hits[0]!.id)) {
      ids.push(hits[0]!.id);
      labels.push(hits[0]!.attributes.label ?? name);
    }
  }
  return { ids, labels };
}

/** One profile by exact name (case-insensitive); throws with the valid names when unknown or ambiguous. */
export async function resolveProfile(name: string): Promise<{ id: string; label: string }> {
  const { ids, labels } = await resolveProfileIds([name]);
  return { id: ids[0]!, label: labels[0]! };
}
