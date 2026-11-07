/**
 * A backstop on how many changes one server process will make in an hour, and a
 * one-line record of each change attempt.
 *
 * Why it exists: an assistant that loops (or is steered into a loop) could
 * otherwise create or delete hundreds of items on the family's shared display
 * before anyone looks. The per-tool guards (preview, confirm, allowlist) judge one
 * call at a time; this judges the rate.
 *
 * Limits of this design, stated plainly:
 * - The count lives in memory, per process. On the hosted Worker that means per
 *   isolate, and a new isolate starts at zero. It stops a tight loop, which lands
 *   on one isolate; it is not an exact quota and not an authentication control.
 * - Every non-read call counts, previews and failures included, so a loop of
 *   failing or dry-run calls is stopped too. The default is generous for a family
 *   (a planning session is a handful of calls).
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

export type Admission = { ok: true } | { ok: false; reason: string; retryAfterSeconds: number };

export class WriteGuard {
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
      return { ok: false, reason: `delete limit reached (${this.limits.maxDestructive} per hour)`, retryAfterSeconds: this.retryAfter(this.destructive) };
    }
    if (this.writes.length >= this.limits.maxWrites) {
      return { ok: false, reason: `change limit reached (${this.limits.maxWrites} per hour)`, retryAfterSeconds: this.retryAfter(this.writes) };
    }
    const t = this.now();
    this.writes.push(t);
    if (effect === "destructive") this.destructive.push(t);
    return { ok: true };
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

export type WriteOutcome = "ok" | "tool_error" | "threw" | "refused";

/** One line per change attempt, to stderr (stdout carries the MCP protocol on stdio). No arguments, text or ids. */
export function logWrite(tool: string, effect: ToolEffect, outcome: WriteOutcome, recent: number): void {
  console.error(JSON.stringify({ event: "skylight_change", tool, effect, outcome, recent }));
}

export function refusalResult(reason: string, retryAfterSeconds: number): { isError: true; content: Array<{ type: "text"; text: string }> } {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Nothing was changed: ${reason}. This stops a runaway loop on the family's shared display. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}, and tell the owner if you were not expecting to hit it.`,
      },
    ],
  };
}
