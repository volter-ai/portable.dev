/**
 * gitAuthorIdentity Unit Tests
 *
 * Portable commits must be authored with the user's GitHub login (so GitHub history
 * attributes them to the real account), NOT the Clerk display name carried in the JWT.
 *
 * Behaviour under test:
 * - Active OAuth connection  → author = its GitHub login + `<login>@users.noreply.github.com`
 * - Active GitHub App conn.   → author = the app account login (same `username` field)
 * - No GitHub connection yet  → fall back to the JWT username (never blocks/misattributes)
 * - Any resolution failure    → fall back to the JWT username (never throws)
 * - authToken threads through to both ConnectionsService lookups
 */

import { describe, it, expect, mock, spyOn } from 'bun:test';

import {
  chooseGitIdentityToWrite,
  gitNoReplyEmail,
  resolveGitHubLogin,
  resolveGitAuthorIdentity,
  type GitAuthorIdentity,
  type GitHubLoginResolver,
} from '../../../src/services/ClaudeService/gitAuthorIdentity';

const CLERK_DISPLAY_NAME = 'John Doe'; // the WRONG author (Clerk display name from the JWT)
const GITHUB_LOGIN = 'johndoe'; // the CORRECT author (GitHub login)

/** Build a fake ConnectionsService whose two lookups are spies returning fixed values. */
function makeResolver(opts: {
  active?: { type: string; connection?: unknown } | null;
  accountInfo?: { username?: string | null } | null;
  activeThrows?: Error;
  accountInfoThrows?: Error;
}): GitHubLoginResolver & {
  getActiveGitHubConnection: ReturnType<typeof mock>;
  getConnectionAccountInfo: ReturnType<typeof mock>;
} {
  const getActiveGitHubConnection = mock(async () => {
    if (opts.activeThrows) throw opts.activeThrows;
    return opts.active ?? { type: 'none' };
  });
  const getConnectionAccountInfo = mock(async () => {
    if (opts.accountInfoThrows) throw opts.accountInfoThrows;
    return opts.accountInfo ?? null;
  });
  return { getActiveGitHubConnection, getConnectionAccountInfo };
}

describe('gitAuthorIdentity', () => {
  describe('gitNoReplyEmail', () => {
    it('formats the GitHub no-reply address for a login', () => {
      expect(gitNoReplyEmail('johndoe')).toBe('johndoe@users.noreply.github.com');
    });
  });

  describe('resolveGitHubLogin', () => {
    it('returns the GitHub login from an active OAuth connection', async () => {
      const resolver = makeResolver({
        active: { type: 'oauth', connection: { connectionId: 'github_1', service: 'github' } },
        accountInfo: { username: GITHUB_LOGIN },
      });

      const login = await resolveGitHubLogin(resolver, 'user@example.com', 'jwt-token');

      expect(login).toBe(GITHUB_LOGIN);
      // authToken threads through to BOTH lookups
      expect(resolver.getActiveGitHubConnection).toHaveBeenCalledWith(
        'user@example.com',
        'jwt-token'
      );
      const accountInfoArgs = resolver.getConnectionAccountInfo.mock.calls[0];
      expect(accountInfoArgs[1]).toEqual({ authToken: 'jwt-token' });
    });

    it('returns the login from an active GitHub App connection (same username field)', async () => {
      const resolver = makeResolver({
        active: {
          type: 'app',
          connection: { connectionId: 'org_github-app', service: 'github-app' },
        },
        accountInfo: { username: 'acme-org' },
      });

      expect(await resolveGitHubLogin(resolver, 'user@example.com', 't')).toBe('acme-org');
    });

    it('returns null when there is no active GitHub connection (type "none")', async () => {
      const resolver = makeResolver({ active: { type: 'none' } });

      expect(await resolveGitHubLogin(resolver, 'user@example.com', 't')).toBeNull();
      // never reaches account-info lookup
      expect(resolver.getConnectionAccountInfo).not.toHaveBeenCalled();
    });

    it('returns null when the active connection has no connection object', async () => {
      const resolver = makeResolver({ active: { type: 'oauth', connection: undefined } });

      expect(await resolveGitHubLogin(resolver, 'user@example.com', 't')).toBeNull();
      expect(resolver.getConnectionAccountInfo).not.toHaveBeenCalled();
    });

    it('returns null (not "") when the account info username is blank/whitespace', async () => {
      const resolver = makeResolver({
        active: { type: 'oauth', connection: {} },
        accountInfo: { username: '   ' },
      });

      expect(await resolveGitHubLogin(resolver, 'user@example.com', 't')).toBeNull();
    });

    it('returns null when account info is null', async () => {
      const resolver = makeResolver({
        active: { type: 'oauth', connection: {} },
        accountInfo: null,
      });

      expect(await resolveGitHubLogin(resolver, 'user@example.com', 't')).toBeNull();
    });

    it('returns null when there is no connections service at all', async () => {
      expect(await resolveGitHubLogin(undefined, 'user@example.com', 't')).toBeNull();
    });

    it('never throws — getActiveGitHubConnection failure resolves to null', async () => {
      const resolver = makeResolver({ activeThrows: new Error('Clerk unreachable') });
      const warn = spyOn(console, 'warn').mockImplementation(() => {});

      expect(await resolveGitHubLogin(resolver, 'user@example.com', 't')).toBeNull();
      expect(warn).toHaveBeenCalled();

      warn.mockRestore();
    });

    it('never throws — getConnectionAccountInfo failure resolves to null', async () => {
      const resolver = makeResolver({
        active: { type: 'oauth', connection: {} },
        accountInfoThrows: new Error('GitHub /user timed out'),
      });
      const warn = spyOn(console, 'warn').mockImplementation(() => {});

      expect(await resolveGitHubLogin(resolver, 'user@example.com', 't')).toBeNull();
      expect(warn).toHaveBeenCalled();

      warn.mockRestore();
    });
  });

  describe('resolveGitAuthorIdentity', () => {
    it('uses the GitHub login + noreply email when a connection exists', async () => {
      const resolver = makeResolver({
        active: { type: 'oauth', connection: {} },
        accountInfo: { username: GITHUB_LOGIN },
      });

      const identity = await resolveGitAuthorIdentity(resolver, {
        userId: 'user@example.com',
        authToken: 't',
        fallbackUsername: CLERK_DISPLAY_NAME,
      });

      expect(identity).toEqual({
        name: GITHUB_LOGIN,
        email: 'johndoe@users.noreply.github.com',
        source: 'github',
      });
    });

    it('falls back to the JWT username when no GitHub connection exists yet', async () => {
      const resolver = makeResolver({ active: { type: 'none' } });

      const identity = await resolveGitAuthorIdentity(resolver, {
        userId: 'user@example.com',
        authToken: 't',
        fallbackUsername: 'fallback-user',
      });

      expect(identity).toEqual({
        name: 'fallback-user',
        email: 'fallback-user@users.noreply.github.com',
        source: 'fallback',
      });
    });

    it('falls back to the JWT username when resolution throws', async () => {
      const resolver = makeResolver({ activeThrows: new Error('boom') });
      const warn = spyOn(console, 'warn').mockImplementation(() => {});

      const identity = await resolveGitAuthorIdentity(resolver, {
        userId: 'user@example.com',
        authToken: 't',
        fallbackUsername: 'fallback-user',
      });

      expect(identity.name).toBe('fallback-user');
      expect(identity.email).toBe('fallback-user@users.noreply.github.com');
      expect(identity.source).toBe('fallback');

      warn.mockRestore();
    });
  });

  describe('chooseGitIdentityToWrite — never clobber the repo owner with the fallback', () => {
    const github: GitAuthorIdentity = {
      name: GITHUB_LOGIN,
      email: 'johndoe@users.noreply.github.com',
      source: 'github',
    };
    const fallback: GitAuthorIdentity = {
      name: 'mac-mini-de-bruno.local',
      email: 'mac-mini-de-bruno.local@users.noreply.github.com',
      source: 'fallback',
    };
    const owner = { name: 'brunoccpires', email: 'brunoccpires@users.noreply.github.com' };

    it('WRITES a resolved GitHub login (correct attribution) — even over an existing owner', () => {
      expect(chooseGitIdentityToWrite(github, owner)).toEqual({
        name: GITHUB_LOGIN,
        email: 'johndoe@users.noreply.github.com',
        write: true,
      });
    });

    it('KEEPS the existing owner (writes nothing) when only the fallback is available', () => {
      // The bug fix: portable must not overwrite the user's own git identity with the
      // PC hostname on every chat.
      expect(chooseGitIdentityToWrite(fallback, owner)).toEqual({
        name: 'brunoccpires',
        email: 'brunoccpires@users.noreply.github.com',
        write: false,
      });
    });

    it('writes the fallback when there is NO existing identity (so commits work / not "Claude")', () => {
      expect(chooseGitIdentityToWrite(fallback, null)).toEqual({
        name: 'mac-mini-de-bruno.local',
        email: 'mac-mini-de-bruno.local@users.noreply.github.com',
        write: true,
      });
    });

    it('writes a GitHub login even when there is no existing identity', () => {
      expect(chooseGitIdentityToWrite(github, null).write).toBe(true);
    });
  });
});
