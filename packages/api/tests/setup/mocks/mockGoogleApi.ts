/**
 * Mock Google API for testing OAuth flows
 *
 * Mocks:
 * - OAuth token exchange (code → access token + refresh token)
 * - User info fetch
 * - Token refresh
 * - Drive API access
 */

export interface MockGoogleUser {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  picture: string;
}

export interface MockGoogleTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export class MockGoogleApi {
  private static users: Map<string, MockGoogleUser> = new Map();
  private static tokens: Map<string, MockGoogleTokens> = new Map();
  private static refreshTokens: Map<string, string> = new Map();

  /**
   * Register a test user with Google API
   */
  static registerUser(
    code: string,
    accessToken: string,
    refreshToken: string,
    user: MockGoogleUser,
    scope: string = 'https://www.googleapis.com/auth/drive.readonly'
  ): void {
    this.users.set(code, user);
    this.tokens.set(code, {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope,
    });
    this.refreshTokens.set(refreshToken, accessToken);
  }

  /**
   * Mock OAuth token exchange
   */
  static async exchangeCode(code: string): Promise<MockGoogleTokens | null> {
    return this.tokens.get(code) || null;
  }

  /**
   * Mock user info fetch
   */
  static async getUserInfo(accessToken: string): Promise<MockGoogleUser | null> {
    // Find user by access token
    for (const [code, tokens] of this.tokens.entries()) {
      if (tokens.access_token === accessToken) {
        return this.users.get(code) || null;
      }
    }
    return null;
  }

  /**
   * Mock token refresh
   */
  static async refreshAccessToken(refreshToken: string): Promise<string | null> {
    return this.refreshTokens.get(refreshToken) || null;
  }

  /**
   * Clear all registered data (for test cleanup)
   */
  static clear(): void {
    this.users.clear();
    this.tokens.clear();
    this.refreshTokens.clear();
  }
}

/**
 * Mock fetch for Google OAuth token endpoint
 */
export async function mockGoogleTokenFetch(url: string, options: RequestInit): Promise<Response> {
  if (url.includes('oauth2.googleapis.com/token')) {
    const body = new URLSearchParams(options.body as string);
    const code = body.get('code');
    const refreshToken = body.get('refresh_token');

    if (code) {
      // Token exchange
      const tokens = await MockGoogleApi.exchangeCode(code);
      if (tokens) {
        return new Response(JSON.stringify(tokens), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } else if (refreshToken) {
      // Token refresh
      const newAccessToken = await MockGoogleApi.refreshAccessToken(refreshToken);
      if (newAccessToken) {
        return new Response(
          JSON.stringify({
            access_token: newAccessToken,
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }
  }

  return new Response(JSON.stringify({ error: 'invalid_grant' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}
