import { getClient } from "./client.js";

/**
 * Small lookup cache for data that rarely changes (profiles, meal categories).
 *
 * Scoped to the client of the current request, never process-wide:
 * - Hosted Worker: a fresh client per request, so this only saves repeat calls
 *   within one request and nothing ever crosses users or frames.
 * - Local server: one long-lived client, so entries live up to LOOKUP_TTL_MS.
 */
export const LOOKUP_TTL_MS = 5 * 60 * 1000;

interface Entry {
  at: number;
  value: unknown;
}

let store = new WeakMap<object, Map<string, Entry>>();

export async function cachedLookup<T>(key: string, load: () => Promise<T>, bypass = false): Promise<T> {
  const client = getClient();
  let entries = store.get(client);
  if (!entries) {
    entries = new Map();
    store.set(client, entries);
  }
  const hit = entries.get(key);
  if (!bypass && hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.value as T;
  const value = await load();
  entries.set(key, { at: Date.now(), value });
  return value;
}

/** Drop every cached lookup (tests, and anything that just changed a profile or category). */
export function clearLookupCache(): void {
  store = new WeakMap();
}
