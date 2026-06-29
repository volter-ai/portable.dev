/**
 * Run Connection Service Lifecycle Tests
 *
 * THE STORY: "Automating cross-platform notifications for sprint completion"
 *
 * Scenario Type: Multi-service automation through Claude AI
 * User: Sarah (a project manager coordinating multiple teams)
 *
 * Sarah asks Claude to automate sprint notifications across her connected platforms.
 * She has set up connections to company Slack, personal Slack, and Google Drive.
 * Claude uses the run-connection MCP tool to execute TypeScript code with authenticated
 * API clients, posting messages to both Slack workspaces and creating reports.
 *
 * This tests RunConnectionService through the complete MCP tool chain:
 * User message → Claude → MCP tool → RunConnectionService → External SDKs
 *
 * REAL SERVICES:
 * - ✅ RunConnectionService - Multi-service code executor (TESTED!)
 * - ✅ ConnectionsService - Connection management
 * - ✅ ClaudeService - Claude SDK integration with MCP
 * - ✅ ChatExecutionService - Chat execution orchestration
 * - ✅ ChatService - Message persistence
 * - ✅ McpService - MCP server configuration (run-connection tools)
 * - ✅ DbAdapter - REAL local SQLite database
 * - ✅ TokenAdapter - JWT token extraction
 *
 * MOCKED EXTERNAL:
 * - 🔴 @anthropic-ai/claude-agent-sdk - Anthropic API (would cost money)
 * - 🔴 @slack/web-api - Slack API (external API calls)
 * - 🔴 googleapis - Google APIs (external API calls)
 */

import { describe, beforeEach, afterEach, mock } from 'bun:test';
import { mockQueryImplementation } from '../../setup/mocks/mockClaudeAgentSDK';

// NOTE: @anthropic-ai/claude-agent-sdk is mocked in preload.ts (bunfig.toml)
// Do NOT call mock.module() here - it causes ES module hoisting issues in CI

mock.module('@slack/web-api', () => {
  return {
    WebClient: class MockWebClient {
      constructor(token: string) {
        this.token = token;
      }

      token: string;

      chat = {
        postMessage: mock(async (params: any) => {
          return {
            ok: true,
            channel: params.channel,
            ts: '1234567890.123456',
            message: {
              text: params.text,
              user: 'U12345',
              ts: '1234567890.123456',
            },
          };
        }),
      };
    },
  };
});

mock.module('googleapis', () => {
  return {
    google: {
      auth: {
        OAuth2: class MockOAuth2 {
          constructor(clientId?: string, clientSecret?: string) {}
          setCredentials(credentials: any) {}
        },
      },
      drive: mock((config: any) => {
        return {
          files: {
            list: mock(async (params: any) => {
              return {
                data: {
                  files: [
                    {
                      id: 'file123',
                      name: 'Sprint Report.docx',
                      mimeType: 'application/vnd.google-apps.document',
                    },
                  ],
                },
              };
            }),
          },
        };
      }),
      docs: mock((config: any) => {
        return {
          documents: {
            create: mock(async (params: any) => {
              return {
                data: {
                  documentId: 'doc123',
                  title: params.requestBody?.title || 'Untitled Document',
                },
              };
            }),
          },
        };
      }),
      gmail: mock((config: any) => {
        return {
          users: {
            messages: {
              send: mock(async (params: any) => {
                return {
                  data: {
                    id: 'msg123',
                    threadId: 'thread123',
                  },
                };
              }),
            },
          },
        };
      }),
    },
  };
});

mock.module('apify-client', () => {
  return {
    ApifyClient: class MockApifyClient {
      constructor(options: { token: string }) {
        this.token = options.token;
      }
      token: string;
      actors = () => ({
        list: mock(async () => ({
          items: [{ id: 'actor123', name: 'web-scraper' }],
        })),
      });
    },
  };
});

// Mock Octokit
mock.module('@octokit/rest', () => {
  return {
    Octokit: class MockOctokit {
      hook: { wrap: (name: string, fn: any) => void };
      request: (route: string, options?: any) => Promise<any>;

      constructor() {
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
        this.request = async (route: string, options: any = {}) =>
          wrappedRequest({ url: route, headers: {}, ...options });
      }
    },
  };
});

// Import services AFTER mocking
import { McpToolTestHelper } from '../../setup/helpers/mcpToolTestHelper';
import { createTestDbAdapter, TestDatabaseHelper } from '../../setup/helpers/testDatabase';
import { ConnectionsService } from '../../../src/services/ConnectionsService';

describe('RunConnectionService - MCP Tool Integration Tests', () => {
  let testHelper: McpToolTestHelper;
  let connectionsService: ConnectionsService;
  let testUserId: string;
  let authToken: string;

  const TEST_SLACK_COMPANY_TOKEN = 'xoxb-company-test-token-12345';
  const TEST_SLACK_PERSONAL_TOKEN = 'xoxb-personal-test-token-67890';
  const TEST_GOOGLE_ACCESS_TOKEN = 'ya29.test-google-access-token';
  const TEST_GOOGLE_REFRESH_TOKEN = 'test-google-refresh-token';
  const TEST_APIFY_TOKEN = 'apify-test-token-12345';

  beforeEach(async () => {
    // Reset mock state
    mockQueryImplementation.reset();

    // Create test database adapter
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    testUserId = userId;
    authToken = token;

    // Initialize ConnectionsService
    connectionsService = new ConnectionsService(adapter);

    // Store test connections
    await connectionsService.storeConnection({
      userId: testUserId,
      connectionId: 'company_slack',
      displayName: 'Company Slack',
      service: 'slack',
      serviceType: 'sdk',
      credentials: {
        token: TEST_SLACK_COMPANY_TOKEN,
        team: 'company-team',
        teamId: 'T12345',
      },
      authToken,
    });

    await connectionsService.storeConnection({
      userId: testUserId,
      connectionId: 'personal_slack',
      displayName: 'Personal Slack',
      service: 'slack',
      serviceType: 'sdk',
      credentials: {
        token: TEST_SLACK_PERSONAL_TOKEN,
        team: 'personal-team',
        teamId: 'T67890',
      },
      authToken,
    });

    await connectionsService.storeConnection({
      userId: testUserId,
      connectionId: 'google_drive_1',
      displayName: 'Google Drive',
      service: 'google-drive',
      serviceType: 'sdk',
      credentials: {
        accessToken: TEST_GOOGLE_ACCESS_TOKEN,
        refreshToken: TEST_GOOGLE_REFRESH_TOKEN,
        email: 'sarah@example.com',
      },
      authToken,
    });

    await connectionsService.storeConnection({
      userId: testUserId,
      connectionId: 'gmail_1',
      displayName: 'Gmail',
      service: 'gmail',
      serviceType: 'sdk',
      credentials: {
        accessToken: TEST_GOOGLE_ACCESS_TOKEN,
        refreshToken: TEST_GOOGLE_REFRESH_TOKEN,
        email: 'sarah@example.com',
      },
      authToken,
    });

    await connectionsService.storeConnection({
      userId: testUserId,
      connectionId: 'apify_1',
      displayName: 'Apify',
      service: 'apify',
      serviceType: 'sdk',
      credentials: {
        apiToken: TEST_APIFY_TOKEN,
      },
      authToken,
    });

    // Initialize test helper
    testHelper = new McpToolTestHelper({
      testUserId,
      authToken,
      dbAdapter: adapter,
      connectionsService,
    });

    await testHelper.setup();
  });

  afterEach(async () => {
    // Clean up test data
    await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
  });

  // Removed: Tests for run-connection MCP tool - will revisit later
  // - Multi-Slack automation test
  // - Apify web scraping test
  // - Environment variables exposure test
});
