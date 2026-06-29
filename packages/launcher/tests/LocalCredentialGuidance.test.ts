/**
 * LocalCredentialGuidance tests.
 *
 * The launcher surfaces local Anthropic + GitHub credential status during boot
 * (mirroring the api's resolvers) and prints guidance when missing — never
 * hard-blocking.
 */
import { describe, expect, it } from 'bun:test';

import {
  resolveCredentialStatus,
  reportCredentialGuidance,
  CLAUDE_OAUTH_TOKEN_KEY,
  GITHUB_TOKEN_KEY,
} from '../src/LocalCredentialGuidance.js';

function makeStore(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get: (k: string) => map.get(k),
  } as unknown as Parameters<typeof resolveCredentialStatus>[0];
}

describe('resolveCredentialStatus', () => {
  it('reports claude-oauth when a Claude OAuth token is stored', () => {
    const store = makeStore({ [CLAUDE_OAUTH_TOKEN_KEY]: 'oauth-tok', [GITHUB_TOKEN_KEY]: 'gh' });
    const status = resolveCredentialStatus(store, {} as NodeJS.ProcessEnv);
    expect(status).toEqual({
      anthropicConfigured: true,
      anthropicMode: 'claude-oauth',
      githubConfigured: true,
    });
  });

  it('falls back to api-key from ANTHROPIC_API_KEY env', () => {
    const store = makeStore();
    const status = resolveCredentialStatus(store, {
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
    } as NodeJS.ProcessEnv);
    expect(status.anthropicConfigured).toBe(true);
    expect(status.anthropicMode).toBe('api-key');
    expect(status.githubConfigured).toBe(false);
  });

  it('reports nothing configured when neither credential is present', () => {
    const status = resolveCredentialStatus(makeStore(), {} as NodeJS.ProcessEnv);
    expect(status.anthropicConfigured).toBe(false);
    expect(status.anthropicMode).toBe('none');
    expect(status.githubConfigured).toBe(false);
  });

  it('honours GITHUB_TOKEN / GITHUB_OAUTH_TOKEN env for github', () => {
    expect(
      resolveCredentialStatus(makeStore(), { GITHUB_TOKEN: 'ghp_x' } as NodeJS.ProcessEnv)
        .githubConfigured
    ).toBe(true);
    expect(
      resolveCredentialStatus(makeStore(), { GITHUB_OAUTH_TOKEN: 'gho_x' } as NodeJS.ProcessEnv)
        .githubConfigured
    ).toBe(true);
  });
});

describe('reportCredentialGuidance', () => {
  it('logs warnings (never throws) when credentials are missing', () => {
    const lines: string[] = [];
    const status = reportCredentialGuidance(
      makeStore(),
      (l) => lines.push(l),
      {} as NodeJS.ProcessEnv
    );
    expect(status.anthropicConfigured).toBe(false);
    expect(lines.some((l) => l.includes('No Anthropic credential'))).toBe(true);
    expect(lines.some((l) => l.includes('GitHub not connected'))).toBe(true);
  });

  it('logs ready lines when both credentials are present', () => {
    const lines: string[] = [];
    const store = makeStore({ [CLAUDE_OAUTH_TOKEN_KEY]: 'o', [GITHUB_TOKEN_KEY]: 'g' });
    reportCredentialGuidance(store, (l) => lines.push(l), {} as NodeJS.ProcessEnv);
    expect(lines.some((l) => l.includes('Anthropic credential ready'))).toBe(true);
    expect(lines.some((l) => l.includes('GitHub access ready'))).toBe(true);
  });
});
