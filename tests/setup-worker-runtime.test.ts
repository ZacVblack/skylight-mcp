/**
 * The library's setup entry and read entry, run inside the Workers runtime (workerd via Miniflare)
 * with `nodejs_compat`, the way an importing Worker would run them. Node-based tests cannot show
 * that the sign-in's crypto, token exchange and client work there. Outbound requests never leave
 * the test: Miniflare hands them to `outboundService`, which records them and plays Skylight.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
type Call = { url: string; method: string; auth: string | null; body: string };
const calls: Call[] = [];
let mf: Miniflare;
let result: Record<string, unknown>;

beforeAll(async () => {
  execFileSync("npx", ["tsc"], { cwd: repo, stdio: "pipe" });
  const bundle = await build({
    entryPoints: [path.join(repo, "tests/worker-runtime/setup-worker.mjs")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "import"],
    external: ["node:*"],
    write: false,
    logLevel: "silent",
  });
  // This Miniflare takes a new options shape; its own converter keeps the familiar one readable here.
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    outboundService: async (request: Request) => {
      const url = new URL(request.url);
      calls.push({ url: request.url, method: request.method, auth: request.headers.get("authorization"), body: request.method === "GET" ? "" : await request.text() });
      if (url.pathname === "/oauth/token") return Response.json({ access_token: "AT-worker-1", refresh_token: "RT-worker-1", expires_in: 3600 });
      if (url.pathname.endsWith("/source_calendars")) {
        return Response.json({ data: [{ id: "2", type: "source_calendar", attributes: { label: "League", kind: "webcal", role: "reader", editable: false, source_id: "webcal://u:p@feeds.example.com/x/SECRETFEED?token=abc" } }] });
      }
      return Response.json({ data: [] });
    },
  }));
  const response = await mf.dispatchFetch("http://worker.test/");
  result = (await response.json()) as Record<string, unknown>;
}, 240_000);

afterAll(async () => {
  await mf?.dispose();
});

describe("setup entry inside the Workers runtime (workerd, nodejs_compat)", () => {
  it("signs in with PKCE S256 and stores the credential, returning no secret", () => {
    expect(result.loginHost).toBe("app.ourskylight.com");
    expect(result.method).toBe("S256");
    expect(result.challengeOk).toBe(true);
    expect(result.verifierLength as number).toBeGreaterThanOrEqual(43);
    expect(result.stateLength).toBe(32);
    expect(result.statesDiffer).toBe(true);
    expect(result.done).toMatchObject({ signedIn: true });
    expect(result.status).toMatchObject({ signedIn: true, expired: false });
    expect(result.writes).toBe(1);
    expect(result.storedOk).toBe(true);
    for (const secret of ["AT-worker-1", "RT-worker-1", "CODE-W", result.verifier as string]) expect(result.returned as string).not.toContain(secret);
  });

  it("refuses a hostile address, a replay and a wrong state there too", () => {
    expect(result.hostile).toBe("bad_redirect_url");
    expect(result.replay).toBe("no_pending_login");
    expect(result.wrongState).toBe("state_mismatch");
  });

  it("sends the code and verifier only to the pinned host, once", () => {
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(new URL(c.url).origin).toBe("https://app.ourskylight.com");
    const token = calls.filter((c) => new URL(c.url).pathname === "/oauth/token");
    expect(token.length).toBe(1);
    expect(token[0]!.method).toBe("POST");
    const sent = new URLSearchParams(token[0]!.body);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe("CODE-W");
    expect(sent.get("code_verifier")).toBe(result.verifier);
  });

  it("the stored credential then reads through createSkylight, with the feed address reduced to its host", () => {
    for (const c of calls.filter((c) => new URL(c.url).pathname !== "/oauth/token")) expect(c.auth).toBe("Bearer AT-worker-1");
    expect(result.sources).toEqual([{ id: "2", label: "League", kind: "feed", role: "reader", editable: false, host: "webcal://feeds.example.com" }]);
    expect(JSON.stringify(result.sources)).not.toContain("SECRETFEED");
  });
});
