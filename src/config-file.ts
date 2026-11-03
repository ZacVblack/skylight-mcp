/**
 * The settings file written by `skylight-mcp init`: your frame ID and timezone,
 * kept next to the stored sign-in so you do not have to export environment
 * variables in every terminal and MCP client config.
 *
 * Local entry points only. The hosted Worker never reads a file (and this module
 * imports Node built-ins, so it must not be imported from src/worker).
 *
 * Deliberately tiny and strict: only `frameId` and `timezone` are accepted. An
 * unknown key, such as anything that looks like a host or a token, is an error,
 * so the file cannot change where a bearer token is sent. The file holds no
 * secret; it is still written private (0600) because the frame ID is yours.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defaultConfigDirectory, ensureDirectory, writePrivateFile } from "./api/credential-store.js";
import { setConfigFileDefaults } from "./config.js";

const CONFIG_FILE = "config.json";

export class ConfigFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigFileError";
  }
}

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const ConfigFileSchema = z
  .object({
    frameId: z.string().regex(/^\d+$/, "frameId must be all digits").optional(),
    timezone: z
      .string()
      .refine(validTimeZone, "timezone must be an IANA name such as America/Chicago")
      .optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export function configFilePath(directory: string = defaultConfigDirectory()): string {
  return path.join(directory, CONFIG_FILE);
}

/** Returns null when there is no file. Throws ConfigFileError when it is present but invalid. */
export async function readConfigFile(directory: string = defaultConfigDirectory()): Promise<ConfigFile | null> {
  const file = configFilePath(directory);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigFileError(`Cannot read ${file}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigFileError(`${file} is not valid JSON. Run "skylight-mcp init" to rewrite it, or delete it.`);
  }
  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    const problems = result.error.issues.map((i) => i.message).join("; ");
    throw new ConfigFileError(`${file} is not valid (${problems}). Run "skylight-mcp init" to rewrite it, or delete it.`);
  }
  return result.data;
}

export async function writeConfigFile(values: ConfigFile, directory: string = defaultConfigDirectory()): Promise<string> {
  const checked = ConfigFileSchema.parse(values);
  await ensureDirectory(directory);
  const file = configFilePath(directory);
  await writePrivateFile(file, `${JSON.stringify(checked, null, 2)}\n`);
  return file;
}

/**
 * Read the file and make its values the defaults for loadConfig(). Environment
 * variables still win. Throws ConfigFileError on a bad file so the caller can
 * refuse to start rather than guess.
 */
export async function applyConfigFile(directory: string = defaultConfigDirectory()): Promise<ConfigFile | null> {
  const file = await readConfigFile(directory);
  setConfigFileDefaults(file ?? {});
  return file;
}
