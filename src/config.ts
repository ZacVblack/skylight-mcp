import { z } from "zod";
import { currentContext } from "./context.js";

// Auth sources, in the order the client tries them (see SkylightClient):
// 1. SKYLIGHT_TOKEN - explicit token from the environment
// 2. Stored OAuth credential from `skylight-mcp auth login` (recommended)
// 3. SKYLIGHT_EMAIL + SKYLIGHT_PASSWORD - deprecated; puts the password in env
// Whether any source exists is checked by the client, because the stored
// credential is not visible to the config layer.
const ConfigSchema = z.object({
  // Deprecated email/password auth
  email: z.string().email().optional(),
  password: z.string().min(1).optional(),

  // Explicit token
  token: z.string().min(1).optional(),
  authType: z.enum(["bearer", "basic"]).default("bearer"),

  // Required
  frameId: z.string().min(1, "SKYLIGHT_FRAME_ID is required"),

  // Optional
  timezone: z.string().default("America/New_York"),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface ResolvedConfig {
  token: string;
  frameId: string;
  timezone: string;
  authType: "bearer" | "basic";
}

/**
 * Settings saved by `skylight-mcp init`, applied only by the local entry points
 * (src/index.ts), never by the hosted Worker. This module stays free of Node
 * built-ins so the Worker bundle can import it. Environment variables win.
 * Only the frame ID and timezone can come from here: nothing that decides where
 * a token is sent is configurable at all (the API host is pinned in code).
 */
export interface FileDefaults {
  frameId?: string;
  timezone?: string;
}

let fileDefaults: FileDefaults = {};

export function setConfigFileDefaults(defaults: FileDefaults): void {
  fileDefaults = { frameId: defaults.frameId, timezone: defaults.timezone };
  cachedConfig = null;
}

export function loadConfig(): Config {
  const result = ConfigSchema.safeParse({
    email: process.env.SKYLIGHT_EMAIL,
    password: process.env.SKYLIGHT_PASSWORD,
    token: process.env.SKYLIGHT_TOKEN,
    frameId: process.env.SKYLIGHT_FRAME_ID || fileDefaults.frameId,
    authType: process.env.SKYLIGHT_AUTH_TYPE || "bearer",
    timezone: process.env.SKYLIGHT_TIMEZONE || fileDefaults.timezone || "America/New_York",
  });

  if (!result.success) {
    const errors = result.error.issues.map((e) => `  - ${e.message}`).join("\n");
    console.error(`
Skylight MCP Server - Configuration Error

Missing or invalid configuration:
${errors}

Easiest setup: run "npx -y @davidwoods/skylight-mcp init". It signs you in,
finds your frame ID and saves your settings.

Authentication (recommended): run "skylight-mcp auth login" once. You sign in
in your own browser; your password is never given to this program.

Deprecated alternatives:
  SKYLIGHT_EMAIL / SKYLIGHT_PASSWORD - stores your password in the MCP config
  SKYLIGHT_TOKEN / SKYLIGHT_AUTH_TYPE - a manually captured token

Required:
  SKYLIGHT_FRAME_ID - Your frame/household ID

Optional:
  SKYLIGHT_TIMEZONE - Timezone for dates (default: America/New_York)

To find your frame ID:
1. Log in to the Skylight app
2. Use a proxy tool to capture API traffic
3. Look for the frame ID in URLs like /api/frames/{frameId}/chores
`);
    process.exit(1);
    // process.exit never returns in Node; this satisfies runtimes whose types disagree.
    throw new Error("Invalid configuration");
  }

  return result.data;
}

let cachedConfig: Config | null = null;

export function getConfig(): Config {
  const context = currentContext();
  if (context) return context.config;
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

/**
 * Check if config uses managed OAuth login via email/password
 */
export function usesEmailAuth(config: Config): boolean {
  return !!(config.email && config.password);
}
