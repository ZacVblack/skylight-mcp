/**
 * `skylight-mcp auth ...` commands. These are CLI-only on purpose: credential
 * handling is never exposed as an MCP tool.
 *
 *   skylight-mcp auth login            print the sign-in URL
 *   skylight-mcp auth complete [url]   paste the final redirect URL to finish
 *   skylight-mcp auth status           show whether a credential is stored
 *   skylight-mcp auth logout           delete the stored credential
 */

import { createInterface } from "node:readline/promises";
import { defaultCredentialStore, savePendingLogin, takePendingLogin, type CredentialStore } from "./api/credential-store.js";
import {
  OAuthError,
  PENDING_LOGIN_TTL_MS,
  beginBrowserLogin,
  completeBrowserLogin,
  isExpired,
  refreshCredential,
  type PendingLogin,
  type StoredCredential,
} from "./api/oauth.js";

export interface CliDeps {
  store: CredentialStore;
  out: (line: string) => void;
  prompt: (question: string) => Promise<string>;
  savePending: (pending: PendingLogin) => Promise<void>;
  takePending: () => Promise<PendingLogin | null>;
  complete: (url: string, pending: PendingLogin) => Promise<StoredCredential>;
  refresh: (credential: StoredCredential) => Promise<StoredCredential>;
  now: () => number;
  /** Print the "now run complete" instructions after login. `init` turns this off. */
  showNextStep: boolean;
}

function defaultDeps(): CliDeps {
  return {
    store: defaultCredentialStore(),
    out: (line) => console.log(line),
    prompt: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    savePending: (pending) => savePendingLogin(pending),
    takePending: () => takePendingLogin(),
    complete: (url, pending) => completeBrowserLogin(url, pending),
    refresh: (credential) => refreshCredential(credential),
    now: () => Date.now(),
    showNextStep: true,
  };
}

const USAGE = `Usage: skylight-mcp auth <command>

  login            Print a Skylight sign-in URL. Open it in your browser.
  complete [url]   After signing in, paste the final URL (https://ourskylight.com/welcome?...).
  status           Show whether you are signed in.
  logout           Remove the stored credential.`;

export async function runAuthCommand(args: readonly string[], overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };
  const [command, ...rest] = args;

  try {
    switch (command) {
      case "login": {
        const { loginUrl, pending } = beginBrowserLogin(deps.now());
        await deps.savePending(pending);
        deps.out("1. Open this URL in your browser and sign in to Skylight\n   (Windows Terminal: hold Ctrl and click it; otherwise copy it into your browser):\n");
        deps.out(`   ${loginUrl}\n`);
        deps.out("2. Skylight bounces the browser through https://ourskylight.com/welcome?code=... too fast");
        deps.out("   to copy. Get it from browser history: Cmd-Y (Mac) / Ctrl-H (PC), search \"welcome?code\",");
        deps.out("   right-click the Skylight result dated today (top of the list; older ones are earlier");
        deps.out("   sign-ins and will not work), Copy link address.\n");
        if (deps.showNextStep) {
          deps.out("3. Run the same command you just ran, with `complete` instead of `login`,");
          deps.out(`   and paste the URL at the prompt. This login expires in ${PENDING_LOGIN_TTL_MS / 60_000} minutes.`);
        } else {
          deps.out(`This login expires in ${PENDING_LOGIN_TTL_MS / 60_000} minutes.\n`);
        }
        return 0;
      }

      case "complete": {
        const url = rest[0] ?? (await deps.prompt("Paste the full redirect URL: "));
        if (!url.trim()) {
          deps.out("No URL provided.");
          return 1;
        }
        const pending = await deps.takePending();
        if (!pending) {
          deps.out("No login in progress. Run `skylight-mcp auth login` first.");
          return 1;
        }
        const credential = await deps.complete(url, pending);
        await deps.store.write(credential);
        deps.out(`Signed in. Credential saved (${deps.store.name}).`);
        if (deps.showNextStep) deps.out("Restart your MCP client to pick it up.");
        return 0;
      }

      case "status": {
        const credential = await deps.store.read();
        if (!credential) {
          deps.out("Not signed in. Run `skylight-mcp auth login`.");
          return 1;
        }
        const expiry = new Date(credential.expiresAt).toISOString();
        deps.out(`Signed in. Storage: ${deps.store.name}.`);
        deps.out(
          isExpired(credential, deps.now())
            ? `Access token expired at ${expiry}; it will refresh on next use.`
            : `Access token valid until ${expiry}.`
        );
        return 0;
      }

      case "logout": {
        const removed = await deps.store.delete();
        deps.out(removed ? "Signed out. Stored credential removed." : "Nothing to remove.");
        deps.out("Note: this does not revoke the session on Skylight's side.");
        return 0;
      }

      default:
        deps.out(USAGE);
        return command === undefined || command === "help" || command === "--help" ? 0 : 1;
    }
  } catch (error) {
    if (error instanceof OAuthError || error instanceof Error) {
      deps.out(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
