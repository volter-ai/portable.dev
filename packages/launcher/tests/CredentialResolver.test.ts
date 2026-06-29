/**
 * CredentialResolver tests.
 *
 * "Find the keys already on the user's OS and use them." Exercises the discovery
 * priority ladder for BOTH Anthropic and GitHub (each rung hit via injected fake
 * reads — no real fs / CLI / Keychain), the macOS-only Keychain guard, and the
 * persist-to-canonical-store behavior the api relies on.
 */
import { describe, expect, it } from 'bun:test';
import path from 'path';

import {
  CredentialResolver,
  CLAUDE_OAUTH_TOKEN_KEY,
  GITHUB_TOKEN_KEY,
  type CredentialResolverDeps,
} from '../src/CredentialResolver.js';

/** A fake LocalSecretStore (only the methods the resolver touches). */
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
  } as unknown as CredentialResolverDeps['store'];
  return { store, map };
}

const HOME = '/home/tester';

function makeResolver(
  overrides: Partial<CredentialResolverDeps> = {},
  seed: Record<string, string> = {}
) {
  const { store, map } = makeStore(seed);
  const resolver = new CredentialResolver({
    store,
    env: {} as NodeJS.ProcessEnv,
    readFile: () => undefined,
    runCommand: async () => undefined,
    platform: () => 'linux',
    homedir: () => HOME,
    // Default no-op fetch seam so persistGitHub's best-effort login lookup never
    // hits the real network (overridden per-test to assert .login persistence).
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }) as unknown as Response,
    ...overrides,
  });
  return { resolver, store, map };
}

// ---------------------------------------------------------------------------
// ANTHROPIC discovery ladder
// ---------------------------------------------------------------------------

describe('CredentialResolver.discoverAnthropic — priority ladder', () => {
  it('(1) ANTHROPIC_API_KEY env wins, kind api-key', async () => {
    const { resolver } = makeResolver({
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-xxx',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      } as NodeJS.ProcessEnv,
    });
    const d = await resolver.discoverAnthropic();
    expect(d).toEqual({
      found: true,
      source: 'ANTHROPIC_API_KEY',
      kind: 'api-key',
      value: 'sk-ant-xxx',
    });
  });

  it('(2) CLAUDE_CODE_OAUTH_TOKEN env, kind claude-oauth', async () => {
    const { resolver } = makeResolver({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-env' } as NodeJS.ProcessEnv,
    });
    const d = await resolver.discoverAnthropic();
    expect(d).toMatchObject({
      found: true,
      source: 'CLAUDE_CODE_OAUTH_TOKEN',
      kind: 'claude-oauth',
      value: 'oauth-env',
    });
  });

  it('(3) store ai-credentials:claude-oauth-token', async () => {
    const { resolver } = makeResolver({}, { [CLAUDE_OAUTH_TOKEN_KEY]: 'stored-oauth' });
    const d = await resolver.discoverAnthropic();
    expect(d).toMatchObject({
      found: true,
      source: 'store',
      kind: 'claude-oauth',
      value: 'stored-oauth',
    });
  });

  it('(4) ~/.claude/.credentials.json — parses claudeAiOauth.accessToken', async () => {
    const { resolver } = makeResolver({
      readFile: (p) =>
        p === path.join(HOME, '.claude', '.credentials.json')
          ? JSON.stringify({ claudeAiOauth: { accessToken: 'file-tok', refreshToken: 'r' } })
          : undefined,
    });
    const d = await resolver.discoverAnthropic();
    expect(d).toMatchObject({
      found: true,
      source: 'claude-credentials-file',
      kind: 'claude-oauth',
      value: 'file-tok',
    });
  });

  it('(5) macOS Keychain — only on darwin, parses the JSON blob', async () => {
    const { resolver } = makeResolver({
      platform: () => 'darwin',
      runCommand: async (cmd, args) =>
        cmd === 'security' && args.includes('Claude Code-credentials')
          ? JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-tok' } })
          : undefined,
    });
    const d = await resolver.discoverAnthropic();
    expect(d).toMatchObject({
      found: true,
      source: 'macos-keychain',
      kind: 'claude-oauth',
      value: 'keychain-tok',
    });
  });

  it('does NOT touch the Keychain on non-darwin (the macOS guard)', async () => {
    let securityCalled = false;
    const { resolver } = makeResolver({
      platform: () => 'linux',
      runCommand: async (cmd) => {
        if (cmd === 'security') securityCalled = true;
        return undefined;
      },
    });
    const d = await resolver.discoverAnthropic();
    expect(d.found).toBe(false);
    expect(securityCalled).toBe(false);
  });

  it('falls through every rung to found:false when nothing is present', async () => {
    const { resolver } = makeResolver();
    expect(await resolver.discoverAnthropic()).toEqual({ found: false });
  });

  it('never throws on malformed ~/.claude/.credentials.json', async () => {
    const { resolver } = makeResolver({
      readFile: () => 'not-json{{{',
    });
    expect(await resolver.discoverAnthropic()).toEqual({ found: false });
  });
});

// ---------------------------------------------------------------------------
// GITHUB discovery ladder
// ---------------------------------------------------------------------------

describe('CredentialResolver.discoverGitHub — priority ladder', () => {
  it('(1) GITHUB_TOKEN env wins', async () => {
    const { resolver } = makeResolver({ env: { GITHUB_TOKEN: 'ghp_env' } as NodeJS.ProcessEnv });
    expect(await resolver.discoverGitHub()).toEqual({
      found: true,
      source: 'GITHUB_TOKEN',
      value: 'ghp_env',
    });
  });

  it('(1b) GH_TOKEN env', async () => {
    const { resolver } = makeResolver({ env: { GH_TOKEN: 'gho_env' } as NodeJS.ProcessEnv });
    expect(await resolver.discoverGitHub()).toEqual({
      found: true,
      source: 'GH_TOKEN',
      value: 'gho_env',
    });
  });

  it('(2) store github-oauth:token JSON record → .token', async () => {
    const { resolver } = makeResolver(
      {},
      { [GITHUB_TOKEN_KEY]: JSON.stringify({ token: 'stored-gh', scopes: [] }) }
    );
    expect(await resolver.discoverGitHub()).toMatchObject({
      found: true,
      source: 'store',
      value: 'stored-gh',
    });
  });

  it('(3) gh auth token — when gh is on PATH and authed', async () => {
    const { resolver } = makeResolver({
      runCommand: async (cmd, args) =>
        cmd === 'gh' && args.join(' ') === 'auth token' ? 'gho_fromcli\n' : undefined,
    });
    expect(await resolver.discoverGitHub()).toMatchObject({
      found: true,
      source: 'gh-cli',
      value: 'gho_fromcli',
    });
  });

  it('(4) ~/.config/gh/hosts.yml — parses github.com.oauth_token', async () => {
    const yml = [
      'github.com:',
      '    git_protocol: https',
      '    oauth_token: gho_hostsfile',
      '    user: octocat',
      'enterprise.example.com:',
      '    oauth_token: should-not-match',
    ].join('\n');
    const { resolver } = makeResolver({
      readFile: (p) => (p === path.join(HOME, '.config', 'gh', 'hosts.yml') ? yml : undefined),
    });
    expect(await resolver.discoverGitHub()).toMatchObject({
      found: true,
      source: 'gh-hosts-file',
      value: 'gho_hostsfile',
    });
  });

  it('(5) git credential helper — parses password= line', async () => {
    const { resolver } = makeResolver({
      runCommand: async (cmd) =>
        cmd === 'sh'
          ? 'protocol=https\nhost=github.com\nusername=x\npassword=gho_gitcred\n'
          : undefined,
    });
    expect(await resolver.discoverGitHub()).toMatchObject({
      found: true,
      source: 'git-credential',
      value: 'gho_gitcred',
    });
  });

  it('falls through every rung to found:false when nothing is present', async () => {
    const { resolver } = makeResolver();
    expect(await resolver.discoverGitHub()).toEqual({ found: false });
  });

  it('does not match oauth_token outside the github.com block', async () => {
    const yml = ['enterprise.example.com:', '    oauth_token: ent-token'].join('\n');
    const { resolver } = makeResolver({
      readFile: () => yml,
    });
    expect(await resolver.discoverGitHub()).toEqual({ found: false });
  });
});

// ---------------------------------------------------------------------------
// Persist to canonical store keys
// ---------------------------------------------------------------------------

describe('CredentialResolver.persistAnthropic', () => {
  it('writes a claude-oauth value into the canonical store key', () => {
    const { resolver, map } = makeResolver();
    const wrote = resolver.persistAnthropic({
      found: true,
      kind: 'claude-oauth',
      source: 'claude-credentials-file',
      value: 'tok',
    });
    expect(wrote).toBe(true);
    expect(map.get(CLAUDE_OAUTH_TOKEN_KEY)).toBe('tok');
  });

  it('does NOT write an api-key (it stays in env for the api child)', () => {
    const { resolver, map } = makeResolver();
    const wrote = resolver.persistAnthropic({
      found: true,
      kind: 'api-key',
      source: 'ANTHROPIC_API_KEY',
      value: 'sk-ant',
    });
    expect(wrote).toBe(false);
    expect(map.has(CLAUDE_OAUTH_TOKEN_KEY)).toBe(false);
  });

  it('is idempotent — skips an identical stored value', () => {
    const { resolver } = makeResolver({}, { [CLAUDE_OAUTH_TOKEN_KEY]: 'same' });
    expect(
      resolver.persistAnthropic({
        found: true,
        kind: 'claude-oauth',
        source: 'store',
        value: 'same',
      })
    ).toBe(false);
  });
});

describe('CredentialResolver.persistGitHub', () => {
  it('writes the token into the canonical github-oauth:token JSON record', async () => {
    const { resolver, map } = makeResolver();
    const wrote = await resolver.persistGitHub({ found: true, source: 'gh-cli', value: 'gho_x' });
    expect(wrote).toBe(true);
    const record = JSON.parse(map.get(GITHUB_TOKEN_KEY)!) as { token: string; scopes: string[] };
    expect(record.token).toBe('gho_x');
    expect(record.scopes).toEqual(['repo', 'read:org']);
  });

  it('persists the GitHub login (.login) resolved from /user', async () => {
    let userUrl: string | undefined;
    const { resolver, map } = makeResolver({
      fetchImpl: async (url) => {
        userUrl = url;
        return { ok: true, json: async () => ({ login: 'octocat' }) } as unknown as Response;
      },
    });
    const wrote = await resolver.persistGitHub({ found: true, source: 'gh-cli', value: 'gho_x' });
    expect(wrote).toBe(true);
    expect(userUrl).toBe('https://api.github.com/user');
    const record = JSON.parse(map.get(GITHUB_TOKEN_KEY)!) as { token: string; login?: string };
    expect(record.login).toBe('octocat');
  });

  it('still persists the token with NO login when the /user fetch fails (never throws)', async () => {
    const { resolver, map } = makeResolver({
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    const wrote = await resolver.persistGitHub({ found: true, source: 'gh-cli', value: 'gho_x' });
    expect(wrote).toBe(true);
    const record = JSON.parse(map.get(GITHUB_TOKEN_KEY)!) as { token: string; login?: string };
    expect(record.token).toBe('gho_x');
    expect(record.login).toBeUndefined();
  });

  it('is idempotent — skips when the stored record already holds the same token', async () => {
    let fetched = false;
    const { resolver } = makeResolver(
      {
        fetchImpl: async () => {
          fetched = true;
          return { ok: true, json: async () => ({ login: 'octocat' }) } as unknown as Response;
        },
      },
      { [GITHUB_TOKEN_KEY]: JSON.stringify({ token: 'gho_x', scopes: [] }) }
    );
    expect(await resolver.persistGitHub({ found: true, source: 'store', value: 'gho_x' })).toBe(
      false
    );
    // The idempotent short-circuit returns BEFORE the login fetch.
    expect(fetched).toBe(false);
  });

  it('does nothing for a found:false discovery', async () => {
    const { resolver, map } = makeResolver();
    expect(await resolver.persistGitHub({ found: false })).toBe(false);
    expect(map.has(GITHUB_TOKEN_KEY)).toBe(false);
  });
});
