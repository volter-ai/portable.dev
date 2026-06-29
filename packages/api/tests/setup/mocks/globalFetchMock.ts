/**
 * Global Fetch Mock - Blocks ALL external API calls in tests
 *
 * This module intercepts the global `fetch()` function and blocks any calls
 * to external APIs (GitHub, Google, Slack, etc.) that are not properly mocked.
 *
 * PROBLEM SOLVED:
 * Many services use native `fetch()` directly to call external APIs:
 * - ConnectionsService.getGitHubAccountInfo() -> fetch('https://api.github.com/user')
 * - ConnectionsService.getGoogleAccountInfo() -> fetch('https://www.googleapis.com/...')
 * - AuthService OAuth flows -> fetch('https://github.com/login/oauth/...')
 *
 * Even when @octokit/rest is mocked, these direct fetch() calls still hit real APIs.
 * This interceptor catches them and returns mock responses.
 *
 * USAGE:
 * This is automatically installed via the test preload file.
 * No manual setup required in test files.
 */

// Store original fetch for internal use
const originalFetch = globalThis.fetch;

// ALLOWLIST of domains that ARE allowed in tests (everything else is blocked)
const ALLOWED_DOMAINS = ['localhost', '127.0.0.1', '0.0.0.0'];

// Known external API domains (for documentation only - blocking uses allowlist above)
// These have mock responses defined in MOCK_RESPONSES below
const KNOWN_EXTERNAL_APIS = [
  'api.github.com',
  'github.com',
  'api.anthropic.com',
  'www.googleapis.com',
  'oauth2.googleapis.com',
  'slack.com',
  'api.slack.com',
  'api.fly.io',
  'api.apify.com',
  'api.openai.com',
  'generativelanguage.googleapis.com', // Gemini API
  'modal.run', // Modal services (OAuth service, etc.)
  'api.clerk.com', // Clerk authentication API
];

// Type for mock response functions that can access request details
type MockResponseFn = (url: URL, init?: RequestInit) => Response | Promise<Response>;

// Mock responses for common external API patterns
const MOCK_RESPONSES: Record<string, MockResponseFn> = {
  // GitHub API mocks
  'api.github.com/user': (_url, _init) =>
    new Response(
      JSON.stringify({
        id: 12345,
        login: 'test-user',
        email: 'test@example.com',
        name: 'Test User',
        avatar_url: 'https://avatars.githubusercontent.com/u/12345',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ),
  'api.github.com/user/installations': (_url, _init) =>
    new Response(JSON.stringify({ installations: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  'api.github.com/app/installations': (url, _init) => {
    // Check if requesting access tokens (e.g., /app/installations/12345/access_tokens)
    const tokenMatch = url.pathname.match(/\/app\/installations\/(\d+)\/access_tokens/);
    if (tokenMatch) {
      // Return mock access token
      return new Response(
        JSON.stringify({
          token: 'ghs_mock_installation_token_for_testing',
          expires_at: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
          permissions: {
            contents: 'write',
            issues: 'write',
            pull_requests: 'write',
          },
          repository_selection: 'all',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check if requesting a specific installation (e.g., /app/installations/12345)
    const installMatch = url.pathname.match(/\/app\/installations\/(\d+)$/);
    if (installMatch) {
      // Return a single installation object
      const installationId = parseInt(installMatch[1], 10);
      return new Response(
        JSON.stringify({
          id: installationId,
          account: {
            login: 'test-org',
            id: 12345,
            type: 'Organization',
          },
          repository_selection: 'all',
          permissions: {
            contents: 'write',
            issues: 'write',
            pull_requests: 'write',
          },
          access_tokens_url: `https://api.github.com/app/installations/${installationId}/access_tokens`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    // Return list of installations
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
  'github.com/login/oauth/access_token': (url, init) => {
    // Parse request body to check for valid code
    let code: string | undefined;
    if (init?.body) {
      try {
        const body = JSON.parse(init.body as string);
        code = body.code;
      } catch {
        // Body might be URLSearchParams format
        const params = new URLSearchParams(init.body as string);
        code = params.get('code') || undefined;
      }
    }

    // Return error for missing or invalid codes
    if (!code || code === 'invalid-code' || code === 'undefined') {
      return new Response(
        JSON.stringify({
          error: 'bad_verification_code',
          error_description: 'The code passed is incorrect or expired.',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Valid code - return success
    return new Response(
      JSON.stringify({
        access_token: 'gho_mock_token_for_testing',
        token_type: 'bearer',
        scope: 'repo,read:org',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  },

  // Google API mocks
  'www.googleapis.com/oauth2/v2/userinfo': (_url, _init) =>
    new Response(
      JSON.stringify({
        id: '123456789',
        email: 'test@gmail.com',
        name: 'Test User',
        picture: 'https://lh3.googleusercontent.com/a/test',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ),
  'oauth2.googleapis.com/token': (url, init) => {
    // Parse request body to check for valid code
    let code: string | undefined;
    if (init?.body) {
      try {
        const body = JSON.parse(init.body as string);
        code = body.code;
      } catch {
        // Body might be URLSearchParams format
        const params = new URLSearchParams(init.body as string);
        code = params.get('code') || undefined;
      }
    }

    // Return error for missing or invalid codes (simulate real Google behavior)
    if (!code || code === 'invalid-code' || code === 'undefined') {
      return new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Bad Request',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Valid code - return success
    return new Response(
      JSON.stringify({
        access_token: 'ya29.mock_google_token',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: '1//mock_refresh_token',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  },

  // Slack API mocks
  'slack.com/api/auth.test': (_url, _init) =>
    new Response(
      JSON.stringify({
        ok: true,
        url: 'https://mock-workspace.slack.com/',
        team: 'Mock Team',
        user: 'mockuser',
        team_id: 'T12345MOCK',
        user_id: 'U12345USER',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ),
  'slack.com/api/oauth.v2.access': (url, init) => {
    // Parse request body to check for valid code
    let code: string | undefined;
    if (init?.body) {
      try {
        const body = JSON.parse(init.body as string);
        code = body.code;
      } catch {
        // Body might be URLSearchParams format
        const params = new URLSearchParams(init.body as string);
        code = params.get('code') || undefined;
      }
    }

    // Return error for missing or invalid codes
    if (!code || code === 'invalid-code' || code === 'undefined') {
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'invalid_code',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Valid code - return success
    return new Response(
      JSON.stringify({
        ok: true,
        access_token: 'xoxb-mock-slack-token',
        token_type: 'bot',
        scope: 'chat:write,channels:read',
        bot_user_id: 'U12345MOCK',
        team: { id: 'T12345MOCK', name: 'Mock Team' },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  },

  // Fly.io API mock
  'api.fly.io/graphql': (_url, _init) =>
    new Response(
      JSON.stringify({
        data: {
          viewer: {
            id: 'mock-fly-user',
            email: 'test@fly.io',
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ),

  // Apify API mock
  'api.apify.com/v2/users/me': (_url, _init) =>
    new Response(
      JSON.stringify({
        data: {
          id: 'mock-apify-user',
          username: 'testuser',
          email: 'test@apify.com',
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ),

  // Clerk API mocks
  'api.clerk.com/v1/sessions': (url, _init) => {
    // Extract session ID from path: /v1/sessions/{sessionId}
    const sessionMatch = url.pathname.match(/\/v1\/sessions\/([^/]+)/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      // Return error for invalid sessions
      if (sessionId === 'invalid-session' || !sessionId) {
        return new Response(
          JSON.stringify({
            errors: [{ message: 'Session not found', code: 'session_not_found' }],
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // Valid session
      return new Response(
        JSON.stringify({
          id: sessionId,
          user_id: 'user_mock123',
          status: 'active',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ errors: [{ message: 'Invalid path' }] }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  },
  'api.clerk.com/v1/users': (url, _init) => {
    // Extract user ID from path: /v1/users/{userId}
    const userMatch = url.pathname.match(/\/v1\/users\/([^/]+)/);
    if (userMatch) {
      const userId = userMatch[1];
      return new Response(
        JSON.stringify({
          id: userId,
          username: 'testuser',
          primary_email_address_id: 'email123',
          email_addresses: [
            {
              id: 'email123',
              email_address: 'test@example.com',
            },
          ],
          image_url: 'https://example.com/avatar.jpg',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ errors: [{ message: 'Invalid path' }] }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  // Anthropic API mocks (direct API calls, not via SDK)
  'api.anthropic.com/v1/messages': (_url, _init) =>
    new Response(
      JSON.stringify({
        id: 'msg_mock_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Mock Claude response' }],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ),

  // OAuth Service mocks (github-app service endpoints for Google/Slack OAuth delegation)
  'this-is-not-a-real-url.github-app-service-mock.modal.run/oauth/google/authorize-url': (
    _url,
    _init
  ) =>
    new Response(
      JSON.stringify({
        url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=mock&redirect_uri=mock&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive&state=mock',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ),
  'this-is-not-a-real-url.github-app-service-mock.modal.run/oauth/google/exchange-code': (
    url,
    init
  ) => {
    // Parse request body to check for valid code
    let code: string | undefined;
    if (init?.body) {
      try {
        const body = JSON.parse(init.body as string);
        code = body.code;
      } catch {
        // Ignore parse errors
      }
    }

    // Return error for missing or invalid codes
    if (!code || code === 'invalid-code' || code === 'undefined') {
      return new Response(
        JSON.stringify({
          error: 'Token exchange failed',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Valid code - return success
    return new Response(
      JSON.stringify({
        accessToken: 'ya29.mock_google_token',
        refreshToken: '1//mock_refresh_token',
        expiresIn: 3600,
        tokenType: 'Bearer',
        scope: 'https://www.googleapis.com/auth/drive',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  },
  'this-is-not-a-real-url.github-app-service-mock.modal.run/oauth/slack/authorize-url': (
    _url,
    _init
  ) =>
    new Response(
      JSON.stringify({
        url: 'https://slack.com/oauth/v2/authorize?client_id=mock&redirect_uri=mock&user_scope=channels:read,chat:write&state=mock',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ),
  'this-is-not-a-real-url.github-app-service-mock.modal.run/oauth/slack/exchange-code': (
    url,
    init
  ) => {
    // Parse request body to check for valid code
    let code: string | undefined;
    if (init?.body) {
      try {
        const body = JSON.parse(init.body as string);
        code = body.code;
      } catch {
        // Ignore parse errors
      }
    }

    // Return error for missing or invalid codes
    if (!code || code === 'invalid-code' || code === 'undefined') {
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'invalid_code',
          accessToken: '',
          tokenType: '',
          scope: '',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Valid code - return success
    return new Response(
      JSON.stringify({
        ok: true,
        accessToken: 'xoxp-mock-slack-user-token',
        tokenType: 'user',
        scope: 'channels:read,chat:write',
        team: { id: 'T12345MOCK', name: 'Mock Team' },
        authedUser: {
          id: 'U12345MOCK',
          accessToken: 'xoxp-mock-slack-user-token',
          scope: 'channels:read,chat:write',
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  },
  // GitHub OAuth service mocks
  'this-is-not-a-real-url.github-app-service-mock.modal.run/oauth/github/authorize-url': (
    _url,
    _init
  ) =>
    new Response(
      JSON.stringify({
        url: 'https://github.com/login/oauth/authorize?client_id=mock&redirect_uri=mock&scope=repo,read:org&state=mock',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ),
  'this-is-not-a-real-url.github-app-service-mock.modal.run/oauth/github/exchange-code': (
    url,
    init
  ) => {
    // Parse request body to check for valid code
    let code: string | undefined;
    if (init?.body) {
      try {
        const body = JSON.parse(init.body as string);
        code = body.code;
      } catch {
        // Ignore parse errors
      }
    }

    // Return error for missing or invalid codes
    if (!code || code === 'invalid-code' || code === 'undefined') {
      return new Response(
        JSON.stringify({
          error: 'bad_verification_code',
          error_description: 'The code passed is incorrect or expired.',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Valid code - return success
    return new Response(
      JSON.stringify({
        accessToken: 'gho_mock_token_for_testing',
        tokenType: 'bearer',
        scope: 'repo,read:org',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  },
  // GitHub App installation validation mock
  'this-is-not-a-real-url.github-app-service-mock.modal.run/installations': (url, _init) => {
    // Check if this is a validation request (e.g., /installations/12345/validate)
    const validateMatch = url.pathname.match(/\/installations\/(\d+)\/validate/);
    if (validateMatch) {
      const installationId = parseInt(validateMatch[1], 10);
      // Return successful validation
      return new Response(
        JSON.stringify({
          isValid: true,
          account: {
            login: 'test-org',
            type: 'Organization',
            avatarUrl: 'https://avatars.githubusercontent.com/u/12345',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check if this is a token request (e.g., /installations/12345/access_tokens)
    const tokenMatch = url.pathname.match(/\/installations\/(\d+)\/access_tokens/);
    if (tokenMatch) {
      return new Response(
        JSON.stringify({
          token: 'ghs_mock_installation_token_for_testing',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Default: return 404 for unrecognized installation endpoints
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

/**
 * Check if a URL is for an external API that should be blocked
 *
 * ALLOWLIST APPROACH: Block ALL external domains except explicitly allowed ones.
 * This ensures no external API calls slip through in tests.
 */
function isBlockedUrl(url: string | URL): boolean {
  try {
    const urlObj = typeof url === 'string' ? new URL(url) : url;
    const hostname = urlObj.hostname;

    // Allow localhost/internal - these are the ONLY allowed domains
    if (ALLOWED_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
      return false;
    }

    // Block EVERYTHING else - pure allowlist approach
    // No need to check BLOCKED_DOMAINS - if it's not in ALLOWED_DOMAINS, it's blocked
    return true;
  } catch {
    // If URL parsing fails, allow it (might be relative URL)
    return false;
  }
}

/**
 * Get mock response for a URL if available
 */
function getMockResponse(
  url: string | URL,
  init?: RequestInit
): Response | Promise<Response> | null {
  try {
    const urlObj = typeof url === 'string' ? new URL(url) : url;
    const urlKey = `${urlObj.hostname}${urlObj.pathname}`.replace(/\/$/, '');

    // Check exact matches first
    for (const [pattern, mockFn] of Object.entries(MOCK_RESPONSES)) {
      if (urlKey === pattern || urlKey.includes(pattern)) {
        return mockFn(urlObj, init);
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * The mock fetch function that intercepts external API calls
 */
async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

  if (isBlockedUrl(url)) {
    // Try to return a mock response
    const mockResponse = getMockResponse(url, init);
    if (mockResponse) {
      return mockResponse;
    }

    // No mock available - throw a clear error
    const errorMessage = `
================================================================================
BLOCKED EXTERNAL API CALL IN TEST
================================================================================
URL: ${url}
Method: ${init?.method || 'GET'}

This test attempted to make a real HTTP request to an external API.
This is NOT allowed in tests because:
  1. Tests should be deterministic and not depend on external services
  2. External API calls can fail, be slow, or cost money
  3. Tests should work offline

TO FIX:
  1. Mock the service that's making this call
  2. Or add a mock response for this URL in globalFetchMock.ts
  3. Or use setupAllExternalMocks(mock) at the top of your test file

If this is a legitimate test that NEEDS to call external APIs, you can
temporarily disable this check (not recommended for CI).
================================================================================
`;
    console.error(errorMessage);
    throw new Error(`BLOCKED: External API call to ${url} in test environment`);
  }

  // Allow the request (localhost, etc.)
  return originalFetch(input, init);
}

/**
 * Install the global fetch mock
 * This replaces globalThis.fetch with our interceptor
 */
export function installGlobalFetchMock(): void {
  // Only install if not already installed
  if ((globalThis.fetch as any).__isMocked) {
    return;
  }

  globalThis.fetch = mockFetch as typeof fetch;
  (globalThis.fetch as any).__isMocked = true;
  (globalThis.fetch as any).__originalFetch = originalFetch;
}

/**
 * Restore the original fetch function
 * Useful for cleanup or if a test legitimately needs to make external calls
 */
export function restoreGlobalFetch(): void {
  if ((globalThis.fetch as any).__originalFetch) {
    globalThis.fetch = (globalThis.fetch as any).__originalFetch;
  }
}

/**
 * Add a custom mock response for a URL pattern
 */
export function addMockResponse(pattern: string, responseFn: () => Response): void {
  MOCK_RESPONSES[pattern] = responseFn;
}

/**
 * Check if global fetch mock is installed
 */
export function isGlobalFetchMockInstalled(): boolean {
  return !!(globalThis.fetch as any).__isMocked;
}

// Auto-install when this module is imported
installGlobalFetchMock();
