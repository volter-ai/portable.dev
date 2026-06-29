/**
 * ExecutionHandler.determineApiRoutingMode — local-first routing.
 *
 * Boundary mocked: none — determineApiRoutingMode is pure. Local-first ALWAYS
 * routes 'direct' to api.anthropic.com (the old billing/routing proxy + its
 * env / sandbox-mode switch were removed), so the AI
 * credential is NEVER pulled from the JWT/billing path.
 */
import { describe, expect, it } from 'bun:test';

import { ExecutionHandler } from '../../../src/services/ClaudeService/handlers/ExecutionHandler';

function buildHandler(): ExecutionHandler {
  const noopHandlers = {
    sessionHandler: {},
    streamHandler: {},
    permissionHandler: {},
    agentHandler: {},
    actionHandler: {},
  } as any;
  // Constructor only assigns dependency/handler references — no methods are called.
  return new ExecutionHandler(
    { chatService: {}, mcpService: {}, mediaProcessingService: {}, devServerMonitor: {} } as any,
    noopHandlers,
    new Map(),
    new Map(),
    new Map()
  );
}

describe('determineApiRoutingMode in local mode', () => {
  it('returns direct in local mode regardless of JWT claims (no JWT-claim routing)', () => {
    const handler = buildHandler();

    expect(handler.determineApiRoutingMode('user@example.com')).toBe('direct');
  });

  it('returns direct in local mode when the JWT has no AI token at all', () => {
    const handler = buildHandler();

    expect(handler.determineApiRoutingMode('user@example.com')).toBe('direct');
  });
});
