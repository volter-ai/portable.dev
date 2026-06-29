import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { fetchGitHubLogin, type FetchImpl } from './githubLogin.js';
import { CLAUDE_OAUTH_TOKEN_KEY, GITHUB_TOKEN_KEY } from './LocalCredentialGuidance.js';

import type { LocalSecretStore } from '@vgit2/shared/secrets';

/**
 * OS-credential DISCOVERY for the launcher.
 *
 * "Try to find the keys already on the user's OS and use them; if not found, ask
 * them to log in." This module is the FIND half — a pure, seam-injected resolver
 * that walks a priority ladder of well-known credential locations for BOTH the
 * Anthropic (Claude) credential and the GitHub token, and — when a hit comes from
 * a source OTHER than the canonical `LocalSecretStore` key the api reads — copies
 * it INTO that canonical key so the spawned api
 * (`LocalAiCredentialsService` / `LocalGitHubAuthService`) resolves it unchanged.
 *
 * Canonical store keys (mirrored EXACTLY from the api resolvers):
 *   - `ai-credentials:claude-oauth-token`  (LocalAiCredentialsService)
 *   - `github-oauth:token`                 (LocalGitHubAuthService, JSON record)
 *
 * Every side effect is INJECTED so tests pass fakes — no real fs, no real CLI
 * spawn, no real macOS Keychain read. Nothing here throws on a missing source: a
 * read that fails / a file that's absent / a CLI that errors just falls through
 * to the next rung of the ladder.
 *
 * The interactive LOGIN half (when the whole ladder misses) lives in
 * {@link ./InteractiveCredentialLogin}; this module is the discovery it re-runs
 * after a successful login.
 */

// Canonical LocalSecretStore keys the api reads (single source of truth) — both
// imported (for the discovery ladder below) and re-exported (the public surface).

export { CLAUDE_OAUTH_TOKEN_KEY, GITHUB_TOKEN_KEY } from './LocalCredentialGuidance.js';

/** Where the Claude Code CLI persists its OAuth credentials on disk (POSIX). */
export const CLAUDE_CREDENTIALS_PATH = '.claude/.credentials.json';
/** macOS Keychain generic-password service the Claude Code CLI stores its token under. */
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
/** Where the GitHub CLI persists its hosts config. */
export const GH_HOSTS_PATH = '.config/gh/hosts.yml';

/** Which discovery rung produced an Anthropic credential. */
export type AnthropicSource =
  | 'ANTHROPIC_API_KEY'
  | 'CLAUDE_CODE_OAUTH_TOKEN'
  | 'store'
  | 'claude-credentials-file'
  | 'macos-keychain';

/** Which discovery rung produced a GitHub token. */
export type GitHubSource =
  | 'GITHUB_TOKEN'
  | 'GH_TOKEN'
  | 'store'
  | 'gh-cli'
  | 'gh-hosts-file'
  | 'git-credential'
  | 'device-flow';

/** The kind of Anthropic credential found (mirrors LocalAiCredentialsService modes). */
export type AnthropicKind = 'api-key' | 'claude-oauth';

export interface AnthropicDiscovery {
  found: boolean;
  source?: AnthropicSource;
  kind?: AnthropicKind;
  /** The raw credential value (kept in-memory only; never logged). */
  value?: string;
}

export interface GitHubDiscovery {
  found: boolean;
  source?: GitHubSource;
  /** The raw token value (kept in-memory only; never logged). */
  value?: string;
}

// ---------------------------------------------------------------------------
// Injected seams (default real impls; tests pass fakes)
// ---------------------------------------------------------------------------

/** Read a UTF-8 file, or return `undefined` if it can't be read (absent/denied). */
export type ReadFileImpl = (filePath: string) => string | undefined;

/**
 * Run a CLI command and return its trimmed stdout, or `undefined` on ANY failure
 * (binary absent, non-zero exit, timeout). Never throws.
 */
export type RunCommandImpl = (cmd: string, args: string[]) => Promise<string | undefined>;

/** Resolve the current platform (so tests can force darwin / linux). */
export type PlatformImpl = () => NodeJS.Platform;

/** Resolve the user's home dir (so tests can pin a temp dir). */
export type HomedirImpl = () => string;

export interface CredentialResolverDeps {
  store: LocalSecretStore;
  env?: NodeJS.ProcessEnv;
  readFile?: ReadFileImpl;
  runCommand?: RunCommandImpl;
  platform?: PlatformImpl;
  homedir?: HomedirImpl;
  /**
   * fetch seam used by {@link CredentialResolver.persistGitHub} to best-effort
   * resolve the GitHub login (`.login`) for a discovered token. Injected in
   * tests so no real network is hit. Defaults to global fetch.
   */
  fetchImpl?: FetchImpl;
}

/** Default fs read seam — returns undefined instead of throwing on a missing file. */
const realReadFile: ReadFileImpl = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * Default CLI seam — spawns the binary with a short timeout and resolves the
 * trimmed stdout on a clean (code 0) exit, else `undefined`. Never throws.
 */
const realRunCommand: RunCommandImpl = (cmd, args) =>
  new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 10_000, windowsHide: true }, (err, stdout) => {
        if (err) {
          resolve(undefined);
          return;
        }
        const trimmed = (stdout ?? '').toString().trim();
        resolve(trimmed.length > 0 ? trimmed : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });

export class CredentialResolver {
  private readonly store: LocalSecretStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly readFile: ReadFileImpl;
  private readonly runCommand: RunCommandImpl;
  private readonly platform: PlatformImpl;
  private readonly homedir: HomedirImpl;
  private readonly fetchImpl: FetchImpl;

  constructor(deps: CredentialResolverDeps) {
    this.store = deps.store;
    this.env = deps.env ?? process.env;
    this.readFile = deps.readFile ?? realReadFile;
    this.runCommand = deps.runCommand ?? realRunCommand;
    this.platform = deps.platform ?? (() => process.platform);
    this.homedir = deps.homedir ?? (() => os.homedir());
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /**
   * `store.get` that never throws — a corrupt / tampered LocalSecretStore envelope
   * can throw in decryptValue(); discovery must fall through, not crash boot.
   */
  private safeGet(key: string): string | undefined {
    try {
      const value = this.store.get(key)?.trim();
      return value && value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // ANTHROPIC discovery ladder
  // -------------------------------------------------------------------------

  /**
   * Discover an Anthropic credential, IN PRIORITY ORDER. Returns the first hit
   * with its source + kind, or `{ found: false }`. Never throws.
   *
   *   (1) `ANTHROPIC_API_KEY` env             → kind 'api-key'
   *   (2) `CLAUDE_CODE_OAUTH_TOKEN` env       → kind 'claude-oauth'
   *   (3) store `ai-credentials:claude-oauth-token` → kind 'claude-oauth'
   *   (4) ~/.claude/.credentials.json         → kind 'claude-oauth'
   *   (5) macOS Keychain (darwin only)        → kind 'claude-oauth'
   *
   * NB the api (LocalAiCredentialsService) PREFERS a stored claude-oauth token
   * over ANTHROPIC_API_KEY. This first-hit report is INFORMATIONAL — when BOTH an
   * api-key env and an OAuth token exist it may name 'ANTHROPIC_API_KEY' while the
   * api actually resolves the OAuth token (already in the canonical store key), so
   * the credential still works; only the reported source differs.
   */
  async discoverAnthropic(): Promise<AnthropicDiscovery> {
    const apiKeyEnv = this.env.ANTHROPIC_API_KEY?.trim();
    if (apiKeyEnv) {
      return { found: true, source: 'ANTHROPIC_API_KEY', kind: 'api-key', value: apiKeyEnv };
    }

    const oauthEnv = this.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (oauthEnv) {
      return {
        found: true,
        source: 'CLAUDE_CODE_OAUTH_TOKEN',
        kind: 'claude-oauth',
        value: oauthEnv,
      };
    }

    const fromStore = this.safeGet(CLAUDE_OAUTH_TOKEN_KEY);
    if (fromStore) {
      return { found: true, source: 'store', kind: 'claude-oauth', value: fromStore };
    }

    const fromFile = this.readClaudeCredentialsFile();
    if (fromFile) {
      return {
        found: true,
        source: 'claude-credentials-file',
        kind: 'claude-oauth',
        value: fromFile,
      };
    }

    const fromKeychain = await this.readClaudeKeychainToken();
    if (fromKeychain) {
      return { found: true, source: 'macos-keychain', kind: 'claude-oauth', value: fromKeychain };
    }

    return { found: false };
  }

  /**
   * Parse the Claude Code OAuth access token out of `~/.claude/.credentials.json`.
   * The Claude Code CLI persists `{ claudeAiOauth: { accessToken, ... } }`; we
   * pull `claudeAiOauth.accessToken`. Returns undefined on absent / malformed.
   */
  private readClaudeCredentialsFile(): string | undefined {
    const filePath = path.join(this.homedir(), CLAUDE_CREDENTIALS_PATH);
    const raw = this.readFile(filePath);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as {
        claudeAiOauth?: { accessToken?: string };
      };
      const token = parsed?.claudeAiOauth?.accessToken?.trim();
      return token && token.length > 0 ? token : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * macOS Keychain rung (darwin ONLY — guarded). Reads the Claude Code CLI's
   * generic-password entry via `security find-generic-password -s
   * "Claude Code-credentials" -w`. The `-w` flag prints just the password
   * (the JSON blob), which we parse the same way as the on-disk file.
   */
  private async readClaudeKeychainToken(): Promise<string | undefined> {
    if (this.platform() !== 'darwin') return undefined;
    const out = await this.runCommand('security', [
      'find-generic-password',
      '-s',
      CLAUDE_KEYCHAIN_SERVICE,
      '-w',
    ]);
    if (!out) return undefined;
    // The keychain entry holds the same JSON the on-disk file holds.
    try {
      const parsed = JSON.parse(out) as { claudeAiOauth?: { accessToken?: string } };
      const token = parsed?.claudeAiOauth?.accessToken?.trim();
      if (token) return token;
    } catch {
      // Some installs store the raw token (not JSON) — accept a non-empty line.
    }
    const trimmed = out.trim();
    return trimmed.length > 0 && !trimmed.startsWith('{') ? trimmed : undefined;
  }

  // -------------------------------------------------------------------------
  // GITHUB discovery ladder
  // -------------------------------------------------------------------------

  /**
   * Discover a GitHub token, IN PRIORITY ORDER. Returns the first hit with its
   * source, or `{ found: false }`. Never throws.
   *
   *   (1) `GITHUB_TOKEN` / `GH_TOKEN` env
   *   (2) store `github-oauth:token` (JSON record → .token)
   *   (3) `gh auth token`  (only if `gh` is on PATH and authed)
   *   (4) ~/.config/gh/hosts.yml  (github.com.oauth_token)
   *   (5) git credential helper  (`git credential fill` for github.com)
   */
  async discoverGitHub(): Promise<GitHubDiscovery> {
    const githubTokenEnv = this.env.GITHUB_TOKEN?.trim();
    if (githubTokenEnv) {
      return { found: true, source: 'GITHUB_TOKEN', value: githubTokenEnv };
    }

    const ghTokenEnv = this.env.GH_TOKEN?.trim();
    if (ghTokenEnv) {
      return { found: true, source: 'GH_TOKEN', value: ghTokenEnv };
    }

    const fromStore = this.readGitHubTokenFromStore();
    if (fromStore) {
      return { found: true, source: 'store', value: fromStore };
    }

    const fromGhCli = await this.readGhCliToken();
    if (fromGhCli) {
      return { found: true, source: 'gh-cli', value: fromGhCli };
    }

    const fromHosts = this.readGhHostsToken();
    if (fromHosts) {
      return { found: true, source: 'gh-hosts-file', value: fromHosts };
    }

    const fromGitCredential = await this.readGitCredentialToken();
    if (fromGitCredential) {
      return { found: true, source: 'git-credential', value: fromGitCredential };
    }

    return { found: false };
  }

  /** Read `.token` out of the api's JSON record at `github-oauth:token`. */
  private readGitHubTokenFromStore(): string | undefined {
    try {
      const record = this.store.getJSON<{ token?: string }>(GITHUB_TOKEN_KEY);
      const token = record?.token?.trim();
      return token && token.length > 0 ? token : undefined;
    } catch {
      return undefined;
    }
  }

  /** `gh auth token` — prints the active GitHub token (only when gh is authed). */
  private async readGhCliToken(): Promise<string | undefined> {
    const out = await this.runCommand('gh', ['auth', 'token']);
    const trimmed = out?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  }

  /**
   * Parse `github.com.oauth_token` out of `~/.config/gh/hosts.yml`. gh stores the
   * token in the OS keyring by default (then `gh auth token` is the path that
   * works), but a `--insecure-storage` login writes `oauth_token:` into the yml.
   * We do a minimal line scan (no YAML dep): find the `github.com:` block and the
   * first `oauth_token:` under it.
   */
  private readGhHostsToken(): string | undefined {
    const filePath = path.join(this.homedir(), GH_HOSTS_PATH);
    const raw = this.readFile(filePath);
    if (!raw) return undefined;
    const lines = raw.split(/\r?\n/);
    let inGithubBlock = false;
    for (const line of lines) {
      // A new top-level host block (no leading whitespace, ends with ':').
      if (/^\S.*:\s*$/.test(line)) {
        inGithubBlock = /^github\.com:\s*$/.test(line);
        continue;
      }
      if (!inGithubBlock) continue;
      const match = line.match(/^\s*oauth_token:\s*(.+?)\s*$/);
      if (match) {
        const token = match[1].replace(/^["']|["']$/g, '').trim();
        if (token.length > 0) return token;
      }
    }
    return undefined;
  }

  /**
   * Last rung: ask the configured git credential helper for github.com via
   * `git credential fill`. We feed it the standard stdin protocol and parse the
   * `password=` line out of stdout. Done via {@link runCommand} with the request
   * passed as argv-encoded stdin is not possible, so we use a dedicated seam:
   * the default impl pipes stdin through a shell. Tests inject runCommand.
   */
  private async readGitCredentialToken(): Promise<string | undefined> {
    // We model `git credential fill` as a runCommand whose stdout is the filled
    // credential block. The default seam can't pipe stdin, so the real impl uses
    // a here-string via `sh -c`. Kept last because it's the least reliable rung.
    const out = await this.runCommand('sh', [
      '-c',
      'printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill 2>/dev/null',
    ]);
    if (!out) return undefined;
    for (const line of out.split(/\r?\n/)) {
      const match = line.match(/^password=(.+)$/);
      if (match) {
        const token = match[1].trim();
        if (token.length > 0) return token;
      }
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Persist discovered creds into the canonical store keys the api reads
  // -------------------------------------------------------------------------

  /**
   * Persist a discovered Anthropic credential so the spawned api resolves it.
   *
   * - A `claude-oauth` credential is written to the store key
   *   `ai-credentials:claude-oauth-token` (idempotent — skipped if already
   *   equal). `LocalAiCredentialsService.getClaudeOAuthToken()` reads it.
   * - An `api-key` credential is left in `ANTHROPIC_API_KEY` (env). The launcher
   *   already forwards the full env to the api child, so the api's
   *   `resolveCredential()` ANTHROPIC_API_KEY fallback picks it up — no store
   *   write needed (it's already in the env it was discovered from).
   *
   * Returns true if it wrote to the store.
   */
  persistAnthropic(discovery: AnthropicDiscovery): boolean {
    if (!discovery.found || !discovery.value) return false;
    if (discovery.kind !== 'claude-oauth') return false;
    // Idempotent: don't rewrite an identical value (and the 'store' source IS
    // the canonical key already).
    const existing = this.safeGet(CLAUDE_OAUTH_TOKEN_KEY);
    if (existing === discovery.value) return false;
    try {
      this.store.set(CLAUDE_OAUTH_TOKEN_KEY, discovery.value);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Persist a discovered GitHub token into the canonical `github-oauth:token`
   * JSON record the api reads (`LocalGitHubAuthService.getStored()`). Idempotent
   * — skips when the stored record already holds the same token. The `store`
   * source is already canonical, so it's a no-op for it. Returns true if it wrote.
   *
   * Best-effort resolves the GitHub login (`.login`) for the token before writing
   * so the record mirrors `LocalGitHubAuthService.setToken`'s shape `{ token,
   * scopes, login?, obtainedAt }` — the launcher's JWT-username fallback +
   * the api's commit-time resolver read it to author commits as the GitHub user.
   * A failed /user fetch → no `login` (never throws). Async for the fetch.
   */
  async persistGitHub(discovery: GitHubDiscovery): Promise<boolean> {
    if (!discovery.found || !discovery.value) return false;
    const existing = this.readGitHubTokenFromStore();
    if (existing === discovery.value) return false;
    const login = await fetchGitHubLogin(discovery.value, this.fetchImpl);
    const record = {
      token: discovery.value,
      // Mirror LocalGitHubAuthService.GITHUB_DEFAULT_SCOPES; the real scopes are
      // unknown for a discovered token, so claim the defaults the api requests.
      scopes: ['repo', 'read:org'],
      ...(login ? { login } : {}),
      obtainedAt: new Date().toISOString(),
    };
    try {
      this.store.setJSON(GITHUB_TOKEN_KEY, record);
      return true;
    } catch {
      return false;
    }
  }
}
