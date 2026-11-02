import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigFileError, applyConfigFile, configFilePath, readConfigFile, writeConfigFile } from "../src/config-file.js";
import { loadConfig, setConfigFileDefaults } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";

async function dir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cfg-"));
}

afterEach(() => {
  setConfigFileDefaults({});
  delete process.env.SKYLIGHT_FRAME_ID;
  delete process.env.SKYLIGHT_TIMEZONE;
});

describe("settings file", () => {
  it("round-trips the frame ID and timezone, privately", async () => {
    const d = await dir();
    const file = await writeConfigFile({ frameId: "123456", timezone: "America/Chicago" }, d);
    expect(file).toBe(configFilePath(d));
    expect(await readConfigFile(d)).toEqual({ frameId: "123456", timezone: "America/Chicago" });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("no file is not an error", async () => {
    expect(await readConfigFile(await dir())).toBeNull();
  });

  it("a settings file cannot change where a token is sent: any key beyond frameId and timezone is refused", async () => {
    for (const extra of [{ baseUrl: "https://evil.example" }, { host: "evil.example" }, { apiHost: "https://evil.example" }, { token: "x" }, { SKYLIGHT_API_URL: "https://evil.example" }]) {
      const d = await dir();
      await writeFile(configFilePath(d), JSON.stringify({ frameId: "1", ...extra }), "utf8");
      await expect(readConfigFile(d)).rejects.toBeInstanceOf(ConfigFileError);
      await expect(applyConfigFile(d)).rejects.toBeInstanceOf(ConfigFileError);
    }
  });

  it("refuses a non-numeric frame ID, a bad timezone and broken JSON, and never writes them", async () => {
    const d = await dir();
    await expect(writeConfigFile({ frameId: "abc" }, d)).rejects.toThrow();
    await expect(writeConfigFile({ timezone: "Mars/Olympus" }, d)).rejects.toThrow();
    await writeFile(configFilePath(d), "{ not json", "utf8");
    await expect(readConfigFile(d)).rejects.toBeInstanceOf(ConfigFileError);
  });

  it("an invalid file is never half-applied", async () => {
    const d = await dir();
    await writeFile(configFilePath(d), JSON.stringify({ frameId: "999", baseUrl: "https://evil.example" }), "utf8");
    await expect(applyConfigFile(d)).rejects.toBeInstanceOf(ConfigFileError);
    expect(() => loadConfig()).toThrow(); // exits: frame ID still unset
  });
});

describe("loadConfig with saved settings", () => {
  it("uses the file when the environment is empty", async () => {
    const d = await dir();
    await writeConfigFile({ frameId: "777", timezone: "America/Denver" }, d);
    await applyConfigFile(d);
    const config = loadConfig();
    expect(config.frameId).toBe("777");
    expect(config.timezone).toBe("America/Denver");
  });

  it("environment variables win over the file", async () => {
    setConfigFileDefaults({ frameId: "777", timezone: "America/Denver" });
    process.env.SKYLIGHT_FRAME_ID = "888";
    process.env.SKYLIGHT_TIMEZONE = "UTC";
    const config = loadConfig();
    expect(config.frameId).toBe("888");
    expect(config.timezone).toBe("UTC");
  });

  it("the config has no host-like field for a file to fill", () => {
    setConfigFileDefaults({ frameId: "1" });
    const keys = Object.keys(loadConfig());
    expect(keys.filter((k) => /host|url|base|endpoint/i.test(k))).toEqual([]);
  });
});

describe("doctor with saved settings", () => {
  async function run(over: Parameters<typeof runDoctor>[1]): Promise<string> {
    const lines: string[] = [];
    await runDoctor(["--offline"], {
      env: {} as never,
      nodeVersion: "24.0.0",
      store: { name: "test", read: async () => ({}) as never } as never,
      out: (l: string) => lines.push(l),
      ...over,
    });
    return lines.join("\n");
  }

  it("counts a saved frame ID and timezone as set, and says where they came from, without printing the ID", async () => {
    const out = await run({ fileConfig: { frameId: "13572468", timezone: "America/Chicago" } });
    expect(out).toContain("Frame ID is set (saved by skylight-mcp init)");
    expect(out).toContain("Timezone is America/Chicago (saved by skylight-mcp init)");
    expect(out).not.toContain("13572468");
    expect(out).not.toContain("export SKYLIGHT_FRAME_ID");
  });

  it("reports an unusable settings file as a failure", async () => {
    const out = await run({ fileConfig: null, fileConfigError: "settings.json is not valid" });
    expect(out).toContain("[FAIL] Settings file problem: settings.json is not valid");
  });

  it("with nothing set it points to init first", async () => {
    const out = await run({ fileConfig: null });
    expect(out).toContain("skylight-mcp init");
  });
});
