/**
 * Value-blind scan of tool output for things that look like secrets. Used by the
 * live redaction test, which runs every read tool against the real account.
 *
 * The result names a KIND of finding and a count, never the matched text, so the
 * report can be pasted into chat. Properties (each has a test in
 * tests/leak-scan.test.ts): it finds each kind, it ignores the allowed cases, and
 * no input text ever appears in its output.
 *
 * It is a tripwire, not a proof: it can miss a secret that looks like ordinary
 * text, and it can flag a harmless long link. A finding means "look at this
 * tool's output locally"; silence means "none of these shapes appeared".
 */

export type LeakKind = "feed-scheme" | "url-with-query" | "url-token-path" | "jwt-like" | "bare-token" | "bearer-header";

export interface LeakFinding {
  kind: LeakKind;
  /** The attribute name the value sat under (e.g. "image_url"), or "(other)". Names only, never values. */
  key: string;
  count: number;
}

/** Keys whose text a person wrote; a link there is content. Mirrors FREE_TEXT_KEYS in src/utils/redact.ts. */
const FREE_TEXT_KEYS = new Set(["summary", "description", "note", "location", "name", "label", "title", "instructions"]);

/** Public stock-asset host, allowed only without a query string. Mirrors redact.ts. */
const PUBLIC_ASSET_HOSTS = new Set(["skylight-frame-res.cloudinary.com"]);

const URL_RE = /\b(?:https?|webcals?):\/\/[^\s"'<>)\]]+/gi;
const TOKEN_CHARS = /^[A-Za-z0-9_-]+$/;

function hasLetterAndDigit(s: string): boolean {
  return /[A-Za-z]/.test(s) && /\d/.test(s);
}

function isStockAsset(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && PUBLIC_ASSET_HOSTS.has(u.hostname) && !u.search && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * The attribute name of a "  key: value" line as the tools print attributes
 * (two spaces, lowercase snake_case), or null. Lines that follow it without a
 * key of their own (a multi-line description) belong to the same attribute.
 */
function lineKey(line: string): string | null {
  const m = /^ {2}([a-z][a-z0-9_]*):\s/.exec(line);
  return m ? m[1] : null;
}

/** A redacted feed address keeps its scheme and host: "webcal://host/... (feed address hidden)". */
function isRedactedFeed(line: string, url: string): boolean {
  if (!/^webcals?:\/\/[^/\s]+\/\.\.\.$/i.test(url)) return false;
  const after = line.slice(line.indexOf(url) + url.length);
  return /^\s*\(feed address hidden\)/.test(after);
}

export function scanForLeaks(text: string): LeakFinding[] {
  const counts = new Map<string, LeakFinding>();
  let currentKey = "(other)";
  const bump = (kind: LeakKind) => {
    const id = `${kind}|${currentKey}`;
    const found = counts.get(id) ?? { kind, key: currentKey, count: 0 };
    found.count += 1;
    counts.set(id, found);
  };

  for (const line of text.split("\n")) {
    const key = lineKey(line);
    if (key) currentKey = key;
    else if (/^- .*\(ID: /.test(line)) currentKey = "(other)"; // a new item header: "- Event (ID: 1)"
    if (FREE_TEXT_KEYS.has(currentKey)) continue;

    if (/\bAuthorization:\s*Bearer\b/i.test(line) || /\bBearer\s+[A-Za-z0-9._-]{20,}/.test(line)) bump("bearer-header");
    if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(line)) bump("jwt-like");

    const urls = line.match(URL_RE) ?? [];
    for (const url of urls) {
      if (/^webcals?:/i.test(url)) {
        if (!isRedactedFeed(line, url)) bump("feed-scheme");
        continue;
      }
      if (isStockAsset(url)) continue;
      let parsed: URL | null = null;
      try {
        parsed = new URL(url);
      } catch {
        parsed = null;
      }
      if (parsed?.search) bump("url-with-query");
      else if (parsed && parsed.pathname.split("/").some((seg) => seg.length >= 20 && TOKEN_CHARS.test(seg) && hasLetterAndDigit(seg))) {
        bump("url-token-path");
      }
    }

    // A standalone long mixed token outside any URL. Ids are short numerics, so 40+ is conservative.
    const withoutUrls = line.replace(URL_RE, " ");
    for (const word of withoutUrls.split(/[\s,;"'()[\]{}<>]+/)) {
      if (word.length >= 40 && TOKEN_CHARS.test(word) && hasLetterAndDigit(word)) bump("bare-token");
    }
  }

  return [...counts.values()];
}
