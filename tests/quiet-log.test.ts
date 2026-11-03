import { afterEach, describe, expect, it, vi } from "vitest";
import { SkylightClient, setQuietRequestLog } from "../src/api/client.js";
import type { Config } from "../src/config.js";

const config: Config = { frameId: "frame-1", authType: "bearer", timezone: "UTC" };
const store = {
  name: "memory",
  read: async () => ({ version: 1, type: "oauth", accessToken: "t", refreshToken: "r", fingerprint: "f", expiresAt: Date.now() + 3_600_000 }),
  write: async () => {},
  delete: async () => true,
} as never;

afterEach(() => {
  setQuietRequestLog(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function traceLines(quiet: boolean): Promise<string[]> {
  setQuietRequestLog(quiet);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  await new SkylightClient(config, store).request("/api/frames");
  return spy.mock.calls.map((c) => String(c[0]));
}

describe("request trace logging", () => {
  it("is on by default, so a running MCP server keeps its stderr trace", async () => {
    expect((await traceLines(false)).some((l) => l.startsWith("[client] GET"))).toBe(true);
  });

  it("can be silenced for interactive commands, and nothing else changes", async () => {
    expect(await traceLines(true)).toEqual([]);
  });
});
