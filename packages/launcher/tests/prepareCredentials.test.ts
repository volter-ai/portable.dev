/**
 * prepareCredentials orchestration tests.
 *
 * Discover → persist → (if missing) interactive login, for BOTH Anthropic and
 * GitHub. Drives the real resolver/login via injected seams (fs/cli/fetch/confirm)
 * so the full discover-then-login path is exercised end-to-end without real OS/network.
 */
import { describe, expect, it } from 'bun:test';
import path from 'path';

import { CLAUDE_OAUTH_TOKEN_KEY, GITHUB_TOKEN_KEY } from '../src/CredentialResolver.js';
import { prepareCredentials } from '../src/prepareCredentials.js';

function makeStore(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  const store = {
    get: (k: string) => map.get(k),
    set: (k: string, v: string) => {
      map.set(k, v);
    },
    has: (k: string) => map.has(k),
    delete: (k: string) => map.delete(k),
    setJSON: (k: string, v: unknown) => {
      map.set(k, JSON.stringify(v));
    },
    getJSON: <T>(k: string): T | undefined => {
      const raw = map.get(k);
      return raw === undefined ? undefined : (JSON.parse(raw) as T);
    },
    // prepareCredentials passes the store straight through to the real
    // CredentialResolver / InteractiveCredentialLogin.
  } as never;
  return { store, map };
}

describe('prepareCredentials', () => {
  it('discovers both creds on the OS and persists them — no interactive login', async () => {
    const { store, map } = makeStore();
    const lines: string[] = [];
    let interactiveRan = false;

    const result = await prepareCredentials({
      store,
      env: {} as NodeJS.ProcessEnv,
      log: (l) => lines.push(l),
      resolverDeps: {
        platform: () => 'linux',
        homedir: () => '/home/tester',
        readFile: (p) =>
          p.endsWith(path.join('.claude', '.credentials.json'))
            ? JSON.stringify({ claudeAiOauth: { accessToken: 'disk-oauth' } })
            : undefined,
        runCommand: async (cmd, args) =>
          cmd === 'gh' && args.join(' ') === 'auth token' ? 'gho_disk' : undefined,
        // Seam the /user lookup so persistGitHub never hits the real network and we
        // can assert the discovered token's login is persisted too.
        fetchImpl: async () =>
          ({ ok: true, json: async () => ({ login: 'octocat' }) }) as unknown as Response,
      },
      loginDeps: {
        detectBinary: async () => {
          interactiveRan = true;
          return false;
        },
      },
    });

    expect(result).toMatchObject({
      anthropicConfigured: true,
      anthropicSource: 'claude-credentials-file',
      githubConfigured: true,
      githubSource: 'gh-cli',
    });
    // Persisted into the canonical store keys the api reads.
    expect(map.get(CLAUDE_OAUTH_TOKEN_KEY)).toBe('disk-oauth');
    expect(JSON.parse(map.get(GITHUB_TOKEN_KEY)!).token).toBe('gho_disk');
    // The discovered token's GitHub login is persisted (drives the JWT username).
    expect(JSON.parse(map.get(GITHUB_TOKEN_KEY)!).login).toBe('octocat');
    // Discovery hit means the interactive fallback was never reached.
    expect(interactiveRan).toBe(false);
    expect(
      lines.some((l) =>
        l.includes('Anthropic credential ready (found via claude-credentials-file)')
      )
    ).toBe(true);
    expect(lines.some((l) => l.includes('GitHub access ready (found via gh-cli)'))).toBe(true);
  });

  it('falls back to the interactive login when discovery misses', async () => {
    const { store, map } = makeStore();
    let claudeLoginRan = false;
    let githubOffered = false;
    let loggedIn = false;

    const result = await prepareCredentials({
      store,
      env: { GITHUB_OAUTH_CLIENT_ID: 'Iv1.client' } as NodeJS.ProcessEnv,
      log: () => {},
      resolverDeps: {
        platform: () => 'linux',
        homedir: () => '/home/tester',
        readFile: (p) =>
          loggedIn && p.endsWith(path.join('.claude', '.credentials.json'))
            ? JSON.stringify({ claudeAiOauth: { accessToken: 'after-login' } })
            : undefined,
        runCommand: async () => undefined,
      },
      loginDeps: {
        detectBinary: async (bin) => bin === 'claude',
        runInteractive: async () => {
          claudeLoginRan = true;
          loggedIn = true;
          return 0;
        },
        // Decline GitHub (skippable) so no device-flow network is needed.
        confirm: async () => {
          githubOffered = true;
          return false;
        },
        sleep: async () => {},
      },
    });

    expect(claudeLoginRan).toBe(true);
    expect(githubOffered).toBe(true);
    expect(result.anthropicConfigured).toBe(true);
    expect(map.get(CLAUDE_OAUTH_TOKEN_KEY)).toBe('after-login');
    // GitHub declined → not configured, but boot is not blocked.
    expect(result.githubConfigured).toBe(false);
  });

  it('skipInteractive=true never runs the login fallback (CI-safe)', async () => {
    const { store } = makeStore();
    let interactiveTouched = false;

    const result = await prepareCredentials({
      store,
      env: {} as NodeJS.ProcessEnv,
      log: () => {},
      skipInteractive: true,
      resolverDeps: {
        platform: () => 'linux',
        homedir: () => '/home/tester',
        readFile: () => undefined,
        runCommand: async () => undefined,
      },
      loginDeps: {
        detectBinary: async () => {
          interactiveTouched = true;
          return true;
        },
        confirm: async () => {
          interactiveTouched = true;
          return true;
        },
      },
    });

    expect(result).toMatchObject({ anthropicConfigured: false, githubConfigured: false });
    expect(interactiveTouched).toBe(false);
  });
});
