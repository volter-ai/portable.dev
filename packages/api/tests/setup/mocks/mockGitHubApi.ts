/**
 * Mock GitHub API for testing OAuth flows
 *
 * Mocks:
 * - OAuth token exchange (code → access token)
 * - User info fetch
 * - Scope validation
 * - GitHub App installation tokens
 */

export interface MockGitHubUser {
  id: number;
  login: string;
  email: string;
  name: string;
  avatar_url: string;
}

export interface MockGitHubToken {
  access_token: string;
  token_type: string;
  scope: string;
}

export class MockGitHubApi {
  private static users: Map<string, MockGitHubUser> = new Map();
  private static tokens: Map<string, MockGitHubToken> = new Map();
  private static scopesByToken: Map<string, string[]> = new Map();

  /**
   * Register a test user with GitHub API
   */
  static registerUser(
    code: string,
    token: string,
    user: MockGitHubUser,
    scopes: string[] = ['repo', 'read:org']
  ): void {
    this.users.set(code, user);
    this.tokens.set(code, {
      access_token: token,
      token_type: 'bearer',
      scope: scopes.join(','),
    });
    this.scopesByToken.set(token, scopes);
  }

  /**
   * Mock OAuth token exchange
   */
  static async exchangeCode(code: string): Promise<MockGitHubToken | null> {
    return this.tokens.get(code) || null;
  }

  /**
   * Mock user info fetch
   */
  static async getUser(token: string): Promise<MockGitHubUser | null> {
    // Find user by token
    for (const [code, storedToken] of this.tokens.entries()) {
      if (storedToken.access_token === token) {
        return this.users.get(code) || null;
      }
    }
    return null;
  }

  /**
   * Mock scope validation
   */
  static getScopes(token: string): string[] {
    return this.scopesByToken.get(token) || [];
  }

  /**
   * Clear all registered data (for test cleanup)
   */
  static clear(): void {
    this.users.clear();
    this.tokens.clear();
    this.scopesByToken.clear();
  }
}

/**
 * Mock Octokit for GitHub API calls.
 *
 * Faithfully models real Octokit's hook.wrap('request', fn) contract so that
 * octokitFactory.ts's createUserOctokit — which wraps the request hook to
 * inject the authorization header — exercises its real code path in tests
 * instead of crashing on `undefined is not an object (evaluating 'octokit.hook.wrap')`.
 *
 * Contract: hook.wrap registers a request interceptor; subsequent request()
 * calls chain through all registered interceptors in registration order,
 * mirroring how @octokit/plugin-request-error / before-after-hook works.
 */
export function createMockOctokit(token: string) {
  const baseRequest = async (requestOptions: any) => ({
    data: {},
    status: 200,
    headers: {},
    url: String(requestOptions?.url ?? ''),
  });

  // Compose wrappers in registration order: each wrap replaces the previous
  // handler with fn(prevHandler, requestOptions).
  let wrappedRequest = baseRequest;

  return {
    hook: {
      wrap: (name: string, fn: (request: any, options: any) => Promise<any>) => {
        if (name === 'request') {
          const prev = wrappedRequest;
          wrappedRequest = (opts: any) => fn(prev, opts);
        }
      },
    },
    request: async (route: string, options: Record<string, unknown> = {}) => {
      const requestOptions = {
        url: route,
        headers: {} as Record<string, string>,
        ...options,
      };
      return wrappedRequest(requestOptions);
    },
    rest: {
      users: {
        getAuthenticated: async () => {
          const user = await MockGitHubApi.getUser(token);
          if (!user) {
            throw new Error('GitHub API error: 401');
          }
          return { data: user };
        },
      },
      apps: {
        getAuthenticated: async () => {
          return {
            data: {
              id: 123456,
              name: 'Test GitHub App',
              owner: { login: 'test-org' },
            },
          };
        },
        createInstallationAccessToken: async ({ installation_id }: any) => {
          return {
            data: {
              token: `ghs_mock_installation_token_${installation_id}`,
              expires_at: new Date(Date.now() + 3600000).toISOString(),
            },
          };
        },
      },
    },
  };
}
