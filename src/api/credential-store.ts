/**
 * Local credential storage.
 *
 * macOS: the OAuth credential is AES-256-GCM encrypted into a 0600 file; the
 * 256-bit key lives in the macOS Keychain, so the file alone is useless.
 * Other platforms: a 0600 file inside a 0700 directory (no encryption; anything
 * running as your user can read it, same as ~/.ssh keys).
 *
 * Neither store ever falls back silently to something weaker: if the Keychain
 * cannot be used, writes fail with an error.
 *
 * Structure informed by kamilio/skylight-calendar-agent (MIT); see
 * THIRD_PARTY_NOTICES.md.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { SKYLIGHT_BASE_URL } from "./constants.js";
import { CredentialStoreError, type CredentialStore } from "./credential-types.js";
import { parseStoredCredential, type PendingLogin } from "./oauth.js";

export { CredentialStoreError, type CredentialStore };

const KEYCHAIN_SERVICE = "skylight-mcp.encryption-key";
const KEYCHAIN_LABEL = "skylight-mcp";
const KEYCHAIN_TIMEOUT_MS = 15_000;
const CREDENTIAL_FILE = "credential.json";
const ENCRYPTED_FILE = "credential.enc.json";
const PENDING_FILE = "pending-login.json";

export function defaultConfigDirectory(): string {
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "skylight-mcp");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "skylight-mcp");
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "skylight-mcp");
}

export async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

/** Write atomically with 0600 permissions. */
export async function writePrivateFile(destination: string, contents: string): Promise<void> {
  const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function removeIfExists(file: string): Promise<boolean> {
  try {
    await rm(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// ---------------------------------------------------------------- file store

export function createFileCredentialStore(options: { directory?: string } = {}): CredentialStore {
  const directory = options.directory ?? defaultConfigDirectory();
  const file = path.join(directory, CREDENTIAL_FILE);

  return {
    // Windows ignores Unix modes, so don't claim 0600 there: say what actually protects the file.
    name: process.platform === "win32" ? "credential file, unencrypted, protected only by your Windows profile" : "credential file (0600)",
    async read() {
      const raw = await readIfExists(file);
      if (raw === null) return null;
      try {
        return parseStoredCredential(JSON.parse(raw));
      } catch {
        throw new CredentialStoreError("The stored credential file is corrupt. Run `skylight-mcp auth login` again.");
      }
    },
    async write(credential) {
      await ensureDirectory(directory);
      await writePrivateFile(file, `${JSON.stringify(credential)}\n`);
    },
    async delete() {
      return removeIfExists(file);
    },
  };
}

// ------------------------------------------------------------ keychain store

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type KeychainRunner = (args: readonly string[], input?: string) => Promise<CommandResult>;

function securityRunner(command = "/usr/bin/security"): KeychainRunner {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new CredentialStoreError("macOS Keychain operation timed out."));
      }, KEYCHAIN_TIMEOUT_MS);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stdout.length < 20_000) stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 20_000) stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new CredentialStoreError(`macOS Keychain command failed: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
      child.stdin.end(input);
    });
}

interface EncryptedPayload {
  version: 1;
  iv: string;
  ciphertext: string;
  tag: string;
}

function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decrypt(payload: EncryptedPayload, key: Buffer): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new CredentialStoreError("The stored credential could not be decrypted. Run `skylight-mcp auth login` again.");
  }
}

function parseEncrypted(raw: string): EncryptedPayload {
  let parsed: Partial<EncryptedPayload> | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<EncryptedPayload>;
  } catch {
    // handled below
  }
  if (
    !parsed ||
    parsed.version !== 1 ||
    typeof parsed.iv !== "string" ||
    typeof parsed.ciphertext !== "string" ||
    typeof parsed.tag !== "string"
  ) {
    throw new CredentialStoreError("The encrypted credential file is invalid. Run `skylight-mcp auth login` again.");
  }
  return parsed as EncryptedPayload;
}

export function createKeychainCredentialStore(
  options: { directory?: string; runner?: KeychainRunner; account?: string } = {}
): CredentialStore {
  const directory = options.directory ?? defaultConfigDirectory();
  const run = options.runner ?? securityRunner();
  const account = options.account ?? SKYLIGHT_BASE_URL;
  const file = path.join(directory, ENCRYPTED_FILE);

  const readKey = async (): Promise<Buffer | null> => {
    const result = await run(["find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"]);
    if (result.code === 44) return null; // item not found
    if (result.code !== 0) {
      throw new CredentialStoreError(`Could not read the encryption key from macOS Keychain (exit ${result.code}).`);
    }
    const key = Buffer.from(result.stdout.replace(/[\r\n]+$/, ""), "base64");
    if (key.length !== 32) {
      throw new CredentialStoreError("The encryption key in macOS Keychain is invalid. Run `skylight-mcp auth logout`, then log in again.");
    }
    return key;
  };

  const writeKey = async (key: Buffer): Promise<void> => {
    const encoded = key.toString("base64");
    // `security add-generic-password -w` with no value reads from the TTY, not
    // stdin, so it hangs when run from a program. `security -i` instead reads
    // whole commands from stdin, which keeps the key out of the process
    // argument list. None of the values need quoting: the account is a URL,
    // the service and label have no spaces, and the key is base64.
    const result = await run(
      ["-i"],
      `add-generic-password -U -a ${account} -s ${KEYCHAIN_SERVICE} -l ${KEYCHAIN_LABEL} -w ${encoded}\n`
    );
    if (result.code !== 0) {
      throw new CredentialStoreError(`Could not store the encryption key in macOS Keychain (exit ${result.code}).`);
    }
    // Interactive mode does not reliably report per-command failures, so
    // confirm the key is really there before encrypting anything with it.
    const stored = await readKey();
    if (stored === null || !stored.equals(key)) {
      throw new CredentialStoreError("macOS Keychain did not store the encryption key. Nothing was saved.");
    }
  };

  return {
    name: "macOS Keychain + encrypted file",
    async read() {
      const raw = await readIfExists(file);
      if (raw === null) return null;
      const key = await readKey();
      if (key === null) {
        throw new CredentialStoreError("The encryption key is missing from macOS Keychain. Run `skylight-mcp auth login` again.");
      }
      const plaintext = decrypt(parseEncrypted(raw), key);
      try {
        return parseStoredCredential(JSON.parse(plaintext));
      } catch {
        throw new CredentialStoreError("The stored credential is corrupt. Run `skylight-mcp auth login` again.");
      }
    },
    async write(credential) {
      let key = await readKey();
      if (key === null) {
        key = randomBytes(32);
        await writeKey(key);
      }
      await ensureDirectory(directory);
      await writePrivateFile(file, `${JSON.stringify(encrypt(JSON.stringify(credential), key))}\n`);
    },
    async delete() {
      const removedFile = await removeIfExists(file);
      const result = await run(["delete-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE]);
      if (result.code !== 0 && result.code !== 44) {
        throw new CredentialStoreError(`Could not remove the encryption key from macOS Keychain (exit ${result.code}).`);
      }
      return removedFile || result.code === 0;
    },
  };
}

export function defaultCredentialStore(): CredentialStore {
  return process.platform === "darwin" ? createKeychainCredentialStore() : createFileCredentialStore();
}

// -------------------------------------------------------------- pending login

/** Persist the PKCE verifier + state between `auth login` and `auth complete`. */
export async function savePendingLogin(pending: PendingLogin, directory = defaultConfigDirectory()): Promise<void> {
  await ensureDirectory(directory);
  await writePrivateFile(path.join(directory, PENDING_FILE), `${JSON.stringify(pending)}\n`);
}

/** Read and delete the pending login (single use). Returns null if none. */
export async function takePendingLogin(directory = defaultConfigDirectory()): Promise<PendingLogin | null> {
  const file = path.join(directory, PENDING_FILE);
  const raw = await readIfExists(file);
  if (raw === null) return null;
  await removeIfExists(file);
  try {
    const parsed = JSON.parse(raw) as Partial<PendingLogin>;
    if (
      typeof parsed.state === "string" &&
      typeof parsed.codeVerifier === "string" &&
      typeof parsed.fingerprint === "string" &&
      typeof parsed.createdAt === "number"
    ) {
      return parsed as PendingLogin;
    }
  } catch {
    // fall through
  }
  return null;
}
