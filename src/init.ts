/**
 * `skylight-mcp init`: one guided command in place of the manual setup steps.
 * It detects your timezone, signs you in (the same browser-paste login as
 * `auth login`, PKCE and state check included), finds your frame ID from the
 * API, saves both to the settings file, runs `doctor`, and prints the snippet
 * for your MCP client.
 *
 * CLI only, like every credential operation. It never prints a token or your
 * frame ID (it shows the frame's name so you can tell frames apart), and it
 * cannot be pointed at another host: the client it builds is the same pinned
 * one the server uses.
 */

import { createInterface } from "node:readline/promises";
import { SkylightClient } from "./api/client.js";
import { defaultCredentialStore, type CredentialStore } from "./api/credential-store.js";
import { runAuthCommand } from "./cli.js";
import {
  applyConfigFile,
  configFilePath,
  readConfigFile,
  validTimeZone,
  writeConfigFile,
  type ConfigFile,
} from "./config-file.js";
import { runDoctor } from "./doctor.js";

export interface FrameChoice {
  id: string;
  name: string;
}

export interface InitDeps {
  out: (line: string) => void;
  /** `initial` is pre-filled after the question and can be edited or accepted with Enter. */
  prompt: (question: string, initial?: string) => Promise<string>;
  store: CredentialStore;
  /** Runs `skylight-mcp auth <args>`. */
  auth: (args: string[]) => Promise<number>;
  /** Frames the signed-in account can see. Throws when the API call fails. */
  listFrames: () => Promise<FrameChoice[]>;
  detectTimezone: () => string;
  readConfig: () => Promise<ConfigFile | null>;
  writeConfig: (values: ConfigFile) => Promise<string>;
  /** Runs `doctor` against what was just saved. Returns its exit code. */
  doctor: () => Promise<number>;
}

interface FramesResponse {
  data?: Array<{ id?: string | number; attributes?: { name?: unknown; title?: unknown } }>;
}

function defaultDeps(): InitDeps {
  const store = defaultCredentialStore();
  return {
    out: (line) => console.log(line),
    prompt: async (question, initial) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = rl.question(question);
        if (initial && process.stdin.isTTY) rl.write(initial);
        return await answer;
      } finally {
        rl.close();
      }
    },
    store,
    auth: (args) => runAuthCommand(args, { store, showNextStep: false }),
    listFrames: async () => {
      // The frames list is not scoped to a frame, so the placeholder ID is never sent.
      const client = new SkylightClient({ frameId: "0", timezone: "UTC", authType: "bearer" }, store);
      await client.initialize();
      const response = await client.get<FramesResponse>("/api/frames");
      return (response.data ?? [])
        .filter((f) => f.id !== undefined && /^\d+$/.test(String(f.id)))
        .map((f) => {
          const label = f.attributes?.name ?? f.attributes?.title;
          return { id: String(f.id), name: typeof label === "string" && label.trim() ? label : "(unnamed)" };
        });
    },
    detectTimezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
    readConfig: () => readConfigFile(),
    writeConfig: (values) => writeConfigFile(values),
    doctor: async () => {
      await applyConfigFile();
      return runDoctor([], { fileConfig: await readConfigFile() });
    },
  };
}

async function askTimezone(deps: InitDeps, suggested: string): Promise<string | null> {
  deps.out("Press Enter to keep the timezone below (it is your computer's), or edit it to a name like");
  deps.out("America/Chicago or Europe/London. Full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones");
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = (await deps.prompt("Timezone: ", suggested)).trim() || suggested;
    if (validTimeZone(answer)) return answer;
    deps.out(`"${answer}" is not an IANA timezone name. Examples: America/New_York, America/Chicago, America/Los_Angeles.`);
  }
  return null;
}

async function askFrame(deps: InitDeps): Promise<string | null> {
  let frames: FrameChoice[] = [];
  try {
    frames = await deps.listFrames();
  } catch (error) {
    deps.out(`Could not list your Skylight frames (${error instanceof Error ? error.message : "unknown error"}). This API is unofficial and can change.`);
  }

  if (frames.length === 1) {
    deps.out(`Found your frame: ${frames[0]!.name}.`);
    return frames[0]!.id;
  }

  if (frames.length > 1) {
    deps.out("Found several frames:");
    frames.forEach((f, i) => deps.out(`  ${i + 1}. ${f.name}`));
    for (let attempt = 0; attempt < 3; attempt++) {
      const pick = Number((await deps.prompt(`Which one is yours (1-${frames.length})? `)).trim());
      if (Number.isInteger(pick) && pick >= 1 && pick <= frames.length) return frames[pick - 1]!.id;
    }
    return null;
  }

  deps.out("Enter your frame ID by hand: sign in at https://ourskylight.com and copy the number in the address bar,");
  deps.out("https://ourskylight.com/my-skylight/<number>.");
  for (let attempt = 0; attempt < 3; attempt++) {
    const typed = (await deps.prompt("Frame ID: ")).trim();
    if (/^\d+$/.test(typed)) return typed;
    deps.out("A frame ID is all digits.");
  }
  return null;
}

export function clientSnippet(platform: string = process.platform): string {
  const command = platform === "win32" ? '"cmd"' : '"npx"';
  const args = platform === "win32" ? '["/c", "npx", "-y", "@davidwoods/skylight-mcp"]' : '["-y", "@davidwoods/skylight-mcp"]';
  return [
    "Add it to your MCP client. Nothing else needs configuring: your frame ID and timezone are read from the saved settings.",
    "",
    "Claude desktop (Settings > Developer > Edit Config), or any client that uses mcp.json:",
    "",
    "  {",
    '    "mcpServers": {',
    '      "skylight": {',
    `        "command": ${command},`,
    `        "args": ${args}`,
    "      }",
    "    }",
    "  }",
    "",
    "Claude Code:",
    "",
    platform === "win32"
      ? "  claude mcp add skylight -- cmd /c npx -y @davidwoods/skylight-mcp"
      : "  claude mcp add skylight -- npx -y @davidwoods/skylight-mcp",
    "",
    "Then restart the client fully and ask: what's on the family calendar this week?",
  ].join("\n");
}

export async function runInit(_args: readonly string[], overrides: Partial<InitDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };

  try {
    deps.out("skylight-mcp setup. This signs you in, finds your frame and saves your settings.\n");

    let existing: ConfigFile | null = null;
    try {
      existing = await deps.readConfig();
    } catch (error) {
      deps.out(`Existing settings file is unusable and will be rewritten: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    // 1. Timezone
    const timezone = await askTimezone(deps, existing?.timezone ?? deps.detectTimezone());
    if (!timezone) {
      deps.out("No valid timezone given. Nothing was saved.");
      return 1;
    }

    // 2. Sign in (fails closed if the credential store is unusable)
    let credential;
    try {
      credential = await deps.store.read();
    } catch (error) {
      deps.out(`Credential store unusable: ${error instanceof Error ? error.message : "unknown error"}. It fails closed; nothing falls back to plaintext. Nothing was saved.`);
      return 1;
    }
    if (!credential) {
      if ((await deps.auth(["login"])) !== 0) return 1;
      const url = (await deps.prompt("Paste the full redirect URL here: ")).trim();
      if (!url) {
        deps.out("No URL provided. Nothing was saved. Run init again.");
        return 1;
      }
      if ((await deps.auth(["complete", url])) !== 0) {
        deps.out("Sign-in did not complete. Nothing was saved. Run init again.");
        return 1;
      }
    } else {
      deps.out(`Already signed in (${deps.store.name}).`);
    }

    // 3. Frame
    const frameId = existing?.frameId ?? (await askFrame(deps));
    if (!frameId) {
      deps.out("No frame chosen. Nothing was saved.");
      return 1;
    }

    // 4. Save
    const saved = await deps.writeConfig({ frameId, timezone });
    deps.out(`\nSaved your frame and timezone (${timezone}) to ${saved}. No secret is in that file.\n`);

    // 5. Check, then show the client snippet
    const doctorCode = await deps.doctor();
    deps.out("");
    deps.out(clientSnippet());
    return doctorCode === 0 ? 0 : 1;
  } catch (error) {
    deps.out(`Error: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
}

export { configFilePath };
