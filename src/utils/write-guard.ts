/**
 * A backstop on how many changes one server process will make in an hour, and a
 * one-line record of each change attempt.
 *
 * Why it exists: an assistant that loops (or is steered into a loop) could
 * otherwise create or delete hundreds of items on the family's shared display
 * before anyone looks. The per-tool guards (preview, confirm, allowlist) judge one
 * call at a time; this judges the rate.
 *
 * Where the count lives:
 * - Local stdio server: in memory. It is one long-lived process, so that holds.
 * - Hosted Worker: in a Durable Object (src/worker/write-limiter.ts). The first
 *   hosted version kept the count in module memory and a live test showed the
 *   Worker did not carry it from one request to the next (three calls in a row
 *   each read 1), so it limited nothing. This file holds the one admission rule
 *   both places use.
 * - If the Worker has no Durable Object binding (a config from before the
 *   limiter), it falls back to the in-memory guard, which does NOT limit across
 *   requests, and every log line says so (`limiter: "memory"`).
 * - Every non-read call counts, previews and failures included, so a loop of
 *   failing or dry-run calls is stopped too. The default is generous for a family
 *   (a planning session is a handful of calls). This is a backstop against a
 *   runaway loop, not an exact quota and not an authentication control.
 * - The log line holds the tool name, its effect and the outcome only. Never
 *   arguments, text, ids or results: the log must be safe to paste.
 */

import type { ToolEffect } from "../tools/registry.js";

export interface WriteLimits {
  windowMs: number;
  /** Non-read calls (write and destructive together) per window. */
  maxWrites: number;
  /** Destructive calls per window, counted inside maxWrites. */
  maxDestructive: number;
}

export const DEFAULT_WRITE_LIMITS: WriteLimits = {
  windowMs: 60 * 60 * 1000,
  maxWrites: 60,
  maxDestructive: 10,
};

/** `recent` is the number of changes admitted in the window, this one included when allowed. */
export type Admission = { ok: true; recent: number } | { ok: false; reason: string; retryAfterSeconds: number; recent: number; limiterError?: true };

/** What the registry needs from a guard; the in-memory and the Durable Object versions both fit. */
export interface WriteGuardLike {
  /** "memory" counts in this process only; "durable" counts across requests. Shown in every log line. */
  readonly kind: "memory" | "durable";
  admit(effect: Exclude<ToolEffect, "read">): Admission | Promise<Admission>;
}

/** What a Durable Object persists between requests. */
export interface WriteGuardState {
  writes: number[];
  destructive: number[];
}

export class WriteGuard implements WriteGuardLike {
  readonly kind = "memory" as const;
  private writes: number[] = [];
  private destructive: number[] = [];

  constructor(
    private readonly limits: WriteLimits = DEFAULT_WRITE_LIMITS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private prune(): void {
    const cutoff = this.now() - this.limits.windowMs;
    this.writes = this.writes.filter((t) => t > cutoff);
    this.destructive = this.destructive.filter((t) => t > cutoff);
  }

  private retryAfter(times: number[]): number {
    const oldest = times[0] ?? this.now();
    return Math.max(1, Math.ceil((oldest + this.limits.windowMs - this.now()) / 1000));
  }

  /** Decide, and when allowed record the attempt. Reads must not be passed in. */
  admit(effect: Exclude<ToolEffect, "read">): Admission {
    this.prune();
    if (effect === "destructive" && this.destructive.length >= this.limits.maxDestructive) {
      return { ok: false, reason: `delete limit reached (${this.limits.maxDestructive} per hour)`, retryAfterSeconds: this.retryAfter(this.destructive), recent: this.writes.length };
    }
    if (this.writes.length >= this.limits.maxWrites) {
      return { ok: false, reason: `change limit reached (${this.limits.maxWrites} per hour)`, retryAfterSeconds: this.retryAfter(this.writes), recent: this.writes.length };
    }
    const t = this.now();
    this.writes.push(t);
    if (effect === "destructive") this.destructive.push(t);
    return { ok: true, recent: this.writes.length };
  }

  /** The counts, for a store that outlives the process. */
  snapshot(): WriteGuardState {
    return { writes: [...this.writes], destructive: [...this.destructive] };
  }

  /** Load counts saved by snapshot(). Anything malformed is ignored (counts start empty), never trusted. */
  restore(state: unknown): void {
    const clean = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => typeof n === "number" && Number.isFinite(n)) : []);
    const s = (state ?? {}) as Partial<WriteGuardState>;
    this.writes = clean(s.writes);
    this.destructive = clean(s.destructive);
  }

  /** Changes admitted in the current window. */
  recent(): number {
    this.prune();
    return this.writes.length;
  }
}

let defaultGuard = new WriteGuard();

/** The process-wide guard. The hosted server builds a fresh MCP server per request, so this must outlive one. */
export function getDefaultWriteGuard(): WriteGuard {
  return defaultGuard;
}

/** Tests only. */
export function resetDefaultWriteGuard(): void {
  defaultGuard = new WriteGuard();
}

export type WriteOutcome = "ok" | "tool_error" | "threw" | "refused" | "limiter_error";

/**
 * One line per change attempt, to stderr (stdout carries the MCP protocol on stdio).
 * No arguments, text or ids. `limiter` says where the count lives, so a Worker that
 * is silently counting in memory (and so limiting nothing) is visible in the log.
 */
export function logWrite(tool: string, effect: ToolEffect, outcome: WriteOutcome, recent: number, limiter: WriteGuardLike["kind"]): void {
  console.error(JSON.stringify({ event: "skylight_change", tool, effect, outcome, recent, limiter }));
}

export function refusalResult(reason: string, retryAfterSeconds: number, limiterError = false): { isError: true; content: Array<{ type: "text"; text: string }> } {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  const wait = `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const text = limiterError
    ? `Nothing was changed: ${reason}, so this change was not allowed. Try again in ${wait}, and tell the owner if it keeps happening.`
    : `Nothing was changed: ${reason}. This stops a runaway loop on the family's shared display. Try again in ${wait}, and tell the owner if you were not expecting to hit it.`;
  return { isError: true, content: [{ type: "text", text }] };
}
