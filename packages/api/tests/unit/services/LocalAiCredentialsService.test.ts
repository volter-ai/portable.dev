/**
 * LocalAiCredentialsService unit tests.
 *
 * Boundary mocked: a REAL LocalSecretStore backed by a temp DATA_DIR (encrypted
 * on disk) + process.env. No network, no Anthropic SDK.
 *
 * Covers the acceptance criteria:
 *  - Two first-class modes: Claude subscription OAuth OR raw ANTHROPIC_API_KEY
 *  - api reads whichever is configured (no JWT claim involved)
 *  - OAuth preferred over API key when both are present
 *  - applyToProcessEnv wires the right env var + clears ANTHROPIC_BASE_URL
 *    (defaults to https://api.anthropic.com), mutually-exclusive credentials
 *  - throws with guidance when neither is configured
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { LocalSecretStore } from '@vgit2/shared/secrets';

import {
  CLAUDE_OAUTH_TOKEN_KEY,
  LocalAiCredentialsService,
} from '../../../src/services/LocalAiCredentialsService';

let tmpDir: string;
let store: LocalSecretStore;
let service: LocalAiCredentialsService;

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-ai-creds-test-'));
  store = new LocalSecretStore({ dataDir: tmpDir });
  service = new LocalAiCredentialsService(store);

  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Claude OAuth token persistence', () => {
  it('stores, reads, and reports the OAuth token', () => {
    expect(service.hasClaudeOAuthToken()).toBe(false);
    expect(service.getClaudeOAuthToken()).toBeNull();

    service.setClaudeOAuthToken('sk-ant-oat01-abc');

    expect(service.hasClaudeOAuthToken()).toBe(true);
    expect(service.getClaudeOAuthToken()).toBe('sk-ant-oat01-abc');
  });

  it('persists the OAuth token encrypted at rest (never plaintext on disk)', () => {
    service.setClaudeOAuthToken('sk-ant-oat01-secret-value');
    const raw = fs.readFileSync(path.join(tmpDir, 'secrets.json'), 'utf8');
    expect(raw).not.toContain('sk-ant-oat01-secret-value');
    // The namespaced key IS visible (list never decrypts), but the value is not.
    expect(store.list()).toContain(CLAUDE_OAUTH_TOKEN_KEY);
  });

  it('trims and rejects an empty OAuth token', () => {
    service.setClaudeOAuthToken('  sk-ant-oat01-trimmed  ');
    expect(service.getClaudeOAuthToken()).toBe('sk-ant-oat01-trimmed');
    expect(() => service.setClaudeOAuthToken('   ')).toThrow();
  });

  it('clears the OAuth token (reverts to API-key mode)', () => {
    service.setClaudeOAuthToken('sk-ant-oat01-abc');
    expect(service.clearClaudeOAuthToken()).toBe(true);
    expect(service.hasClaudeOAuthToken()).toBe(false);
  });
});

describe('resolveCredential', () => {
  it('returns claude-oauth mode when an OAuth token is configured', () => {
    service.setClaudeOAuthToken('sk-ant-oat01-abc');
    expect(service.resolveCredential()).toEqual({
      mode: 'claude-oauth',
      oauthToken: 'sk-ant-oat01-abc',
    });
  });

  it('returns api-key mode from ANTHROPIC_API_KEY when no OAuth token is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api-key-123';
    expect(service.resolveCredential()).toEqual({
      mode: 'api-key',
      apiKey: 'sk-ant-api-key-123',
    });
  });

  it('prefers the Claude OAuth token over ANTHROPIC_API_KEY when both are present', () => {
    service.setClaudeOAuthToken('sk-ant-oat01-abc');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api-key-123';
    expect(service.resolveCredential().mode).toBe('claude-oauth');
  });

  it('throws with actionable guidance when neither credential is configured', () => {
    expect(() => service.resolveCredential()).toThrow(/No local Anthropic credential/);
  });

  it('does NOT read any JWT claim — only the store and ANTHROPIC_API_KEY', () => {
    // No store token, no ANTHROPIC_API_KEY → must throw regardless of any JWT.
    expect(() => service.resolveCredential()).toThrow();
  });
});

describe('applyToProcessEnv', () => {
  it('OAuth mode: sets CLAUDE_CODE_OAUTH_TOKEN, clears ANTHROPIC_API_KEY + base URL', () => {
    service.setClaudeOAuthToken('sk-ant-oat01-abc');
    process.env.ANTHROPIC_API_KEY = 'stale-key';
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9999'; // simulate a stale shim URL

    const mode = service.applyToProcessEnv();

    expect(mode).toBe('claude-oauth');
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-abc');
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    // Defaults to https://api.anthropic.com by leaving the base URL unset.
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('api-key mode: sets ANTHROPIC_API_KEY, clears OAuth token + base URL', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api-key-123';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'stale-oauth';
    process.env.ANTHROPIC_BASE_URL = 'https://example.test/anthropic-proxy';

    const mode = service.applyToProcessEnv();

    expect(mode).toBe('api-key');
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-api-key-123');
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('throws (and mutates nothing) when no credential is configured', () => {
    expect(() => service.applyToProcessEnv()).toThrow();
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
