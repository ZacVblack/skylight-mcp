import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, setConfigFileDefaults } from "../src/config.js";

afterEach(() => {
  setConfigFileDefaults({});
  delete process.env.SKYLIGHT_FRAME_ID;
  vi.restoreAllMocks();
});

describe("missing frame ID", () => {
  it("fails closed with a message a person can act on", () => {
    delete process.env.SKYLIGHT_FRAME_ID;
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => void lines.push(String(m)));
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    expect(() => loadConfig()).toThrow("exit");
    const text = lines.join("\n");
    expect(text).toContain("No frame ID. Run init");
    expect(text).toContain("npx -y @davidwoods/skylight-mcp init");
    expect(text).not.toContain("expected string, received undefined");
    expect(text).not.toContain("proxy tool");
  });
});
