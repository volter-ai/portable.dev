/**
 * Mock Slack Client for testing
 */

import type { SlackClient, SlackOAuthTokenResponse } from '../../../src/services/SlackClient';

export interface MockSlackTeam {
  id: string;
  name: string;
}

export class MockSlackClient implements Pick<SlackClient, 'exchangeOAuthCode'> {
  private tokens: Map<string, SlackOAuthTokenResponse> = new Map();

  /**
   * Register a test Slack workspace
   */
  registerWorkspace(
    code: string,
    accessToken: string,
    team: MockSlackTeam,
    botUserId: string,
    scopes: string[] = ['chat:write', 'channels:read', 'files:write']
  ): void {
    this.tokens.set(code, {
      ok: true,
      access_token: accessToken,
      token_type: 'bot',
      scope: scopes.join(','),
      bot_user_id: botUserId,
      app_id: 'A12345678',
      team,
      authed_user: {
        id: 'U12345678',
      },
    });
  }

  /**
   * Mock OAuth token exchange
   */
  async exchangeOAuthCode(code: string, _redirectUri: string): Promise<SlackOAuthTokenResponse> {
    const tokens = this.tokens.get(code);

    if (tokens) {
      return tokens;
    }

    // Return error for invalid codes
    return {
      ok: false,
      error: 'invalid_code',
    };
  }

  /**
   * Clear all registered data (for test cleanup)
   */
  clear(): void {
    this.tokens.clear();
  }
}
