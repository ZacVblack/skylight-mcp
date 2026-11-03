const FEED_URL = /^(https?|webcals?):\/\//i;

/**
 * Subscription feed addresses (published iCloud calendars, league schedules
 * with a user id in the query) work like passwords: anyone holding the URL can
 * read the calendar. Tool output goes to assistants and logs, so only the scheme
 * and host are kept. Anything that is not an http, https, webcal or webcals URL
 * is returned unchanged.
 */
export function redactFeedUrl(value: string): string {
  const trimmed = value.trim();
  if (!FEED_URL.test(trimmed)) return value;
  const scheme = (/^[a-z]+/i.exec(trimmed) as RegExpExecArray)[0].toLowerCase();
  try {
    // URL() does not parse webcal: hosts the same way on every runtime, so
    // parse as https and keep the original scheme for display.
    const host = new URL(trimmed.replace(/^[a-z]+:/i, "https:")).hostname;
    return `${scheme}://${host}/... (feed address hidden)`;
  } catch {
    return "(feed address hidden)";
  }
}

/**
 * Hosts whose URLs are public and carry no secret (Skylight's stock avatar CDN).
 * A URL on one of these is kept only when it has no query string or credentials.
 */
const PUBLIC_ASSET_HOSTS = new Set(["skylight-frame-res.cloudinary.com"]);

/**
 * Attributes whose value is text a person wrote. A link in a meeting invite or a
 * recipe is content, not a subscription secret, so these keep their URLs.
 */
const FREE_TEXT_KEYS = new Set(["summary", "description", "note", "location", "name", "label", "title", "instructions"]);

function isPublicAsset(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && PUBLIC_ASSET_HOSTS.has(url.hostname) && !url.search && !url.username && !url.password;
  } catch {
    return false;
  }
}

function redactString(key: string, value: string): string {
  if (FREE_TEXT_KEYS.has(key)) return value;
  if (isPublicAsset(value)) return value;
  return redactFeedUrl(value);
}

/**
 * Format one attribute value for tool output. Every tool that prints raw
 * attributes must go through this, so a secret URL cannot reach the transcript
 * from a field nobody thought to check: strings, arrays and nested objects are
 * all covered. Plain values print as before.
 */
export function formatAttribute(key: string, value: unknown): string {
  if (typeof value === "string") return redactString(key, value);
  if (Array.isArray(value) && value.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))) {
    return value.map((v) => (typeof v === "string" ? redactString(key, v) : String(v))).join(",");
  }
  if (value !== null && typeof value === "object") {
    return JSON.stringify(value, (k, v) => (typeof v === "string" ? redactString(k || key, v) : v));
  }
  return String(value);
}
