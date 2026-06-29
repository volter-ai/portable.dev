import type { LocalSecretStore } from '@vgit2/shared/secrets';

/**
 * Local-first GitHub access via the OAuth **device flow**.
 *
 * In local-first mode the PC is the runtime, so GitHub access is the user's OWN
 * token, obtained on-device and persisted in the local encrypted store — never a
 * JWT claim minted by the gateway, and never the remote `github-app` service.
 * A GitHub OAuth App configured for the device flow supplies a public
 * client id via local config (`GITHUB_OAUTH_CLIENT_ID`); the PC runs the device
 * flow (prints a code + verification URL, polls for completion) and stores the
 * resulting `repo`/`read:org` token here.
 *
 * The token shares the SAME `LocalSecretStore` as connection credentials
 * the device-token signing secret, and the Claude OAuth
 * token, under a namespaced key — reuse the single store instance from
 * `server.ts`, don't build a second one.
 *
 * `ConnectionsService.getActiveGitHubConnection` short-circuits to this service in
 * local mode, so `GitHubApiService` (Octokit), the scope/permission checks, and the
 * git commit-author setup all read this local token through the existing funnel.
 */

/** Namespaced LocalSecretStore key for the persisted GitHub device-flow token. */
export const GITHUB_DEVICE_TOKEN_KEY = 'github-oauth:token';

/** Default OAuth scopes requested by the device flow. */
export const GITHUB_DEFAULT_SCOPES = ['repo', 'read:org'];

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

/** Shape persisted in the local encrypted store. */
export interface StoredGitHubToken {
  token: string;
  scopes: string[];
  /** GitHub login (best-effort; may be absent if the /user fetch failed). */
  login?: string;
  /** ISO 8601 timestamp the token was obtained. */
  obtainedAt: string;
}

/** Device-code grant returned by GitHub at the start of the flow. */
export interface GitHubDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds until the device code expires. */
  expiresIn: number;
  /** Minimum seconds between polls. */
  interval: number;
}

/** Connection status surfaced to callers (no token material). */
export interface GitHubConnectionStatus {
  connected: boolean;
  login?: string;
  scopes?: string[];
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;
type SleepImpl = (ms: number) => Promise<void>;

export interface LocalGitHubAuthServiceOptions {
  /** OAuth App (device-flow) public client id. Defaults to `GITHUB_OAUTH_CLIENT_ID` at call time. */
  clientId?: string;
  /** Scopes to request. Defaults to `['repo', 'read:org']`. */
  scopes?: string[];
  /** fetch seam (injected in tests). Defaults to global fetch. */
  fetchImpl?: FetchImpl;
  /** sleep seam (injected in tests). Defaults to real setTimeout. */
  sleep?: SleepImpl;
}

const realSleep: SleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LocalGitHubAuthService {
  private readonly store: LocalSecretStore;
  private readonly explicitClientId?: string;
  private readonly scopes: string[];
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: SleepImpl;

  constructor(store: LocalSecretStore, options: LocalGitHubAuthServiceOptions = {}) {
    this.store = store;
    this.explicitClientId = options.clientId;
    this.scopes = options.scopes ?? GITHUB_DEFAULT_SCOPES;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? realSleep;
  }

  /** Resolve the OAuth App client id (explicit option wins, else env at call time). */
  private resolveClientId(): string {
    const clientId = (this.explicitClientId ?? process.env.GITHUB_OAUTH_CLIENT_ID)?.trim();
    if (!clientId) {
      throw new Error(
        '[LocalGitHubAuthService] No GitHub OAuth App client id configured.\n' +
          'Register a GitHub OAuth App with the device flow enabled and set\n' +
          'GITHUB_OAUTH_CLIENT_ID=<client-id> in your local .env.'
      );
    }
    return clientId;
  }

  // ---------------------------------------------------------------------------
  // Persisted token accessors
  // ---------------------------------------------------------------------------

  /** Full persisted record, or undefined if GitHub is not connected. */
  getStored(): StoredGitHubToken | undefined {
    return this.store.getJSON<StoredGitHubToken>(GITHUB_DEVICE_TOKEN_KEY);
  }

  /** The stored access token, or undefined when not connected. */
  getToken(): string | undefined {
    return this.getStored()?.token || undefined;
  }

  /** True when a GitHub token is stored. */
  isConnected(): boolean {
    return !!this.getToken();
  }

  /**
   * Connection status for the "connect GitHub" gate. When no token is stored the
   * caller surfaces a clear "connect GitHub" state (AC3).
   */
  getConnectionStatus(): GitHubConnectionStatus {
    const stored = this.getStored();
    if (!stored?.token) {
      return { connected: false };
    }
    return { connected: true, login: stored.login, scopes: stored.scopes };
  }

  /** Persist a token (encrypted at rest). Used by the device flow and tests. */
  setToken(token: string, scopes: string[] = this.scopes, login?: string): StoredGitHubToken {
    const trimmed = token?.trim();
    if (!trimmed) {
      throw new Error('[LocalGitHubAuthService] Refusing to store an empty GitHub token');
    }
    const record: StoredGitHubToken = {
      token: trimmed,
      scopes,
      login,
      obtainedAt: new Date().toISOString(),
    };
    this.store.setJSON(GITHUB_DEVICE_TOKEN_KEY, record);
    return record;
  }

  /** Remove the stored token ("disconnect GitHub"). */
  clear(): boolean {
    return this.store.delete(GITHUB_DEVICE_TOKEN_KEY);
  }

  // ---------------------------------------------------------------------------
  // Device flow
  // ---------------------------------------------------------------------------

  /** Step 1: request a device + user code from GitHub. */
  async requestDeviceCode(): Promise<GitHubDeviceCode> {
    const clientId = this.resolveClientId();
    const response = await this.fetchImpl(GITHUB_DEVICE_CODE_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, scope: this.scopes.join(' ') }),
    });

    if (!response.ok) {
      throw new Error(
        `[LocalGitHubAuthService] Device-code request failed (HTTP ${response.status})`
      );
    }

    const data = (await response.json()) as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      expires_in?: number;
      interval?: number;
      error?: string;
      error_description?: string;
    };

    if (data.error || !data.device_code || !data.user_code || !data.verification_uri) {
      throw new Error(
        `[LocalGitHubAuthService] Device-code request rejected: ${
          data.error_description || data.error || 'malformed response'
        }`
      );
    }

    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in ?? 900,
      interval: data.interval ?? 5,
    };
  }

  /**
   * Step 2: poll for the access token until the user authorizes (or the code
   * expires / is denied). Honours `authorization_pending` + `slow_down` backoff.
   * Returns the granted token + scopes (does NOT persist — see {@link runDeviceFlow}).
   */
  async pollForAccessToken(
    device: Pick<GitHubDeviceCode, 'deviceCode' | 'interval' | 'expiresIn'>
  ): Promise<{ token: string; scopes: string[] }> {
    const clientId = this.resolveClientId();
    let intervalMs = Math.max(1, device.interval) * 1000;
    const deadline = Date.now() + device.expiresIn * 1000;

    // The first poll waits one interval (the user needs time to enter the code).
    while (Date.now() < deadline) {
      await this.sleep(intervalMs);

      const response = await this.fetchImpl(GITHUB_ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          device_code: device.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });

      const data = (await response.json()) as {
        access_token?: string;
        scope?: string;
        error?: string;
        error_description?: string;
      };

      if (data.access_token) {
        const scopes = data.scope ? data.scope.split(/[, ]+/).filter(Boolean) : this.scopes;
        return { token: data.access_token, scopes };
      }

      switch (data.error) {
        case 'authorization_pending':
          break; // keep polling at the current interval
        case 'slow_down':
          // GitHub asks us to back off by +5s.
          intervalMs += 5000;
          break;
        case 'expired_token':
          throw new Error('[LocalGitHubAuthService] Device code expired before authorization');
        case 'access_denied':
          throw new Error('[LocalGitHubAuthService] GitHub authorization was denied');
        default:
          throw new Error(
            `[LocalGitHubAuthService] Token poll failed: ${
              data.error_description || data.error || 'unknown error'
            }`
          );
      }
    }

    throw new Error('[LocalGitHubAuthService] Timed out waiting for GitHub authorization');
  }

  /** Best-effort fetch of the GitHub login for the freshly granted token. */
  private async fetchLogin(token: string): Promise<string | undefined> {
    try {
      const response = await this.fetchImpl(GITHUB_USER_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'portable-local',
        },
      });
      if (!response.ok) return undefined;
      const data = (await response.json()) as { login?: string };
      return data.login;
    } catch {
      return undefined;
    }
  }

  /**
   * Run the full device flow: request a code, hand it to `onPrompt` (so the
   * launcher can print the user code + verification URL), poll for the token,
   * resolve the login, and persist the result in the local encrypted store.
   */
  async runDeviceFlow(onPrompt?: (device: GitHubDeviceCode) => void): Promise<StoredGitHubToken> {
    const device = await this.requestDeviceCode();
    onPrompt?.(device);
    const { token, scopes } = await this.pollForAccessToken(device);
    const login = await this.fetchLogin(token);
    return this.setToken(token, scopes, login);
  }
}
