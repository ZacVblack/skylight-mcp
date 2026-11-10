import { afterEach, describe, expect, it, vi } from "vitest";
import { SkylightClient } from "../src/api/client.js";
import { SKYLIGHT_BASE_URL } from "../src/api/constants.js";
import type { CredentialStore } from "../src/api/credential-store.js";
import type { StoredCredential } from "../src/api/oauth.js";
import type { Config } from "../src/config.js";

const config: Config = { frameId: "frame-1", authType: "bearer", timezone: "UTC" };

function memoryStore(initial: StoredCredential | null): CredentialStore & { current: StoredCredential | null } {
  const store = {
    name: "memory",
    current: initial,
    read: async () => store.current,
    write: async (c: StoredCredential) => void (store.current = c),
    delete: async () => {
      const had = store.current !== null;
      store.current = null;
      return had;
    },
  };
  return store;
}

const fresh = (over: Partial<StoredCredential> = {}): StoredCredential => ({
  version: 1,
  type: "oauth",
  accessToken: "test-access-1",
  refreshToken: "test-refresh-1",
  fingerprint: "fp",
  expiresAt: Date.now() + 3_600_000,
  ...over,
});

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    })
  );
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("SkylightClient credential handling", () => {
  it("uses the stored credential as a bearer token", async () => {
    const calls = mockFetch((url) => (url.includes("/plus_access") ? json({}) : json({ data: [] })));
    const client = new SkylightClient(config, memoryStore(fresh()));
    await client.get("/api/frames/{frameId}/chores");
    const api = calls.find((c) => c.url.includes("/chores"))!;
    expect((api.init.headers as Record<string, string>).Authorization).toBe("Bearer test-access-1");
  });

  it("refreshes an expired credential once under concurrency and persists the rotation", async () => {
    const store = memoryStore(fresh({ expiresAt: Date.now() - 1000 }));
    const calls = mockFetch((url) => {
      if (url.endsWith("/oauth/token")) return json({ access_token: "test-access-2", refresh_token: "test-refresh-2", expires_in: 3600 });
      if (url.includes("/plus_access")) return json({});
      return json({ data: [] });
    });
    const client = new SkylightClient(config, store);
    await Promise.all([client.get("/api/frames/{frameId}/chores"), client.get("/api/frames/{frameId}/lists")]);
    expect(calls.filter((c) => c.url.endsWith("/oauth/token"))).toHaveLength(1);
    expect(store.current?.refreshToken).toBe("test-refresh-2");
  });

  it("refreshes and retries once on 401, then stops", async () => {
    const store = memoryStore(fresh());
    let apiCalls = 0;
    const calls = mockFetch((url) => {
      if (url.endsWith("/oauth/token")) return json({ access_token: "test-access-2", refresh_token: "test-refresh-2" });
      if (url.includes("/plus_access")) return json({});
      apiCalls++;
      return new Response("", { status: 401 });
    });
    const client = new SkylightClient(config, store);
    await expect(client.get("/api/frames/{frameId}/chores")).rejects.toThrow(/401/);
    expect(apiCalls).toBe(2);
    expect(calls.filter((c) => c.url.endsWith("/oauth/token"))).toHaveLength(1);
  });

  it("fails closed when a refreshed credential cannot be saved: named error, no store text, nothing kept in memory", async () => {
    const store = memoryStore(fresh({ expiresAt: Date.now() - 1000 }));
    let failWrites = true;
    store.write = async (c: StoredCredential) => {
      if (failWrites) throw new Error(`disk full while writing ${JSON.stringify(c)}`);
      store.current = c;
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = mockFetch((url) => {
      if (url.endsWith("/oauth/token")) return json({ access_token: "test-access-2", refresh_token: "test-refresh-2", expires_in: 3600 });
      if (url.includes("/plus_access")) return json({});
      return json({ data: [] });
    });
    const client = new SkylightClient(config, store);
    const err = await client.get("/api/frames/{frameId}/chores").catch((e: unknown) => e as Error & { code?: string });
    expect(err).toMatchObject({ name: "CredentialSaveError", code: "CREDENTIAL_SAVE_FAILED" });
    expect(err).toBeInstanceOf(Error);
    const printed = logged.mock.calls.map((c) => String(c[0])).join("\n");
    for (const text of [err.message, printed]) {
      expect(text).not.toContain("disk full");
      expect(text).not.toContain("test-access-2");
      expect(text).not.toContain("test-refresh-2");
    }
    // No API request was sent with the unsaved token.
    expect(calls.filter((c) => !c.url.endsWith("/oauth/token") && !c.url.includes("/plus_access"))).toHaveLength(0);
    // The client did not keep the unsaved credential: the next call goes back to the store
    // (still holding the old, spent one) and refreshes from that, instead of quietly using memory.
    failWrites = false;
    await client.get("/api/frames/{frameId}/chores");
    const refreshes = calls.filter((c) => c.url.endsWith("/oauth/token"));
    expect(refreshes).toHaveLength(2);
    expect(new URLSearchParams(String(refreshes[1]!.init.body)).get("refresh_token")).toBe("test-refresh-1");
    logged.mockRestore();
  });

  it("explains how to sign in when nothing is configured", async () => {
    mockFetch(() => json({}));
    const client = new SkylightClient(config, memoryStore(null));
    await expect(client.get("/api/frames/{frameId}/chores")).rejects.toThrow(/auth login/);
  });

  it("fails closed with a clear error if the store cannot be read", async () => {
    const { CredentialStoreError } = await import("../src/api/credential-store.js");
    const broken: CredentialStore = {
      name: "broken",
      read: async () => {
        throw new CredentialStoreError("keychain locked");
      },
      write: async () => {},
      delete: async () => false,
    };
    const calls = mockFetch(() => json({}));
    await expect(new SkylightClient(config, broken).get("/api/frames/{frameId}/chores")).rejects.toThrow(/keychain locked/);
    expect(calls).toHaveLength(0);
  });

  it("prefers an explicit env token and does not touch the store", async () => {
    const store = memoryStore(fresh());
    store.read = async () => {
      throw new Error("store should not be read");
    };
    const calls = mockFetch(() => json({ data: [] }));
    const client = new SkylightClient({ ...config, token: "test-explicit-token" }, store);
    await client.get("/api/frames/{frameId}/chores");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer test-explicit-token");
  });
});

describe("API host pinning", () => {
  it("ignores environment overrides for the API base", async () => {
    vi.stubEnv("SKYLIGHT_API_BASE", "https://evil.example");
    vi.stubEnv("SKYLIGHT_BASE_URL", "https://evil.example");
    vi.resetModules();
    const constants = await import("../src/api/constants.js");
    expect(constants.SKYLIGHT_BASE_URL).toBe("https://app.ourskylight.com");
  });

  it("refuses absolute endpoint URLs and makes no network call", async () => {
    const calls = mockFetch(() => json({ data: [] }));
    const client = new SkylightClient(config, memoryStore(fresh()));
    await expect(client.get("https://evil.example/steal")).rejects.toThrow(/outside the Skylight API host/);
    await expect(client.get("//evil.example/steal")).rejects.toThrow(/outside the Skylight API host/);
    expect(calls.filter((c) => c.url.includes("evil.example"))).toHaveLength(0);
    expect(SKYLIGHT_BASE_URL).toBe("https://app.ourskylight.com");
  });
});
