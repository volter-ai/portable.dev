/**
 * Setup All External Service Mocks - COMPREHENSIVE
 *
 * USAGE: Import and call at the TOP of test files, BEFORE importing services
 *
 * @example
 * import { setupAllExternalMocks } from '../../setup/mocks/setupAllExternalMocks';
 * import { mock } from 'bun:test';
 *
 * setupAllExternalMocks(mock);
 *
 * // NOW import services
 * import { createTestServer } from '../../setup/helpers/testServer';
 *
 * IMPORTANT: This mocks ALL external APIs. Tests using this MUST NOT call
 * individual mock.module() for these services again (causes conflicts).
 *
 * MOCKING STRATEGY (Defense in Depth):
 * 1. globalFetchMock - Intercepts native fetch() calls to external APIs
 *    - Catches ConnectionsService.getGitHubAccountInfo() -> fetch('https://api.github.com/user')
 *    - Catches AuthService OAuth flows -> fetch('https://github.com/login/oauth/...')
 *    - Returns mock responses for common patterns
 *
 * 2. mock.module() - Mocks npm packages that make API calls
 *    - @octokit/rest (GitHub REST client)
 *    - @anthropic-ai/claude-agent-sdk (Claude API)
 *    - googleapis (Google Drive, Gmail, etc.)
 *    - @slack/web-api (Slack API)
 *    - etc.
 */

// Import global fetch mock (also installed via preload, but this ensures it's active)
import './globalFetchMock';
// Import the shared mock for claude-agent-sdk so all tests use the same instance
import { query as mockQuery } from './mockClaudeAgentSDK';

export function setupAllExternalMocks(mockFn: any) {
  // Re-use the comprehensive external services mocks
  const { setupExternalServiceMocks } = require('./externalServices');
  setupExternalServiceMocks(mockFn);

  // Also mock Octokit (GitHub API) and Claude SDK by default
  // Tests can override these if they need custom behavior

  mockFn.module('@octokit/rest', () => {
    // Create the mock REST API structure
    const mockRestApi = {
      users: {
        getAuthenticated: async () => ({
          data: {
            id: 12345,
            login: 'test-user',
            email: 'test@example.com',
            name: 'Test User',
            avatar_url: 'https://avatars.githubusercontent.com/u/12345',
          },
        }),
        listEmailsForAuthenticatedUser: async () => ({
          data: [
            {
              email: 'test@example.com',
              primary: true,
              verified: true,
              visibility: 'private',
            },
          ],
        }),
      },
      repos: {
        get: async (_params: { owner: string; repo: string }) => ({
          data: {
            id: 1,
            name: 'test-repo',
            full_name: 'test-user/test-repo',
            private: false,
          },
        }),
        listForAuthenticatedUser: async () => ({
          data: [],
        }),
      },
      apps: {
        getAuthenticated: async () => ({
          data: {
            id: 1,
            slug: 'test-app',
            name: 'Test App',
          },
        }),
      },
    };

    return {
      Octokit: class MockOctokit {
        rest: typeof mockRestApi;
        hook: { wrap: (name: string, fn: any) => void };
        request: (route: string, options?: Record<string, unknown>) => Promise<any>;

        constructor(_options?: { auth?: string }) {
          this.rest = mockRestApi;

          // Wire hook.wrap so octokitFactory.createUserOctokit can register its
          // request interceptor (#1358 regression fix — hook.wrap must route
          // subsequent request() calls through the registered wrapper, not no-op it).
          const baseRequest = async (_opts: any) => ({ data: {}, status: 200, headers: {} });
          let wrappedRequest = baseRequest;
          this.hook = {
            wrap: (name: string, fn: any) => {
              if (name === 'request') {
                const prev = wrappedRequest;
                wrappedRequest = (opts: any) => fn(prev, opts);
              }
            },
          };
          this.request = async (route: string, options: Record<string, unknown> = {}) =>
            wrappedRequest({ url: route, headers: {}, ...options });
        }
      },
    };
  });

  mockFn.module('@anthropic-ai/claude-agent-sdk', () => {
    return {
      // Use shared mock from mockClaudeAgentSDK.ts so all tests share the same instance
      // This allows tests to use mockQueryImplementation.getCallCount(), getLastOptions(), etc.
      query: mockQuery,
      // Mock tool() function used by MCP servers
      tool: (schema: any) => schema,
      // Mock createSdkMcpServer() for MCP server creation
      createSdkMcpServer: (config: any) => ({
        ...config,
        // Return a mock MCP server object
        close: () => {},
      }),
    };
  });

  mockFn.module('@clerk/backend', () => {
    // Mock Clerk client that createClerkClient returns
    const mockClerkClient = {
      sessions: {
        getSession: async (sessionId: string) => {
          // Return error for invalid session IDs
          if (sessionId === 'invalid-session' || !sessionId) {
            throw new Error('Session not found');
          }
          return {
            id: sessionId,
            userId: 'user_mock123',
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        },
      },
      users: {
        getUser: async (userId: string) => {
          return {
            id: userId,
            username: 'testuser',
            primaryEmailAddress: {
              emailAddress: 'test@example.com',
            },
            emailAddresses: [{ emailAddress: 'test@example.com', id: 'email123' }],
            primaryEmailAddressId: 'email123',
            imageUrl: 'https://example.com/avatar.jpg',
          };
        },
      },
    };

    return {
      // createClerkClient is what auth.routes.ts imports and uses
      createClerkClient: (_options?: { secretKey?: string }) => mockClerkClient,
      // Also export clerkClient for backward compatibility
      clerkClient: mockClerkClient,
    };
  });

  mockFn.module('resend', () => {
    return {
      Resend: class MockResend {
        constructor(apiKey: string) {}
        emails = {
          send: async (params: any) => {
            return {
              id: 'mock-email-id',
              from: params.from,
              to: params.to,
              subject: params.subject,
            };
          },
        };
      },
    };
  });

  mockFn.module('apify-client', () => {
    return {
      ApifyClient: class MockApifyClient {
        constructor(options?: any) {}
        actor(actorId: string) {
          return {
            call: async (input: any) => ({ defaultDatasetId: 'mock-dataset-123' }),
          };
        }
        dataset(datasetId: string) {
          return {
            listItems: async () => ({
              items: [{ text: 'Mock scraped content', url: 'https://example.com' }],
            }),
          };
        }
      },
    };
  });
}
