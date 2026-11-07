/**
 * Chooses the change counter for one hosted MCP request.
 *
 * With the WRITE_LIMITER Durable Object binding the count persists across
 * requests. Without it (a wrangler config from before the limiter) the Worker
 * falls back to the in-memory guard, which does not limit across requests; the
 * log line says `limiter: "memory"` so that state is visible, not silent.
 *
 * If the binding exists but cannot be reached, the change is refused. A safety
 * control that is down must not turn into permission.
 */

import { getDefaultWriteGuard, type Admission, type WriteGuardLike } from "../utils/write-guard.js";

type LimitedEffect = "write" | "destructive";

/** The slice of a DurableObjectNamespace this file uses, so tests can fake it. */
export interface LimiterNamespace {
  idFromName(name: string): unknown;
  get(id: never): { admit(effect: LimitedEffect): Promise<Admission> };
}

export const LIMITER_UNAVAILABLE_RETRY_SECONDS = 60;

export function guardForRequest(namespace: LimiterNamespace | undefined, frameId: string): WriteGuardLike {
  if (!namespace) return getDefaultWriteGuard();
  return {
    kind: "durable",
    async admit(effect): Promise<Admission> {
      try {
        const stub = namespace.get(namespace.idFromName(`frame:${frameId}`) as never);
        return await stub.admit(effect);
      } catch {
        return {
          ok: false,
          reason: "the change limiter could not be reached",
          retryAfterSeconds: LIMITER_UNAVAILABLE_RETRY_SECONDS,
          recent: 0,
          limiterError: true,
        };
      }
    },
  };
}
