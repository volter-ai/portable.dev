/**
 * Centralized External Services Mocks
 *
 * This module provides mock implementations for external services used across tests.
 * Import and call setupExternalServiceMocks(mock) at the top of test files (before service imports).
 *
 * Mocked Services:
 * - @slack/web-api - Slack Web API (OAuth and messaging)
 * - googleapis - Google APIs (Drive, Docs, Gmail)
 *
 * Usage:
 *   import { mock } from 'bun:test';
 *   import { setupExternalServiceMocks } from '../../setup/mocks/externalServices';
 *   setupExternalServiceMocks(mock);
 */

/**
 * Setup all external service mocks
 * Call this BEFORE importing any services that use these external APIs
 *
 * @param mockFn - The mock function from bun:test
 */
export function setupExternalServiceMocks(mockFn: any) {
  mockSlackWebApi(mockFn);
  mockGoogleApis(mockFn);
}

/**
 * Mock Slack Web API
 * Used by: AuthService (OAuth), RunConnectionService (messaging)
 *
 * @param mockFn - The mock function from bun:test
 */
export function mockSlackWebApi(mockFn: any) {
  mockFn.module('@slack/web-api', () => {
    return {
      WebClient: class MockWebClient {
        constructor(token: string) {
          this.token = token;
        }

        token: string;

        // Mock OAuth methods
        oauth = {
          v2: {
            access: mockFn(async (params: any) => {
              // Mock successful OAuth token exchange
              return {
                ok: true,
                access_token: 'xoxb-mock-slack-token-12345',
                token_type: 'bot',
                scope: 'chat:write,channels:read',
                bot_user_id: 'U12345MOCK',
                app_id: 'A12345MOCK',
                team: {
                  id: 'T12345MOCK',
                  name: 'Mock Team',
                },
                enterprise: null,
                authed_user: {
                  id: 'U12345USER',
                  scope: 'chat:write',
                  access_token: 'xoxp-mock-user-token-12345',
                  token_type: 'user',
                },
              };
            }),
          },
        };

        // Mock chat methods
        chat = {
          postMessage: mockFn(async (params: any) => {
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

        // Mock auth methods
        auth = {
          test: mockFn(async () => {
            return {
              ok: true,
              url: 'https://mock-workspace.slack.com/',
              team: 'Mock Team',
              user: 'mockuser',
              team_id: 'T12345MOCK',
              user_id: 'U12345USER',
            };
          }),
        };

        // Mock conversations methods
        conversations = {
          list: mockFn(async (params: any) => {
            return {
              ok: true,
              channels: [
                {
                  id: 'C12345',
                  name: 'general',
                  is_channel: true,
                  is_private: false,
                },
              ],
            };
          }),
        };
      },
    };
  });
}

/**
 * Mock Google APIs (Drive, Docs, Gmail)
 * Used by: RunConnectionService, GoogleDriveExecutor
 *
 * @param mockFn - The mock function from bun:test
 */
export function mockGoogleApis(mockFn: any) {
  mockFn.module('googleapis', () => {
    return {
      google: {
        auth: {
          OAuth2: class MockOAuth2 {
            constructor(clientId?: string, clientSecret?: string) {}
            setCredentials(credentials: any) {}
          },
        },
        drive: mockFn((config: any) => {
          return {
            files: {
              list: mockFn(async (params: any) => {
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
              get: mockFn(async (params: any) => {
                return {
                  data: {
                    id: params.fileId,
                    name: 'Test File.docx',
                    mimeType: 'application/vnd.google-apps.document',
                  },
                };
              }),
              create: mockFn(async (params: any) => {
                return {
                  data: {
                    id: 'newfile123',
                    name: params.requestBody?.name || 'Untitled',
                  },
                };
              }),
            },
          };
        }),
        docs: mockFn((config: any) => {
          return {
            documents: {
              create: mockFn(async (params: any) => {
                return {
                  data: {
                    documentId: 'doc123',
                    title: params.requestBody?.title || 'Untitled Document',
                  },
                };
              }),
              get: mockFn(async (params: any) => {
                return {
                  data: {
                    documentId: params.documentId,
                    title: 'Test Document',
                  },
                };
              }),
            },
          };
        }),
        gmail: mockFn((config: any) => {
          return {
            users: {
              messages: {
                send: mockFn(async (params: any) => {
                  return {
                    data: {
                      id: 'msg123',
                      threadId: 'thread123',
                      labelIds: ['SENT'],
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
}
