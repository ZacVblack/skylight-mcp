/**
 * `skylight-mcp calendars ...` commands. CLI-only on purpose: a calendar feed
 * address is a secret, so it is typed into a hidden prompt here and never passes
 * through an MCP tool argument, a chat transcript, a command line or a log.
 *
 *   skylight-mcp calendars add     paste a calendar address (hidden) to sync it
 */

import { addCalendarFeed, FeedAddressError, checkFeedUrl, type AddFeedResult } from "./api/endpoints/source-calendars.js";
import { PromptCancelled, promptHidden } from "./prompt-hidden.js";

export interface CalendarsDeps {
  out: (line: string) => void;
  prompt: (question: string) => Promise<string>;
  addFeed: (address: string) => Promise<AddFeedResult>;
}

async function defaultAddFeed(address: string): Promise<AddFeedResult> {
  const { loadConfig } = await import("./config.js");
  const { initializeClient } = await import("./api/client.js");
  const { defaultCredentialStore } = await import("./api/credential-store.js");
  await initializeClient(loadConfig(), defaultCredentialStore());
  return addCalendarFeed(address);
}

function defaultDeps(): CalendarsDeps {
  return { out: (line) => console.log(line), prompt: (q) => promptHidden(q), addFeed: defaultAddFeed };
}

const USAGE = `Usage: skylight-mcp calendars add

  add    Sync a calendar feed (a team, school or league schedule) to your Skylight
         calendar. You paste the address when asked; it is not shown.`;

export async function runCalendarsCommand(args: readonly string[], overrides: Partial<CalendarsDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };
  const [command, ...rest] = args;

  if (command !== "add") {
    deps.out(USAGE);
    return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  }
  if (rest.length > 0) {
    deps.out("Do not put the calendar address on the command line: it would be saved in your shell history.");
    deps.out("Run `skylight-mcp calendars add` with nothing after it and paste the address when asked.");
    return 2;
  }

  deps.out("Paste the calendar's subscription link (usually ends in .ics or starts with webcal://), then press Enter.");
  deps.out("Nothing is shown as you paste. Treat the address like a password.");
  let address = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      address = await deps.prompt("Calendar address: ");
    } catch (error) {
      if (error instanceof PromptCancelled) return 130;
      throw error;
    }
    const check = checkFeedUrl(address);
    if (check.ok) break;
    deps.out(check.reason);
    address = "";
  }
  if (!address) {
    deps.out("No valid address after three tries. Nothing was sent.");
    return 2;
  }

  try {
    const result = await deps.addFeed(address);
    if (result.status === "already_synced") {
      deps.out(`That calendar (${result.host}) is already synced. Nothing changed.`);
      return 0;
    }
    deps.out(`Added${result.name ? ` "${result.name}"` : ""} (${result.host}).`);
    deps.out("Skylight fetches the feed itself, so give it a moment, then check the app.");
    return 0;
  } catch (error) {
    if (error instanceof FeedAddressError) {
      deps.out(error.message);
      return 2;
    }
    deps.out(`Could not add the calendar: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
