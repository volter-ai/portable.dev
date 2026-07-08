/**
 * LocalAiHelper unit tests
 *
 * LocalAiHelper is the local-first auxiliary AI helper for short one-shot
 * calls. It resolves the user's OWN Anthropic credential and runs a one-shot,
 * non-streaming messages.create (Haiku) direct to api.anthropic.com.
 *
 * These tests mock @anthropic-ai/sdk to assert the credential-mode branching
 * (api-key vs claude-oauth) and the text/JSON extraction — without any network call.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ========================================
// MOCK @anthropic-ai/sdk (default export) BEFORE importing LocalAiHelper
// ========================================

const constructorCalls: any[] = [];
const createCalls: any[] = [];
let mockResponseContent: any[] = [{ type: 'text', text: '' }];

class MockAnthropic {
  constructor(opts: any) {
    constructorCalls.push(opts);
  }
  messages = {
    create: mock(async (args: any) => {
      createCalls.push(args);
      return { content: mockResponseContent };
    }),
  };
}

mock.module('@anthropic-ai/sdk', () => ({ default: MockAnthropic }));

import { LocalAiHelper } from '../../../src/services/ai/LocalAiHelper';

// ========================================
// Helpers
// ========================================

function helperFor(credential: any): LocalAiHelper {
  const credentials = {
    ensureFresh: async () => {},
    resolveCredential: () => {
      if (!credential) {
        throw new Error(
          '[LocalAiCredentialsService] FATAL: No local Anthropic credential configured.'
        );
      }
      return credential;
    },
  } as any;
  return new LocalAiHelper(credentials);
}

const API_KEY_CRED = { mode: 'api-key', apiKey: 'sk-ant-test-123' };
const OAUTH_CRED = { mode: 'claude-oauth', oauthToken: 'oauth-test-456' };

describe('LocalAiHelper', () => {
  beforeEach(() => {
    constructorCalls.length = 0;
    createCalls.length = 0;
    mockResponseContent = [{ type: 'text', text: '' }];
  });

  describe('isAvailable', () => {
    it('returns true when a credential resolves', () => {
      expect(helperFor(API_KEY_CRED).isAvailable()).toBe(true);
    });

    it('returns false when no credential is configured', () => {
      expect(helperFor(null).isAvailable()).toBe(false);
    });
  });

  describe('complete - api-key mode', () => {
    it('uses x-api-key auth (apiKey), Haiku model, and no Claude Code system identity', async () => {
      mockResponseContent = [{ type: 'text', text: '  hello world  ' }];

      const result = await helperFor(API_KEY_CRED).complete('do a thing', { temperature: 0.3 });

      expect(result).toBe('hello world'); // trimmed
      expect(constructorCalls).toHaveLength(1);
      expect(constructorCalls[0]).toEqual({ apiKey: 'sk-ant-test-123' });

      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].model).toBe('claude-haiku-4-5');
      expect(createCalls[0].temperature).toBe(0.3);
      expect(createCalls[0].messages).toEqual([{ role: 'user', content: 'do a thing' }]);
      // No system prompt injected in api-key mode (none provided)
      expect(createCalls[0].system).toBeUndefined();
    });
  });

  describe('complete - claude-oauth mode', () => {
    it('uses Bearer auth + oauth beta header and leads the system prompt with the Claude Code identity', async () => {
      mockResponseContent = [{ type: 'text', text: 'ok' }];

      await helperFor(OAUTH_CRED).complete('do a thing', { system: 'extra system' });

      expect(constructorCalls).toHaveLength(1);
      expect(constructorCalls[0].authToken).toBe('oauth-test-456');
      expect(constructorCalls[0].defaultHeaders).toEqual({
        'anthropic-beta': 'oauth-2025-04-20',
      });
      expect(constructorCalls[0].apiKey).toBeUndefined();

      // System prompt MUST lead with the Claude Code identity (so the OAuth token is accepted)
      expect(createCalls[0].system).toContain(
        "You are Claude Code, Anthropic's official CLI for Claude."
      );
      expect(createCalls[0].system).toContain('extra system');
    });
  });

  describe('complete - response shape', () => {
    it('returns empty string when the first content block is not text', async () => {
      mockResponseContent = [{ type: 'tool_use', id: 'x' }];
      const result = await helperFor(API_KEY_CRED).complete('x');
      expect(result).toBe('');
    });
  });

  describe('completeJson', () => {
    it('extracts the first JSON object from the response text', async () => {
      mockResponseContent = [
        { type: 'text', text: 'noise before {"intentType":"new-repo"} trailing' },
      ];
      const parsed = await helperFor(API_KEY_CRED).completeJson<{ intentType: string }>('x');
      expect(parsed.intentType).toBe('new-repo');
    });

    it('throws when no JSON object is present', async () => {
      mockResponseContent = [{ type: 'text', text: 'no json here' }];
      await expect(helperFor(API_KEY_CRED).completeJson('x')).rejects.toThrow('No JSON object');
    });
  });
});
