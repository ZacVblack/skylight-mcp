import { afterEach, describe, expect, it, vi } from "vitest";
import { WriteLimiter } from "../src/worker/write-limiter.js";
import { DEFAULT_WRITE_LIMITS } from "../src/utils/write-guard.js";

// A stand-in for Durable Object storage and its concurrency gate. Storage yields to
// other work on every call (as real storage does), so a read-decide-write that is
// not serialised would interleave and miscount. blockConcurrencyWhile runs its
// callbacks one at a time, which is what the real one guarantees.
const tick = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

class FakeStorage {
  readonly map = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    await tick();
    return structuredClone(this.map.get(key));
  }
  async put(key: string, value: unknown): Promise<void> {
    await tick();
    this.map.set(key, structuredClone(value));
  }
}

function fakeCtx(storage: FakeStorage) {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    storage,
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      const run = chain.then(fn);
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

/** A new object over the same storage: what a restart or eviction looks like. */
const objectOver = (storage: FakeStorage) => new WriteLimiter(fakeCtx(storage) as never, {} as never);

afterEach(() => vi.useRealTimers());

describe("WriteLimiter (Durable Object counter)", () => {
  it("admits the configured number of changes, then refuses without counting the refusal", async () => {
    const limiter = objectOver(new FakeStorage());
    for (let i = 0; i < DEFAULT_WRITE_LIMITS.maxWrites; i++) expect((await limiter.admit("write")).ok).toBe(true);
    const over = await limiter.admit("write");
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toMatch(/change limit/);
    expect((await limiter.admit("write")).recent).toBe(DEFAULT_WRITE_LIMITS.maxWrites);
  });

  it("reports a rising count, so the log can show the limit working", async () => {
    const limiter = objectOver(new FakeStorage());
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) seen.push((await limiter.admit("write")).recent);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("keeps the count when the object is recreated over the same storage", async () => {
    const storage = new FakeStorage();
    const first = objectOver(storage);
    for (let i = 0; i < DEFAULT_WRITE_LIMITS.maxWrites; i++) await first.admit("write");
    const second = objectOver(storage);
    expect((await second.admit("write")).ok).toBe(false);
  });

  it("is exact under concurrent calls", async () => {
    const limiter = objectOver(new FakeStorage());
    const verdicts = await Promise.all(Array.from({ length: 100 }, () => limiter.admit("write")));
    expect(verdicts.filter((v) => v.ok).length).toBe(DEFAULT_WRITE_LIMITS.maxWrites);
    expect(verdicts.filter((v) => !v.ok).length).toBe(100 - DEFAULT_WRITE_LIMITS.maxWrites);
  });

  it("caps deletes below the general limit and counts them in it", async () => {
    const limiter = objectOver(new FakeStorage());
    for (let i = 0; i < DEFAULT_WRITE_LIMITS.maxDestructive; i++) expect((await limiter.admit("destructive")).ok).toBe(true);
    const eleventh = await limiter.admit("destructive");
    expect(eleventh.ok).toBe(false);
    if (!eleventh.ok) expect(eleventh.reason).toMatch(/delete limit/);
    // Ten deletes used ten of the sixty changes.
    for (let i = 0; i < DEFAULT_WRITE_LIMITS.maxWrites - DEFAULT_WRITE_LIMITS.maxDestructive; i++) expect((await limiter.admit("write")).ok).toBe(true);
    expect((await limiter.admit("write")).ok).toBe(false);
  });

  it("forgets changes after the window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
    const limiter = objectOver(new FakeStorage());
    for (let i = 0; i < DEFAULT_WRITE_LIMITS.maxWrites; i++) await limiter.admit("write");
    expect((await limiter.admit("write")).ok).toBe(false);
    vi.setSystemTime(new Date("2026-11-06T13:01:00Z"));
    expect((await limiter.admit("write")).ok).toBe(true);
  });

  it("does not trust malformed stored state", async () => {
    const storage = new FakeStorage();
    storage.map.set("state", { writes: "not a list", destructive: [1, "x", null, Number.NaN] });
    const limiter = objectOver(storage);
    expect((await limiter.admit("write")).ok).toBe(true);
  });

  it("refuses a class it does not know instead of letting it through", async () => {
    const limiter = objectOver(new FakeStorage());
    const verdict = await limiter.admit("read" as never);
    expect(verdict.ok).toBe(false);
  });
});
