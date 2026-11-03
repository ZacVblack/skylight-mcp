import { spawn } from "node:child_process";
import { SKYLIGHT_BASE_URL } from "./api/constants.js";

/**
 * Open the Skylight sign-in page in the default browser. Refuses any URL that is
 * not on the pinned Skylight host, so nothing can use this to open an arbitrary
 * address. Arguments are passed as an array, never through a shell (on Windows,
 * rundll32 avoids cmd's handling of `&` in query strings).
 * Resolves true if a launcher was started, false if it could not be.
 */
export function isSkylightUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === new URL(SKYLIGHT_BASE_URL).origin;
  } catch {
    return false;
  }
}

export function openerFor(platform: string, url: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { command: "xdg-open", args: [url] };
}

export async function openSkylightUrl(url: string, platform: string = process.platform): Promise<boolean> {
  if (!isSkylightUrl(url)) return false;
  const { command, args } = openerFor(platform, url);
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
