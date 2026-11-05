/**
 * Structural fingerprint of a JSON value: the key paths and value types, never
 * the values. Used to compare what Skylight returns under two Skylight-Api-Version
 * values without printing anything from the family's real data.
 *
 * Properties (each has a test in tests/shape.test.ts):
 * - No value from the input ever appears in the output.
 * - Object keys that look like data (ids, dates, long tokens) are replaced by
 *   `<key>`, so a response keyed by an id cannot leak it through a path.
 * - Arrays collapse to `[]`: the shape is the union over all elements.
 */

const DATA_LIKE_KEY = /^\d+$|\d{4}-\d{2}-\d{2}|^[A-Za-z0-9_-]{24,}$/;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function walk(value: unknown, path: string, out: Set<string>): void {
  const type = typeOf(value);
  out.add(`${path || "$"}:${type}`);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, `${path}[]`, out);
  } else if (type === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const safe = DATA_LIKE_KEY.test(key) ? "<key>" : key;
      walk(child, path ? `${path}.${safe}` : safe, out);
    }
  }
}

/** The set of `path:type` entries in a JSON value. */
export function shapeOf(value: unknown): Set<string> {
  const out = new Set<string>();
  walk(value, "", out);
  return out;
}

export interface ShapeDiff {
  onlyOld: string[];
  onlyNew: string[];
}

/** Entries present under one version and not the other, sorted. */
export function diffShapes(oldValue: unknown, newValue: unknown): ShapeDiff {
  const a = shapeOf(oldValue);
  const b = shapeOf(newValue);
  return {
    onlyOld: [...a].filter((p) => !b.has(p)).sort(),
    onlyNew: [...b].filter((p) => !a.has(p)).sort(),
  };
}

export function isSameShape(diff: ShapeDiff): boolean {
  return diff.onlyOld.length === 0 && diff.onlyNew.length === 0;
}
