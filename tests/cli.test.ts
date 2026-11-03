import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAuthCommand } from "../src/cli.js";
import { createFileCredentialStore, savePendingLogin, takePendingLogin } from "../src/api/credential-store.js";
import { completeBrowserLogin } from "../src/api/oauth.js";

describe("cli smoke", () => {
  it("login -> complete -> status -> logout", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cli-"));
    const out: string[] = [];
    const store = createFileCredentialStore({ directory: dir });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ access_token: "test-a", refresh_token: "test-r", expires_in: 60 }), { status: 200 })) as unknown as typeof fetch;
    const deps = {
      store, out: (l: string) => out.push(l),
      savePending: (p: any) => savePendingLogin(p, dir), takePending: () => takePendingLogin(dir),
      complete: (u: string, p: any) => completeBrowserLogin(u, p, fetchImpl),
    };
    expect(await runAuthCommand(["status"], deps)).toBe(1);
    expect(await runAuthCommand(["login"], deps)).toBe(0);
    const url = out.find((l) => l.includes("oauth/authorize"))!.trim();
    const state = new URL(url).searchParams.get("state");
    expect(await runAuthCommand(["complete", `https://ourskylight.com/welcome?code=c&state=${state}`], deps)).toBe(0);
    expect(await runAuthCommand(["complete", `https://ourskylight.com/welcome?code=c&state=${state}`], deps)).toBe(1); // single use
    expect(await runAuthCommand(["status"], deps)).toBe(0);
    expect(await runAuthCommand(["logout"], deps)).toBe(0);
    expect(await runAuthCommand(["status"], deps)).toBe(1);
    expect(await runAuthCommand(["bogus"], deps)).toBe(1);
  });

  it("as a step inside init (showNextStep false) it does not say to restart the client yet", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cli-"));
    const out: string[] = [];
    const store = createFileCredentialStore({ directory: dir });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ access_token: "test-a", refresh_token: "test-r", expires_in: 60 }), { status: 200 })) as unknown as typeof fetch;
    const deps = {
      store, out: (l: string) => out.push(l), showNextStep: false,
      savePending: (p: any) => savePendingLogin(p, dir), takePending: () => takePendingLogin(dir),
      complete: (u: string, p: any) => completeBrowserLogin(u, p, fetchImpl),
    };
    await runAuthCommand(["login"], deps);
    const state = new URL(out.find((l) => l.includes("oauth/authorize"))!.trim()).searchParams.get("state");
    expect(await runAuthCommand(["complete", `https://ourskylight.com/welcome?code=c&state=${state}`], deps)).toBe(0);
    expect(out.join("\n")).toContain("Signed in.");
    expect(out.join("\n")).not.toContain("Restart your MCP client");
  });

  it("offers to open the sign-in URL when asked, and says so if no browser can be opened", async () => {
    for (const opened of [true, false]) {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-"));
      const out: string[] = [];
      const asked: string[] = [];
      const seen: string[] = [];
      const deps = {
        store: createFileCredentialStore({ directory: dir }),
        out: (l: string) => out.push(l),
        prompt: async (q: string) => (asked.push(q), ""),
        showNextStep: false,
        openUrl: async (u: string) => (seen.push(u), opened),
        savePending: (p: any) => savePendingLogin(p, dir),
        takePending: () => takePendingLogin(dir),
      };
      expect(await runAuthCommand(["login"], deps)).toBe(0);
      expect(asked[0]).toContain("Press Enter");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("oauth/authorize");
      expect(out.join("\n")).toContain(opened ? "Opened your browser." : "Could not open a browser");
    }
  });

  it("plain `auth login` does not prompt or open anything", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cli-"));
    const asked: string[] = [];
    const deps = {
      store: createFileCredentialStore({ directory: dir }),
      out: () => {},
      prompt: async (q: string) => (asked.push(q), ""),
      savePending: (p: any) => savePendingLogin(p, dir),
      takePending: () => takePendingLogin(dir),
    };
    expect(await runAuthCommand(["login"], deps)).toBe(0);
    expect(asked).toEqual([]);
  });
});
