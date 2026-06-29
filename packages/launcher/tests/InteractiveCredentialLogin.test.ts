/**
 * InteractiveCredentialLogin tests.
 *
 * The "ask them to log in" half. Drives the fallbacks with injected seams
 * (subprocess / device-flow HTTP / confirm prompt) — no real CLI, no real network:
 *   - Anthropic: when `claude` is present → run `claude setup-token`, then
 *     RE-DISCOVER (and persist); when absent → loud warning, no crash.
 *   - GitHub: SKIPPABLE — device flow only when offered+accepted, polls + persists;
 *     declined / no client id → guidance, no crash.
 */
import { describe, expect, it } from 'bun:test';
import path from 'path';

import {
  CredentialResolver,
  CLAUDE_OAUTH_TOKEN_KEY,
  GITHUB_TOKEN_KEY,
  type CredentialResolverDeps,
} from '../src/CredentialResolver.js';
import {
  InteractiveCredentialLogin,
  type InteractiveCredentialLoginDeps,
} from '../src/InteractiveCredentialLogin.js';

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

const noopReads: Partial<CredentialResolverDeps> = {
  readFile: () => undefined,
  runCommand: async () => undefined,
  platform: () => 'linux',
  homedir: () => '/home/tester',
};

function makeLogin(
  storeSeed: Record<string, string>,
  resolverOverrides: Partial<CredentialResolverDeps>,
  loginOverrides: Partial<InteractiveCredentialLoginDeps>
) {
  const { store, map } = makeStore(storeSeed);
  const lines: string[] = [];
  const resolver = new CredentialResolver({
    store,
    env: {} as NodeJS.ProcessEnv,
    ...noopReads,
    ...resolverOverrides,
  });
  const login = new InteractiveCredentialLogin({
    store,
    resolver,
    env: {} as NodeJS.ProcessEnv,
    log: (l) => lines.push(l),
    detectBinary: async () => false,
    runInteractive: async () => 0,
    confirm: async () => false,
    fetchImpl: async () => {
      throw new Error('fetch should not be called');
    },
    sleep: async () => {},
    ...loginOverrides,
  });
  return { login, store, map, lines };
}

// ---------------------------------------------------------------------------
// ANTHROPIC
// ---------------------------------------------------------------------------

describe('InteractiveCredentialLogin.ensureAnthropic', () => {
  it('runs `claude setup-token` when claude is present, then re-discovers + persists', async () => {
    let ran: { cmd: string; args: string[] } | undefined;
    // Simulate: before login the credentials file is empty; after a successful
    // login it returns a token. We flip a flag the readFile seam reads.
    let loggedIn = false;
    const { login, map, lines } = makeLogin(
      {},
      {
        readFile: (p) =>
          loggedIn && p.endsWith(path.join('.claude', '.credentials.json'))
            ? JSON.stringify({ claudeAiOauth: { accessToken: 'fresh-tok' } })
            : undefined,
      },
      {
        detectBinary: async (bin) => bin === 'claude',
        runInteractive: async (cmd, args) => {
          ran = { cmd, args };
          loggedIn = true;
          return 0;
        },
      }
    );

    const result = await login.ensureAnthropic();

    expect(ran).toEqual({ cmd: 'claude', args: ['setup-token'] });
    expect(result).toMatchObject({
      found: true,
      source: 'claude-credentials-file',
      value: 'fresh-tok',
    });
    // Persisted into the canonical store key the api reads.
    expect(map.get(CLAUDE_OAUTH_TOKEN_KEY)).toBe('fresh-tok');
    expect(lines.some((l) => l.includes('Anthropic credential obtained'))).toBe(true);
  });

  it('warns (no crash) and returns found:false when claude is absent', async () => {
    let ranInteractive = false;
    const { login, lines } = makeLogin(
      {},
      {},
      {
        detectBinary: async () => false,
        runInteractive: async () => {
          ranInteractive = true;
          return 0;
        },
      }
    );
    const result = await login.ensureAnthropic();
    expect(result).toEqual({ found: false });
    expect(ranInteractive).toBe(false);
    expect(lines.some((l) => l.includes('`claude` CLI is not installed'))).toBe(true);
    expect(lines.some((l) => l.includes('ANTHROPIC_API_KEY'))).toBe(true);
  });

  it('warns (no crash) when the claude login exits non-zero', async () => {
    const { login, lines } = makeLogin(
      {},
      {},
      {
        detectBinary: async () => true,
        runInteractive: async () => 1,
      }
    );
    const result = await login.ensureAnthropic();
    expect(result).toEqual({ found: false });
    expect(lines.some((l) => l.includes('did not complete'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GITHUB
// ---------------------------------------------------------------------------

describe('InteractiveCredentialLogin.ensureGitHub', () => {
  it('runs the device flow on accept: polls past authorization_pending, then persists (incl. .login)', async () => {
    const fetchCalls: string[] = [];
    // Route by URL (not index) so the post-grant /user login lookup is explicit.
    const { login, map, lines } = makeLogin(
      {},
      {},
      {
        env: { GITHUB_OAUTH_CLIENT_ID: 'Iv1.client' } as NodeJS.ProcessEnv,
        confirm: async () => true,
        sleep: async () => {},
        fetchImpl: (() => {
          let polls = 0;
          return async (url: string) => {
            fetchCalls.push(url);
            if (url.includes('/login/device/code')) {
              return {
                ok: true,
                json: async () => ({
                  device_code: 'dc',
                  user_code: 'WXYZ-1234',
                  verification_uri: 'https://github.com/login/device',
                  interval: 1,
                  expires_in: 900,
                }),
              } as unknown as Response;
            }
            if (url.includes('/login/oauth/access_token')) {
              // first poll pending, second poll granted
              return {
                ok: true,
                json: async () =>
                  polls++ === 0
                    ? { error: 'authorization_pending' }
                    : { access_token: 'gho_deviceflow' },
              } as unknown as Response;
            }
            // https://api.github.com/user
            return { ok: true, json: async () => ({ login: 'octocat' }) } as unknown as Response;
          };
        })(),
      }
    );

    const result = await login.ensureGitHub();

    expect(result.found).toBe(true);
    expect(result.value).toBe('gho_deviceflow');
    // Persisted into the canonical github-oauth:token JSON record — incl. .login.
    const record = JSON.parse(map.get(GITHUB_TOKEN_KEY)!) as {
      token: string;
      scopes: string[];
      login?: string;
    };
    expect(record.token).toBe('gho_deviceflow');
    expect(record.scopes).toEqual(['repo', 'read:org']);
    expect(record.login).toBe('octocat');
    // Hit device-code URL once + the token URL twice (pending → granted) + /user once.
    expect(fetchCalls.filter((u) => u.includes('/login/device/code')).length).toBe(1);
    expect(fetchCalls.filter((u) => u.includes('/login/oauth/access_token')).length).toBe(2);
    expect(fetchCalls.filter((u) => u === 'https://api.github.com/user').length).toBe(1);
    expect(lines.some((l) => l.includes('enter the code: WXYZ-1234'))).toBe(true);
  });

  it('still persists the token with NO login when the /user fetch fails (never throws)', async () => {
    const { login, map } = makeLogin(
      {},
      {},
      {
        env: { GITHUB_OAUTH_CLIENT_ID: 'Iv1.client' } as NodeJS.ProcessEnv,
        confirm: async () => true,
        sleep: async () => {},
        fetchImpl: async (url: string) => {
          if (url.includes('/login/device/code')) {
            return {
              ok: true,
              json: async () => ({
                device_code: 'dc',
                user_code: 'C',
                verification_uri: 'u',
                interval: 1,
                expires_in: 900,
              }),
            } as unknown as Response;
          }
          if (url.includes('/login/oauth/access_token')) {
            return {
              ok: true,
              json: async () => ({ access_token: 'gho_x' }),
            } as unknown as Response;
          }
          // /user — simulate a non-2xx so no login is resolved.
          return { ok: false, json: async () => ({}) } as unknown as Response;
        },
      }
    );

    const result = await login.ensureGitHub();

    expect(result.found).toBe(true);
    expect(result.value).toBe('gho_x');
    const record = JSON.parse(map.get(GITHUB_TOKEN_KEY)!) as { token: string; login?: string };
    expect(record.token).toBe('gho_x');
    expect(record.login).toBeUndefined();
  });

  it('is SKIPPABLE — declined offer never touches the network and never blocks', async () => {
    let fetched = false;
    const { login, map, lines } = makeLogin(
      {},
      {},
      {
        env: { GITHUB_OAUTH_CLIENT_ID: 'Iv1.client' } as NodeJS.ProcessEnv,
        confirm: async () => false,
        fetchImpl: async () => {
          fetched = true;
          throw new Error('should not fetch');
        },
      }
    );
    const result = await login.ensureGitHub();
    expect(result).toEqual({ found: false });
    expect(fetched).toBe(false);
    expect(map.has(GITHUB_TOKEN_KEY)).toBe(false);
    expect(lines.some((l) => l.includes('connect it later'))).toBe(true);
  });

  it('prints guidance (no offer) when GITHUB_OAUTH_CLIENT_ID is unset', async () => {
    let confirmed = false;
    const { login, lines } = makeLogin(
      {},
      {},
      {
        env: {} as NodeJS.ProcessEnv,
        confirm: async () => {
          confirmed = true;
          return true;
        },
      }
    );
    const result = await login.ensureGitHub();
    expect(result).toEqual({ found: false });
    expect(confirmed).toBe(false);
    expect(lines.some((l) => l.includes('GITHUB_OAUTH_CLIENT_ID'))).toBe(true);
  });

  it('does not crash when the device flow errors (denied) — warns + found:false', async () => {
    const { login, map, lines } = makeLogin(
      {},
      {},
      {
        env: { GITHUB_OAUTH_CLIENT_ID: 'Iv1.client' } as NodeJS.ProcessEnv,
        confirm: async () => true,
        sleep: async () => {},
        fetchImpl: async (url) => {
          if (url.includes('/login/device/code')) {
            return {
              ok: true,
              json: async () => ({
                device_code: 'dc',
                user_code: 'C',
                verification_uri: 'u',
                interval: 1,
                expires_in: 900,
              }),
            } as unknown as Response;
          }
          return {
            ok: true,
            json: async () => ({ error: 'access_denied' }),
          } as unknown as Response;
        },
      }
    );
    const result = await login.ensureGitHub();
    expect(result).toEqual({ found: false });
    expect(map.has(GITHUB_TOKEN_KEY)).toBe(false);
    expect(lines.some((l) => l.includes('device flow failed'))).toBe(true);
  });
});
