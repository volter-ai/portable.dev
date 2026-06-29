import { spawn } from 'child_process';

import {
  CredentialResolver,
  type AnthropicDiscovery,
  type GitHubDiscovery,
  GITHUB_TOKEN_KEY,
} from './CredentialResolver.js';
import { fetchGitHubLogin } from './githubLogin.js';

import type { LocalSecretStore } from '@vgit2/shared/secrets';

/**
 * Interactive credential LOGIN fallback for the launcher — the "ask them to log
 * in" half of "find the keys on the OS, else ask".
 *
 * Runs in the PLAIN terminal, BEFORE the api spawns and BEFORE the Ink pairing
 * screen owns the terminal, and ONLY when {@link CredentialResolver} discovery
 * missed:
 *
 *   ANTHROPIC — if the `claude` binary is on PATH, run `claude setup-token` as a
 *     child with INHERITED stdio so the user completes the Claude subscription
 *     OAuth in the terminal, then RE-DISCOVER (the CLI persists the token to
 *     ~/.claude/.credentials.json / the Keychain, so discovery now finds it and
 *     we copy it into the canonical store key). If `claude` is absent we print
 *     guidance and continue with a LOUD warning — Anthropic is effectively
 *     required for AI but a missing one must NOT brick boot.
 *
 *   GITHUB — OFFER the OAuth device flow (RFC 8628), implemented HERE (we do NOT
 *     cross-import `@vgit2/api`; we reuse the pattern and write the SAME store
 *     key `github-oauth:token`). Needs `GITHUB_OAUTH_CLIENT_ID`; if unset, print
 *     guidance instead. GitHub is SKIPPABLE — the user can connect later from the
 *     app — so the offer is default-NO with a short timeout and never blocks boot.
 *
 * Every external effect (subprocess spawn, HTTP, sleep, stdin, binary detection)
 * is an injected seam so tests drive the flow with fakes.
 */

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_DEFAULT_SCOPES = ['repo', 'read:org'];

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;
type SleepImpl = (ms: number) => Promise<void>;

/** Detect whether a binary is on PATH (resolves false on ENOENT / error). */
export type DetectBinaryImpl = (bin: string) => Promise<boolean>;

/**
 * Run an INTERACTIVE child with inherited stdio (the user types into the same
 * terminal). Resolves the exit code (null on spawn error). Never throws.
 */
export type RunInteractiveImpl = (cmd: string, args: string[]) => Promise<number | null>;

/**
 * Prompt the user a yes/no question on the plain terminal. Resolves the answer.
 * Default impl reads one line of stdin with a timeout (default-NO on timeout).
 */
export type ConfirmImpl = (question: string) => Promise<boolean>;

const realSleep: SleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Default binary-detection seam — `<bin> --version`, false on any failure. */
const realDetectBinary: DetectBinaryImpl = (bin) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(bin, ['--version'], { stdio: 'ignore' });
      child.once('error', () => done(false));
      child.once('exit', (code) => done(code === 0));
    } catch {
      done(false);
    }
  });

/** Default interactive-subprocess seam — inherits stdio so the user can type. */
const realRunInteractive: RunInteractiveImpl = (cmd, args) =>
  new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'inherit' });
      child.once('error', () => resolve(null));
      child.once('exit', (code) => resolve(code ?? null));
    } catch {
      resolve(null);
    }
  });

/**
 * Default yes/no prompt — reads one line of stdin with a short timeout. On
 * timeout or any error it resolves false (default-NO), so a non-interactive
 * terminal never blocks boot.
 */
const realConfirm =
  (timeoutMs: number): ConfirmImpl =>
  (question) =>
    new Promise((resolve) => {
      try {
        process.stdout.write(`${question} [y/N] `);
      } catch {
        resolve(false);
        return;
      }
      let settled = false;
      const finish = (answer: boolean) => {
        if (settled) return;
        settled = true;
        try {
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
        } catch {
          /* ignore */
        }
        resolve(answer);
      };
      const onData = (chunk: Buffer) => {
        const text = chunk.toString().trim().toLowerCase();
        finish(text === 'y' || text === 'yes');
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        process.stdin.resume();
        process.stdin.once('data', onData);
      } catch {
        finish(false);
      }
    });

export interface InteractiveCredentialLoginDeps {
  store: LocalSecretStore;
  /** The discovery resolver (re-run after a Claude login). */
  resolver: CredentialResolver;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Detect the `claude` binary (seam). */
  detectBinary?: DetectBinaryImpl;
  /** Run the interactive Claude login child (seam). */
  runInteractive?: RunInteractiveImpl;
  /** Yes/no prompt seam (GitHub offer). */
  confirm?: ConfirmImpl;
  /** fetch seam for the GitHub device flow. */
  fetchImpl?: FetchImpl;
  /** sleep seam for the GitHub device-flow poll backoff. */
  sleep?: SleepImpl;
  /** GitHub offer prompt timeout (ms). Default 30s. */
  githubOfferTimeoutMs?: number;
}

/** The subcommand the Claude CLI uses to mint a long-lived subscription token. */
export const CLAUDE_LOGIN_ARGS = ['setup-token'];

export class InteractiveCredentialLogin {
  private readonly store: LocalSecretStore;
  private readonly resolver: CredentialResolver;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (line: string) => void;
  private readonly detectBinary: DetectBinaryImpl;
  private readonly runInteractive: RunInteractiveImpl;
  private readonly confirm: ConfirmImpl;
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: SleepImpl;

  constructor(deps: InteractiveCredentialLoginDeps) {
    this.store = deps.store;
    this.resolver = deps.resolver;
    this.env = deps.env ?? process.env;
    this.log = deps.log ?? ((line) => console.log(line));
    this.detectBinary = deps.detectBinary ?? realDetectBinary;
    this.runInteractive = deps.runInteractive ?? realRunInteractive;
    this.confirm = deps.confirm ?? realConfirm(deps.githubOfferTimeoutMs ?? 30_000);
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = deps.sleep ?? realSleep;
  }

  // -------------------------------------------------------------------------
  // ANTHROPIC interactive login
  // -------------------------------------------------------------------------

  /**
   * When Anthropic discovery missed: if `claude` is on PATH, run
   * `claude setup-token` interactively, then RE-DISCOVER + persist. Returns the
   * fresh discovery (found:false when no login happened / it didn't yield a
   * token). Never throws — a failure is a LOUD warning, not a crash.
   */
  async ensureAnthropic(): Promise<AnthropicDiscovery> {
    const hasClaude = await this.detectBinary('claude');
    if (!hasClaude) {
      this.log('[launcher] ⚠ No Anthropic credential found and the `claude` CLI is not installed.');
      this.log('[launcher]   AI features will fail until you configure one:');
      this.log('[launcher]     (a) Install Claude Code (https://claude.com/claude-code) and run');
      this.log('[launcher]         `claude setup-token`, OR');
      this.log(
        '[launcher]     (b) set ANTHROPIC_API_KEY=sk-ant-… in your environment, then restart.'
      );
      return { found: false };
    }

    this.log('[launcher] No Anthropic credential found — launching `claude setup-token`…');
    this.log(
      '[launcher]   Follow the prompts in this terminal to log in to your Claude subscription.'
    );
    const code = await this.runInteractive('claude', CLAUDE_LOGIN_ARGS);
    if (code !== 0) {
      this.log(
        `[launcher] ⚠ \`claude setup-token\` did not complete (exit ${code ?? 'null'}). ` +
          'AI features will fail until you configure an Anthropic credential.'
      );
      return { found: false };
    }

    // Re-discover: the CLI just persisted the token to ~/.claude/.credentials.json
    // / the Keychain, so discovery now finds it. Copy it to the canonical store key.
    const rediscovered = await this.resolver.discoverAnthropic();
    if (rediscovered.found) {
      this.resolver.persistAnthropic(rediscovered);
      this.log(
        `[launcher] ✓ Anthropic credential obtained via Claude login (${rediscovered.source}).`
      );
    } else {
      this.log(
        '[launcher] ⚠ Claude login finished but no credential was found afterwards. ' +
          'AI features may fail; re-run `claude setup-token` or set ANTHROPIC_API_KEY.'
      );
    }
    return rediscovered;
  }

  // -------------------------------------------------------------------------
  // GITHUB interactive login (device flow — implemented locally)
  // -------------------------------------------------------------------------

  /**
   * When GitHub discovery missed: OFFER the device flow. SKIPPABLE — default-NO
   * with a short timeout — so it never blocks boot. If the user declines (or the
   * prompt times out / `GITHUB_OAUTH_CLIENT_ID` is unset) we print guidance and
   * return found:false. On accept we run the device flow and persist the token to
   * the canonical `github-oauth:token` store key. Never throws.
   */
  async ensureGitHub(): Promise<GitHubDiscovery> {
    const clientId = this.env.GITHUB_OAUTH_CLIENT_ID?.trim();
    if (!clientId) {
      this.log('[launcher] ⚠ GitHub not connected. To link it now, set GITHUB_OAUTH_CLIENT_ID and');
      this.log(
        '[launcher]   restart — or just connect GitHub later from the Portable app (it is optional).'
      );
      return { found: false };
    }

    const wantsLogin = await this.confirm('[launcher] Connect GitHub now via the device flow?');
    if (!wantsLogin) {
      this.log('[launcher] Skipping GitHub — you can connect it later from the Portable app.');
      return { found: false };
    }

    try {
      const token = await this.runGitHubDeviceFlow(clientId);
      if (!token) {
        this.log(
          '[launcher] ⚠ GitHub device flow did not complete. Connect it later from the app.'
        );
        return { found: false };
      }
      // Best-effort resolve the GitHub login so the stored record carries `.login`
      // (the launcher's JWT-username fallback + the api's commit-time resolver read
      // it to author commits as the GitHub user). A failed fetch → undefined.
      const login = await fetchGitHubLogin(token, this.fetchImpl);
      this.persistGitHubToken(token, login);
      this.log('[launcher] ✓ GitHub connected via the device flow.');
      return { found: true, source: 'device-flow', value: token };
    } catch (err) {
      this.log(
        `[launcher] ⚠ GitHub device flow failed: ${err instanceof Error ? err.message : String(err)}. ` +
          'Connect it later from the app.'
      );
      return { found: false };
    }
  }

  /**
   * Persist the device-flow token into the SAME store key the api reads. Mirrors
   * `LocalGitHubAuthService.setToken`'s record shape `{ token, scopes, login?,
   * obtainedAt }` — `login` is omitted when undefined (a failed /user fetch).
   */
  private persistGitHubToken(token: string, login?: string): void {
    this.store.setJSON(GITHUB_TOKEN_KEY, {
      token,
      scopes: GITHUB_DEFAULT_SCOPES,
      ...(login ? { login } : {}),
      obtainedAt: new Date().toISOString(),
    });
  }

  /**
   * Run the GitHub OAuth device flow (RFC 8628) — modeled on
   * `LocalGitHubAuthService` but self-contained (no `@vgit2/api` import). Requests
   * a device + user code, prints "open github.com/login/device, enter CODE",
   * polls for the access token honouring authorization_pending / slow_down, and
   * returns the granted token (does NOT persist — see {@link ensureGitHub}).
   */
  async runGitHubDeviceFlow(clientId: string): Promise<string | undefined> {
    const device = await this.requestDeviceCode(clientId);
    this.log('[launcher] To connect GitHub:');
    this.log(`[launcher]   1. open ${device.verificationUri}`);
    this.log(`[launcher]   2. enter the code: ${device.userCode}`);
    return this.pollForAccessToken(clientId, device);
  }

  private async requestDeviceCode(clientId: string): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  }> {
    const response = await this.fetchImpl(GITHUB_DEVICE_CODE_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, scope: GITHUB_DEFAULT_SCOPES.join(' ') }),
    });
    if (!response.ok) {
      throw new Error(`device-code request failed (HTTP ${response.status})`);
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
        `device-code request rejected: ${data.error_description || data.error || 'malformed response'}`
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

  private async pollForAccessToken(
    clientId: string,
    device: { deviceCode: string; interval: number; expiresIn: number }
  ): Promise<string | undefined> {
    let intervalMs = Math.max(1, device.interval) * 1000;
    const deadline = Date.now() + device.expiresIn * 1000;

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
        error?: string;
        error_description?: string;
      };

      if (data.access_token) {
        return data.access_token;
      }
      switch (data.error) {
        case 'authorization_pending':
          break;
        case 'slow_down':
          intervalMs += 5000;
          break;
        case 'expired_token':
          throw new Error('device code expired before authorization');
        case 'access_denied':
          throw new Error('GitHub authorization was denied');
        default:
          throw new Error(
            `token poll failed: ${data.error_description || data.error || 'unknown error'}`
          );
      }
    }
    throw new Error('timed out waiting for GitHub authorization');
  }
}
