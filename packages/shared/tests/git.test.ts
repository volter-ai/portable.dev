/**
 * Git provider host-helper unit tests. Pure functions — GitHub stays the
 * default, and non-GitHub hosts resolve API bases / clone URLs / slugs /
 * credential usernames per provider convention.
 */
import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_GIT_HOST,
  buildCloneUrl,
  defaultApiBaseUrl,
  gitCredentialUsername,
  gitHostname,
  noreplyEmailDomain,
  ownerAvatarUrl,
  parseRepoSlug,
  resolveGitHost,
} from '../src/types/git.js';

describe('resolveGitHost', () => {
  it('defaults to the public GitHub host', () => {
    expect(resolveGitHost()).toEqual(DEFAULT_GIT_HOST);
    expect(resolveGitHost('github')).toEqual(DEFAULT_GIT_HOST);
  });

  it('derives per-provider API bases from a self-hosted web origin', () => {
    expect(resolveGitHost('gitea', 'https://git.example.com/').apiBaseUrl).toBe(
      'https://git.example.com/api/v1'
    );
    expect(resolveGitHost('gitlab', 'https://gl.example.com').apiBaseUrl).toBe(
      'https://gl.example.com/api/v4'
    );
    expect(resolveGitHost('github', 'https://ghe.corp').apiBaseUrl).toBe('https://ghe.corp/api/v3');
    expect(resolveGitHost('generic', 'https://code.example.com').apiBaseUrl).toBe(
      'https://code.example.com'
    );
  });

  it('honours an explicit apiBaseUrl and strips trailing slashes', () => {
    const h = resolveGitHost(
      'gitea',
      'https://git.example.com/',
      'https://git.example.com/custom/'
    );
    expect(h.webBaseUrl).toBe('https://git.example.com');
    expect(h.apiBaseUrl).toBe('https://git.example.com/custom');
  });
});

describe('defaultApiBaseUrl', () => {
  it('keeps api.github.com only for public github', () => {
    expect(defaultApiBaseUrl('github', 'https://github.com')).toBe('https://api.github.com');
    expect(defaultApiBaseUrl('github', 'https://ghe.corp')).toBe('https://ghe.corp/api/v3');
  });
});

describe('buildCloneUrl / avatar / hostname', () => {
  it('builds token-free clone URLs on the target host', () => {
    const gitea = resolveGitHost('gitea', 'https://git.example.com');
    expect(buildCloneUrl(gitea, 'kerim', 'kontakt-api')).toBe(
      'https://git.example.com/kerim/kontakt-api.git'
    );
    expect(buildCloneUrl(DEFAULT_GIT_HOST, 'volter-ai', 'portable.dev')).toBe(
      'https://github.com/volter-ai/portable.dev.git'
    );
  });

  it('exposes .png avatars for github/gitea and none for gitlab/generic', () => {
    expect(ownerAvatarUrl(DEFAULT_GIT_HOST, 'octocat', 64)).toBe(
      'https://github.com/octocat.png?size=64'
    );
    expect(ownerAvatarUrl(resolveGitHost('gitea', 'https://git.example.com'), 'kerim')).toBe(
      'https://git.example.com/kerim.png'
    );
    expect(
      ownerAvatarUrl(resolveGitHost('gitlab', 'https://gl.example.com'), 'kerim')
    ).toBeUndefined();
    expect(
      ownerAvatarUrl(resolveGitHost('generic', 'https://code.example.com'), 'kerim')
    ).toBeUndefined();
  });

  it('returns the bare hostname', () => {
    expect(gitHostname(DEFAULT_GIT_HOST)).toBe('github.com');
    expect(gitHostname(resolveGitHost('gitea', 'https://git.example.com:3000'))).toBe(
      'git.example.com:3000'
    );
  });
});

describe('gitCredentialUsername / noreplyEmailDomain', () => {
  it('uses oauth2 for gitlab and x-access-token elsewhere', () => {
    expect(gitCredentialUsername('github')).toBe('x-access-token');
    expect(gitCredentialUsername('gitea')).toBe('x-access-token');
    expect(gitCredentialUsername('generic')).toBe('x-access-token');
    expect(gitCredentialUsername('gitlab')).toBe('oauth2');
  });

  it('keeps GitHub noreply for public github and host domain elsewhere', () => {
    expect(noreplyEmailDomain(DEFAULT_GIT_HOST)).toBe('users.noreply.github.com');
    expect(noreplyEmailDomain(resolveGitHost('gitea', 'https://git.example.com'))).toBe(
      'git.example.com'
    );
  });
});

describe('parseRepoSlug', () => {
  const gitea = resolveGitHost('gitea', 'https://git.example.com');

  it('parses https, ssh and scp-like remotes for the target host', () => {
    expect(parseRepoSlug(gitea, 'https://git.example.com/kerim/kontakt-api.git')).toEqual({
      owner: 'kerim',
      repo: 'kontakt-api',
    });
    expect(parseRepoSlug(gitea, 'git@git.example.com:kerim/kontakt-api.git')).toEqual({
      owner: 'kerim',
      repo: 'kontakt-api',
    });
    expect(parseRepoSlug(gitea, 'ssh://git@git.example.com/kerim/kontakt-api')).toEqual({
      owner: 'kerim',
      repo: 'kontakt-api',
    });
    expect(parseRepoSlug(DEFAULT_GIT_HOST, 'https://github.com/volter-ai/portable.dev')).toEqual({
      owner: 'volter-ai',
      repo: 'portable.dev',
    });
  });

  it('returns null for a remote on a different host', () => {
    expect(parseRepoSlug(gitea, 'https://github.com/octocat/hello')).toBeNull();
    expect(parseRepoSlug(DEFAULT_GIT_HOST, 'https://git.example.com/kerim/kontakt-api')).toBeNull();
  });
});
