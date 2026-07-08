/**
 * aiCredentialErrorClassifier unit tests (portable.dev#18).
 *
 * Pure classification: auth-flavored run-error text → the inline errorBlock
 * with code 'ai_credential_invalid'; anything else → undefined (the caller
 * emits a plain claude:error).
 */
import { describe, expect, it } from 'bun:test';

import {
  AI_CREDENTIAL_INVALID_CODE,
  buildAiCredentialErrorBlock,
  isAiCredentialError,
} from '../../../src/services/aiCredentialErrorClassifier';

describe('isAiCredentialError', () => {
  it.each([
    'OAuth token has expired · Please run /login',
    'API Error: 401 authentication_error',
    'invalid x-api-key',
    'Invalid API key · Fix external API key',
    'Your credential is invalid',
    '[LocalAiCredentialsService] FATAL: No local Anthropic credential configured.',
  ])('recognizes credential failure: %s', (text) => {
    expect(isAiCredentialError(text)).toBe(true);
  });

  it.each([
    'Failed to clone repository',
    'GitHub API returned 401', // GitHub, not the AI credential
    'Process exited with code 1',
    '',
  ])('does NOT match a non-credential error: %s', (text) => {
    expect(isAiCredentialError(text)).toBe(false);
  });

  it('handles undefined/null', () => {
    expect(isAiCredentialError(undefined)).toBe(false);
    expect(isAiCredentialError(null)).toBe(false);
  });
});

describe('buildAiCredentialErrorBlock', () => {
  it('builds the inline error block with the sign-in code and original details', () => {
    const block = buildAiCredentialErrorBlock('OAuth token has expired · Please run /login');
    expect(block).toBeDefined();
    expect(block!.type).toBe('error');
    expect(block!.code).toBe(AI_CREDENTIAL_INVALID_CODE);
    expect(block!.blockId).toBeDefined();
    expect(block!.details).toBe('OAuth token has expired · Please run /login');
    expect(typeof block!.title).toBe('string');
    expect(typeof block!.message).toBe('string');
  });

  it('returns undefined for a non-credential error', () => {
    expect(buildAiCredentialErrorBlock('Failed to clone repository')).toBeUndefined();
  });

  it('mints a fresh blockId per build (no dedup collisions)', () => {
    const a = buildAiCredentialErrorBlock('authentication_error')!;
    const b = buildAiCredentialErrorBlock('authentication_error')!;
    expect(a.blockId).not.toBe(b.blockId);
  });
});
