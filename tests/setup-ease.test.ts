import { describe, expect, it, vi } from "vitest";
import { setupPage, versionResponse } from "../src/worker/pages.js";
import { runDoctor } from "../src/doctor.js";


describe("hosted setup helpers", () => {
  it("/version returns the version and nothing else", async () => {
    const body = (await versionResponse("9.9.9").json()) as Record<string, string>;
    expect(body).toEqual({ name: "skylight-mcp", version: "9.9.9" });
  });

  it("/setup shows the connector address for the host it was served from, and no secrets", async () => {
    const text = await setupPage("https://w.example", "America/Los_Angeles").text();
    expect(text).toContain("https://w.example/mcp");
    expect(text).toContain("America/Los_Angeles");
  });

  it("/setup escapes what it echoes", async () => {
    const text = await setupPage('https://w.example"><script>x</script>', "UTC").text();
    expect(text).not.toContain("<script>x");
  });
});

describe("doctor setup hints", () => {
  async function run(env: Record<string, string>): Promise<string> {
    const lines: string[] = [];
    await runDoctor(["--offline"], {
      env: env as never,
      nodeVersion: "24.0.0",
      store: { name: "test", read: async () => ({}) as never } as never,
      out: (l: string) => lines.push(l),
    });
    return lines.join("\n");
  }

  it("prints macOS and PowerShell forms when the frame ID or timezone is missing, with placeholders only", async () => {
    const out = await run({});
    expect(out).toContain("export SKYLIGHT_FRAME_ID=your_frame_id");
    expect(out).toContain("$env:SKYLIGHT_FRAME_ID");
    expect(out).toContain("setx");
  });

  it("prints no hint when both are set", async () => {
    const out = await run({ SKYLIGHT_FRAME_ID: "123", SKYLIGHT_TIMEZONE: "America/Chicago" });
    expect(out).not.toContain("export SKYLIGHT_FRAME_ID");
  });
});
