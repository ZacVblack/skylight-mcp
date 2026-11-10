import { getConfig, usesEmailAuth, type Config } from "../config.js";
import { detectSubscriptionStatus, login } from "./auth.js";
import { SKYLIGHT_API_VERSION, SKYLIGHT_BASE_URL } from "./constants.js";
import { CredentialStoreError, type CredentialStore } from "./credential-types.js";
import { currentContext } from "../context.js";
import { OAuthError, isExpired, refreshCredential, type StoredCredential } from "./oauth.js";
import {
  AuthenticationError,
  CredentialSaveError,
  NotFoundError,
  RateLimitError,
  SkylightError,
} from "../utils/errors.js";

/**
 * Skylight subscription status types
 */
export type SubscriptionStatus = "plus" | "free" | "trial" | null;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params?: Record<string, string | boolean | number | undefined>;
  body?: unknown;
  /** Override Skylight-Api-Version for this request (some resources need a newer one). */
  apiVersion?: string;
}

/**
 * Skylight API Client
 * Handles authentication and HTTP requests to the Skylight API
 */
/**
 * The frame ID identifies the household, and these log lines end up in terminals, support
 * requests and pasted bug reports. Show the shape of the request, not the ID.
 */
let quietRequestLog = false;
/** Silence the per-request trace lines for interactive CLI commands (init, doctor). Warnings and errors still print. */
export function setQuietRequestLog(quiet: boolean): void {
  quietRequestLog = quiet;
}

export function redactForLog(url: string): string {
  return url.replace(/\/frames\/[^/?#]+/g, "/frames/<frame>");
}

export class SkylightClient {
  private config: Config;
  private resolvedToken: string | null = null;
  private loginPromise: Promise<{ token: string }> | null = null;
  private subscriptionStatus: SubscriptionStatus = null;
  private store: CredentialStore | null;
  private stored: StoredCredential | null = null;
  private storedLoaded = false;
  private refreshPromise: Promise<StoredCredential> | null = null;
  private readonly quiet: boolean;

  /**
   * @param store Where the OAuth credential lives. `null` means "no stored
   * credential is available" (hosted mode, where the token arrives in config).
   * @param options.quiet No per-request trace lines (the library sets this; an importer's
   * logs are not ours to fill). Errors and warnings still print.
   */
  constructor(config?: Config, store: CredentialStore | null = null, options: { quiet?: boolean } = {}) {
    this.config = config ?? getConfig();
    this.store = store;
    this.quiet = options.quiet === true;
  }

  private get traceOff(): boolean {
    return quietRequestLog || this.quiet;
  }

  private getStore(): CredentialStore {
    if (!this.store) {
      throw new AuthenticationError("No credential store is configured for this server.");
    }
    return this.store;
  }

  /** Load the stored OAuth credential once. Fails closed if the store is unusable. */
  private async loadStored(): Promise<StoredCredential | null> {
    if (this.storedLoaded) return this.stored;
    try {
      this.stored = await this.getStore().read();
    } catch (error) {
      if (error instanceof CredentialStoreError) throw new AuthenticationError(error.message);
      throw error;
    }
    this.storedLoaded = true;
    if (this.stored) {
      this.subscriptionStatus = (await detectSubscriptionStatus(this.stored.accessToken)) as SubscriptionStatus;
    }
    return this.stored;
  }

  /**
   * Refresh tokens rotate on use, so concurrent refreshes would invalidate each
   * other. Share one in-flight promise, and re-read the store first in case
   * another process already rotated the credential.
   */
  private refreshStored(): Promise<StoredCredential> {
    if (!this.refreshPromise) {
      const current = this.stored;
      if (!current) throw new AuthenticationError("Not signed in. Run `skylight-mcp auth login`.");
      this.refreshPromise = (async () => {
        const latest = (await this.getStore().read().catch(() => null)) ?? current;
        if (!isExpired(latest) && latest.accessToken !== current.accessToken) {
          this.stored = latest;
          return latest;
        }
        let next: StoredCredential;
        try {
          next = await refreshCredential(latest);
        } catch (error) {
          if (error instanceof OAuthError) {
            throw new AuthenticationError(`${error.message} Run \`skylight-mcp auth login\` again.`);
          }
          throw error;
        }
        try {
          await this.getStore().write(next);
        } catch {
          // Fail closed. The store's message is not printed: it could contain the credential.
          // Forget everything held in memory so no later call quietly keeps a session that a
          // restart could not recover; the next call re-reads the store and asks for a sign-in.
          console.error("[client] Could not save the refreshed credential; this session has ended.");
          this.stored = null;
          this.storedLoaded = false;
          throw new CredentialSaveError();
        }
        this.stored = next;
        return next;
      })().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  /**
   * Get the authentication credentials
   * If using email/password auth, will login first
   */
  private async getCredentials(): Promise<{ token: string }> {
    // 1. Explicit token from the environment
    if (this.config.token) {
      return { token: this.config.token };
    }

    // 2. Stored OAuth credential (refreshed when expired)
    const stored = this.store ? await this.loadStored() : null;
    if (stored) {
      const fresh = isExpired(this.stored ?? stored) ? await this.refreshStored() : (this.stored ?? stored);
      return { token: fresh.accessToken };
    }

    // 3. Deprecated email/password login
    if (!usesEmailAuth(this.config)) {
      throw new AuthenticationError(
        "Not signed in to Skylight. Run `skylight-mcp auth login`, then restart your MCP client."
      );
    }

    if (this.resolvedToken) {
      return { token: this.resolvedToken };
    }

    // If already logging in, wait for that to complete
    if (this.loginPromise) {
      return this.loginPromise;
    }

    // Login with email/password
    this.loginPromise = this.performLogin();
    try {
      const result = await this.loginPromise;
      this.resolvedToken = result.token;
      return result;
    } finally {
      this.loginPromise = null;
    }
  }

  /**
   * Perform login and return token and userId
   */
  private async performLogin(): Promise<{ token: string }> {
    const { email, password } = this.config;
    if (!email || !password) {
      throw new AuthenticationError("Email and password are required for login");
    }

    console.error("Logging in to Skylight...");
    const result = await login(email, password);
    this.subscriptionStatus = result.subscriptionStatus as SubscriptionStatus;
    console.error(`Logged in as ${result.email}${result.subscriptionStatus ? ` (${result.subscriptionStatus})` : ""}`);
    return { token: result.token };
  }

  /**
   * Build the Authorization header
   * Email/password auth now resolves to an OAuth bearer token.
   * Manual token auth still respects the configured auth type.
   */
  private async getAuthHeader(): Promise<string> {
    const { token } = await this.getCredentials();

    // Only an explicit manual token may use Basic; everything else is a bearer token.
    if (this.config.token && this.config.authType === "basic") {
      return `Basic ${token}`;
    }
    return `Bearer ${token}`;
  }

  /**
   * Build URL with query parameters
   */
  private buildUrl(endpoint: string, params?: Record<string, string | boolean | number | undefined>): string {
    const url = new URL(endpoint, SKYLIGHT_BASE_URL);

    // Pin the host: an absolute or protocol-relative endpoint must never
    // redirect the bearer token to another origin.
    if (url.origin !== new URL(SKYLIGHT_BASE_URL).origin) {
      throw new SkylightError("Refusing to send a request outside the Skylight API host.", "HOST_NOT_ALLOWED");
    }

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }

  /**
   * Handle API response errors
   */
  private async handleResponseError(response: Response, url: string): Promise<never> {
    const status = response.status;

    if (status === 401) {
      // Clear cached credentials on auth failure
      this.resolvedToken = null;
      console.error(`[client] 401 Unauthorized for ${redactForLog(url)}`);

      if (!this.config.token) {
        throw new AuthenticationError(
          "API request returned 401. Your frame ID may be wrong or not belong to this account " +
            "(check SKYLIGHT_FRAME_ID), or your session may have been revoked " +
            "(run `skylight-mcp auth login` again)."
        );
      }
      throw new AuthenticationError();
    }

    if (status === 404) {
      throw new NotFoundError("Resource");
    }

    if (status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      throw new RateLimitError(retryAfter ? parseInt(retryAfter, 10) : undefined);
    }

    // Try to get error details from response
    let errorMessage = `HTTP ${status}`;
    try {
      const errorBody = await response.text();
      if (errorBody) {
        errorMessage += `: ${errorBody.slice(0, 200)}`;
      }
    } catch {
      // Ignore parse errors
    }

    throw new SkylightError(errorMessage, "HTTP_ERROR", status, status >= 500);
  }

  /**
   * Make an authenticated request to the Skylight API
   */
  async request<T>(endpoint: string, options: RequestOptions = {}, isRetry = false): Promise<T> {
    const { method = "GET", params, body, apiVersion } = options;

    // Replace {frameId} placeholder with actual frame ID
    const resolvedEndpoint = endpoint.replace("{frameId}", this.config.frameId);
    const url = this.buildUrl(resolvedEndpoint, params);

    if (!this.traceOff) console.error(`[client] ${method} ${redactForLog(url)}`);

    const headers: Record<string, string> = {
      Authorization: await this.getAuthHeader(),
      Accept: "application/json",
      "User-Agent": "SkylightMobile (web)",
      "Skylight-Api-Version": apiVersion ?? SKYLIGHT_API_VERSION,
    };

    if (body) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!this.traceOff) console.error(`[client] Response: ${response.status}`);

    if (!response.ok) {
      // Retry once on 401 with a fresh credential (not for an explicit token)
      if (response.status === 401 && !this.config.token && !isRetry) {
        console.error("[client] Got 401, refreshing credentials...");
        this.resolvedToken = null;
        if (this.stored) this.stored = { ...this.stored, expiresAt: 0 };
        return this.request<T>(endpoint, options, true);
      }
      await this.handleResponseError(response, url);
    }

    // Handle 304 Not Modified
    if (response.status === 304) {
      return {} as T;
    }

    // Some writes (a message delete) answer 200/204 with no body.
    if (response.status === 204) return {} as T;
    const raw = await response.text();
    if (raw.trim() === "") return {} as T;
    return JSON.parse(raw) as T;
  }

  /**
   * GET request helper
   */
  async get<T>(endpoint: string, params?: Record<string, string | boolean | number | undefined>): Promise<T> {
    return this.request<T>(endpoint, { method: "GET", params });
  }

  /**
   * POST request helper
   */
  async post<T>(endpoint: string, body: unknown): Promise<T> {
    return this.request<T>(endpoint, { method: "POST", body });
  }

  /**
   * Get the frame ID from config
   */
  get frameId(): string {
    return this.config.frameId;
  }

  /**
   * Get the timezone from config
   */
  get timezone(): string {
    return this.config.timezone;
  }

  /**
   * Check if user has Plus subscription
   */
  hasPlus(): boolean {
    return this.subscriptionStatus === "plus";
  }

  /**
   * Get the subscription status
   */
  getSubscriptionStatus(): SubscriptionStatus {
    return this.subscriptionStatus;
  }

  /**
   * Initialize the client (triggers login if using email/password auth)
   */
  async initialize(): Promise<void> {
    await this.getCredentials();
  }
}

// Process-wide instance for the single-user stdio server. A hosted server
// sets a per-request client via runWithContext() instead.
let clientInstance: SkylightClient | null = null;

export function getClient(): SkylightClient {
  const context = currentContext();
  if (context) return context.client;
  if (!clientInstance) {
    throw new AuthenticationError("Skylight client has not been initialized.");
  }
  return clientInstance;
}

/**
 * Initialize the process-wide client and return it.
 * Resolves credentials (and logs in, for the deprecated email/password path).
 */
export async function initializeClient(config?: Config, store: CredentialStore | null = null): Promise<SkylightClient> {
  clientInstance = new SkylightClient(config, store);
  await clientInstance.initialize();
  return clientInstance;
}
