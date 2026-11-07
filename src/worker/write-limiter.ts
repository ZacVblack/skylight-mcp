/**
 * The hosted Worker's change counter, kept in a Durable Object so it survives
 * between requests. The first version counted in module memory; a live test showed
 * the Worker did not keep that state from one request to the next, so the limit
 * never applied. See utils/write-guard.ts for the admission rule itself, which
 * is shared with the local server.
 *
 * One object per Skylight frame (see limiter.ts), so one household's loop cannot
 * use up another's allowance on a shared Worker. Each admit() is one
 * read-decide-write inside blockConcurrencyWhile, so two calls arriving together
 * cannot both read the same count.
 */

import { DurableObject } from "cloudflare:workers";
import { DEFAULT_WRITE_LIMITS, WriteGuard, type Admission } from "../utils/write-guard.js";

const STATE_KEY = "state";

export class WriteLimiter extends DurableObject {
  async admit(effect: "write" | "destructive"): Promise<Admission> {
    // Only these two classes are ever counted; anything else is a caller bug, not a free pass.
    if (effect !== "write" && effect !== "destructive") {
      return { ok: false, reason: "unknown change class", retryAfterSeconds: 60, recent: 0 };
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      const guard = new WriteGuard(DEFAULT_WRITE_LIMITS);
      guard.restore(await this.ctx.storage.get(STATE_KEY));
      const verdict = guard.admit(effect);
      // A refusal records nothing, so only an admitted call needs saving.
      if (verdict.ok) await this.ctx.storage.put(STATE_KEY, guard.snapshot());
      return verdict;
    });
  }
}
