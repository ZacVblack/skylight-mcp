import { describe, expect, it } from "vitest";
import { CLIENT_SNIPPET, runInit, type InitDeps } from "../src/init.js";
import type { ConfigFile } from "../src/config-file.js";

const FRAME_ID = "40414243";
const TOKEN = "tok_secret_value";

function harness(over: Partial<InitDeps> & { answers?: string[]; signedIn?: boolean; frames?: Array<{ id: string; name: string }> | Error; existing?: ConfigFile | null } = {}) {
  const out: string[] = [];
  const asked: string[] = [];
  const answers = [...(over.answers ?? [])];
  const authCalls: string[][] = [];
  const writes: ConfigFile[] = [];
  let doctorRuns = 0;
  const signedIn = over.signedIn ?? true;
  const frames = over.frames ?? [{ id: FRAME_ID, name: "Home frame" }];
  const deps: Partial<InitDeps> = {
    out: (l) => out.push(l),
    prompt: async (q) => {
      asked.push(q);
      return answers.shift() ?? "";
    },
    store: {
      name: "test store",
      read: async () => (signedIn ? ({ accessToken: TOKEN } as never) : null),
    } as never,
    auth: async (args) => {
      authCalls.push(args);
      return 0;
    },
    listFrames: async () => {
      if (frames instanceof Error) throw frames;
      return frames;
    },
    detectTimezone: () => "America/Los_Angeles",
    readConfig: async () => over.existing ?? null,
    writeConfig: async (v) => {
      writes.push(v);
      return "/config/dir/config.json";
    },
    doctor: async () => {
      doctorRuns++;
      return 0;
    },
    ...over,
  };
  delete (deps as Record<string, unknown>).answers;
  delete (deps as Record<string, unknown>).signedIn;
  delete (deps as Record<string, unknown>).frames;
  delete (deps as Record<string, unknown>).existing;
  return { deps, out, asked, authCalls, writes, doctorRuns: () => doctorRuns };
}

describe("skylight-mcp init", () => {
  it("signed in, one frame: saves the frame and the detected timezone, runs doctor, prints the client snippet", async () => {
    const h = harness({ answers: [""] }); // Enter accepts the detected timezone
    expect(await runInit([], h.deps)).toBe(0);
    expect(h.writes).toEqual([{ frameId: FRAME_ID, timezone: "America/Los_Angeles" }]);
    expect(h.authCalls).toEqual([]);
    expect(h.doctorRuns()).toBe(1);
    const text = h.out.join("\n");
    expect(text).toContain(CLIENT_SNIPPET);
    expect(text).toContain("claude mcp add skylight -- npx -y @davidwoods/skylight-mcp");
    expect(text).not.toContain("SKYLIGHT_FRAME_ID");
  });

  it("never prints the frame ID or any token, only the frame's name", async () => {
    const h = harness({ answers: [""] });
    await runInit([], h.deps);
    const text = h.out.join("\n") + h.asked.join("\n");
    expect(text).not.toContain(FRAME_ID);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("Home frame");
  });

  it("several frames: asks which, by name, and saves the chosen one", async () => {
    const h = harness({
      frames: [
        { id: "1111", name: "Beach house" },
        { id: "2222", name: "Home" },
      ],
      answers: ["", "2"],
    });
    expect(await runInit([], h.deps)).toBe(0);
    expect(h.writes[0]!.frameId).toBe("2222");
    expect(h.out.join("\n")).not.toContain("1111");
    expect(h.out.join("\n")).not.toContain("2222");
  });

  it("when frames cannot be listed it falls back to typing the number, and rejects non-digits", async () => {
    const h = harness({ frames: new Error("HTTP 404"), answers: ["", "abc", "5150"] });
    expect(await runInit([], h.deps)).toBe(0);
    expect(h.writes[0]!.frameId).toBe("5150");
    expect(h.out.join("\n")).toContain("A frame ID is all digits");
  });

  it("not signed in: runs the browser login then complete with the pasted URL, then continues", async () => {
    const h = harness({ signedIn: false, answers: ["", "https://ourskylight.com/welcome?code=c&state=s"] });
    expect(await runInit([], h.deps)).toBe(0);
    expect(h.authCalls).toEqual([["login"], ["complete", "https://ourskylight.com/welcome?code=c&state=s"]]);
    expect(h.writes).toHaveLength(1);
  });

  it("a failed sign-in saves nothing", async () => {
    const h = harness({ signedIn: false, answers: ["", "https://ourskylight.com/welcome?code=bad"], auth: async () => 1 });
    expect(await runInit([], h.deps)).toBe(1);
    expect(h.writes).toEqual([]);
  });

  it("fails closed when the credential store is unusable: nothing saved, no plaintext fallback", async () => {
    const h = harness({
      answers: [""],
      store: {
        name: "keychain",
        read: async () => {
          throw new Error("Keychain locked");
        },
      } as never,
    });
    expect(await runInit([], h.deps)).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.authCalls).toEqual([]);
    expect(h.out.join("\n")).toContain("fails closed");
  });

  it("rejects an invalid timezone three times and saves nothing", async () => {
    const h = harness({ answers: ["Mars/Olympus", "Nope", "Atlantis"] });
    expect(await runInit([], h.deps)).toBe(1);
    expect(h.writes).toEqual([]);
  });

  it("an existing settings file keeps its frame without asking again and offers its timezone as the default", async () => {
    const h = harness({ existing: { frameId: "9090", timezone: "America/Chicago" }, answers: [""], frames: new Error("should not be called") });
    expect(await runInit([], h.deps)).toBe(0);
    expect(h.writes).toEqual([{ frameId: "9090", timezone: "America/Chicago" }]);
    expect(h.asked[0]).toContain("America/Chicago");
  });

  it("exits non-zero when doctor finds a problem, but still prints the snippet", async () => {
    const h = harness({ answers: [""], doctor: async () => 1 });
    expect(await runInit([], h.deps)).toBe(1);
    expect(h.out.join("\n")).toContain(CLIENT_SNIPPET);
  });
});
