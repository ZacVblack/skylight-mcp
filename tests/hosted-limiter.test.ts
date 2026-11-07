import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../src/worker/mcp.js";
import { guardForRequest, type LimiterNamespace } from "../src/worker/limiter.js";
import type { SkylightProps } from "../src/worker/props.js";
import { WriteGuard, getDefaultWriteGuard, type Admission } from "../src/utils/write-guard.js";

const props: SkylightProps = {
  accessToken: "test-access-1",
  refreshToken: "test-refresh-1",
  fingerprint: "fp",
  expiresAt: Date.now() + 3_600_000,
  frameId: "frame-1",
  timezone: "America/Los_Angeles",
  hasPlus: true,
};

function rpc(name: string, args: Record<string, unknown>): Request {
  return new Request("https://worker.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
}

async function call(env: { WRITE_LIMITER?: LimiterNamespace }, frameId = "frame-1"): Promise<{ isError: boolean; text: string }> {
  const res = await handleMcpRequest(rpc("create_list", { label: "List", kind: "to_do" }), { ...props, frameId }, "test", env);
  const json = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  return { isError: json.result.isError === true, text: json.result.content.map((c) => c.text).join("\n") };
}

/** A fake namespace: one small WriteGuard per name, kept across requests like a Durable Object. */
function fakeNamespace(limits = { windowMs: 60_000, maxWrites: 2, maxDestructive: 1 }) {
  const guards = new Map<string, WriteGuard>();
  const names: string[] = [];
  const admits: string[] = [];
  const namespace: LimiterNamespace = {
    idFromName: (name: string) => {
      names.push(name);
      return name;
    },
    get: ((id: string) => {
      if (!guards.has(id)) guards.set(id, new WriteGuard(limits));
      return { admit: async (effect: "write" | "destructive"): Promise<Admission> => (admits.push(effect), guards.get(id)!.admit(effect)) };
    }) as never,
  };
  return { namespace, names, admits };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const stubFetch = () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { id: "9", type: "list", attributes: { label: "x" } } }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("hosted change limit", () => {
  it("counts in the Durable Object across separate requests, not in process memory", async () => {
    const fetchMock = stubFetch();
    const { namespace, admits } = fakeNamespace();
    expect((await call({ WRITE_LIMITER: namespace })).isError).toBe(false);
    expect((await call({ WRITE_LIMITER: namespace })).isError).toBe(false);
    const before = fetchMock.mock.calls.length;
    const third = await call({ WRITE_LIMITER: namespace });
    expect(third.isError).toBe(true);
    expect(third.text).toMatch(/Nothing was changed/);
    expect(fetchMock.mock.calls.length).toBe(before);
    expect(admits).toEqual(["write", "write", "write"]);
    // The in-memory guard was never the one deciding.
    expect(getDefaultWriteGuard().recent()).toBe(0);
  });

  it("keeps each frame's allowance separate", async () => {
    stubFetch();
    const { namespace, names } = fakeNamespace();
    await call({ WRITE_LIMITER: namespace }, "frame-a");
    await call({ WRITE_LIMITER: namespace }, "frame-a");
    expect((await call({ WRITE_LIMITER: namespace }, "frame-a")).isError).toBe(true);
    expect((await call({ WRITE_LIMITER: namespace }, "frame-b")).isError).toBe(false);
    expect(new Set(names)).toEqual(new Set(["frame:frame-a", "frame:frame-b"]));
  });

  it("refuses the change, and does not call Skylight, when the limiter cannot be reached", async () => {
    const fetchMock = stubFetch();
    const broken: LimiterNamespace = {
      idFromName: () => "x",
      get: (() => ({ admit: async () => Promise.reject(new Error("boom")) })) as never,
    };
    const out = await call({ WRITE_LIMITER: broken });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/limiter could not be reached/);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("never asks the limiter about reads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const { namespace, admits } = fakeNamespace();
    const res = await handleMcpRequest(rpc("get_lists", {}), props, "test", { WRITE_LIMITER: namespace });
    expect(res.status).toBe(200);
    expect(admits).toEqual([]);
  });

  it("falls back to the in-memory guard when there is no binding, and says so", () => {
    const guard = guardForRequest(undefined, "frame-1");
    expect(guard.kind).toBe("memory");
    expect(guardForRequest(fakeNamespace().namespace, "frame-1").kind).toBe("durable");
  });
});

describe("change log line", () => {
  const lines = async (run: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> => {
    const out: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    await run();
    return out.filter((l) => l.includes("skylight_change")).map((l) => JSON.parse(l.slice(l.indexOf("{"))));
  };

  it("holds only these fields, and says where the count lives", async () => {
    stubFetch();
    const { namespace } = fakeNamespace();
    const [durable] = await lines(() => call({ WRITE_LIMITER: namespace }));
    expect(Object.keys(durable!).sort()).toEqual(["effect", "event", "limiter", "outcome", "recent", "tool"]);
    expect(durable).toMatchObject({ tool: "create_list", effect: "write", outcome: "ok", recent: 1, limiter: "durable" });
    const [memory] = await lines(() => call({}));
    expect(memory).toMatchObject({ limiter: "memory" });
  });

  it("records an unreachable limiter as its own outcome", async () => {
    stubFetch();
    const broken: LimiterNamespace = { idFromName: () => "x", get: (() => ({ admit: async () => Promise.reject(new Error("boom")) })) as never };
    const [line] = await lines(() => call({ WRITE_LIMITER: broken }));
    expect(line).toMatchObject({ outcome: "limiter_error", limiter: "durable" });
  });
});
