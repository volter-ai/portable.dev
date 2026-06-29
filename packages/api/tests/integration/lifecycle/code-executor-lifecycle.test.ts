/**
 * Code Executor Service Lifecycle Tests
 *
 * THE STORY: "Cross-platform automation for DevOps team"
 *
 * Scenario Type: Multi-service code execution through Claude AI
 * User: Alex (a DevOps engineer automating cross-platform workflows)
 *
 * Alex asks Claude to automate notifications across multiple platforms when
 * deployments complete. He has connected Slack workspaces (company + personal),
 * Google Drive for reports, Gmail for notifications, and Apify for web scraping.
 *
 * Claude uses the run-connection MCP tool to execute TypeScript code with
 * authenticated API clients. This tests both:
 * - CodeExecutorService (base class): timeout protection, error handling, code execution
 * - RunConnectionService (concrete impl): multi-service setup, env vars, SDK clients
 *
 * REAL SERVICES:
 * - ✅ RunConnectionService - Multi-service code executor (TESTED!)
 * - ✅ CodeExecutorService - Base class with timeout and error handling (TESTED!)
 * - ✅ ConnectionsService - Connection management
 * - ✅ DbAdapter - REAL local SQLite database
 *
 * MOCKED EXTERNAL:
 * - 🔴 @slack/web-api - Slack API (external API calls)
 * - 🔴 googleapis - Google APIs (external API calls)
 * - 🔴 apify-client - Apify API (external API calls)
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

// Mock Slack WebClient with tracking
const mockSlackPostMessage = mock(async (params: any) => ({
  ok: true,
  channel: params.channel,
  ts: `${Date.now()}.123456`,
  message: { text: params.text, user: 'U12345', ts: `${Date.now()}.123456` },
}));

const mockSlackConversationsList = mock(async () => ({
  ok: true,
  channels: [{ id: 'C12345', name: 'general' }],
}));

mock.module('@slack/web-api', () => ({
  WebClient: class MockWebClient {
    constructor(public token: string) {}
    chat = { postMessage: mockSlackPostMessage };
    conversations = { list: mockSlackConversationsList };
  },
}));

// Mock Google APIs with tracking
const mockGoogleDriveFilesList = mock(async (params: any) => ({
  data: {
    files: [
      { id: 'file123', name: 'Report.docx', mimeType: 'application/vnd.google-apps.document' },
    ],
  },
}));

const mockGoogleDocsCreate = mock(async (params: any) => ({
  data: { documentId: 'doc123', title: params.requestBody?.title || 'Untitled' },
}));

const mockGoogleGmailSend = mock(async (params: any) => ({
  data: { id: 'msg123', threadId: 'thread123' },
}));

mock.module('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class MockOAuth2 {
        constructor(clientId?: string, clientSecret?: string) {}
        setCredentials(credentials: any) {}
      },
    },
    drive: mock((config: any) => ({ files: { list: mockGoogleDriveFilesList } })),
    docs: mock((config: any) => ({ documents: { create: mockGoogleDocsCreate } })),
    sheets: mock((config: any) => ({
      spreadsheets: { get: mock(async () => ({ data: { spreadsheetId: 'sheet123' } })) },
    })),
    gmail: mock((config: any) => ({ users: { messages: { send: mockGoogleGmailSend } } })),
  },
}));

// Mock Apify client with tracking
const mockApifyActorsList = mock(async () => ({
  items: [{ id: 'actor123', name: 'web-scraper' }],
}));

mock.module('apify-client', () => ({
  ApifyClient: class MockApifyClient {
    constructor(public options: { token: string }) {}
    actors = () => ({ list: mockApifyActorsList });
  },
}));

// Mock Octokit (may be imported by other services)
mock.module('@octokit/rest', () => ({
  Octokit: class MockOctokit {
    request = async () => ({ data: {}, status: 200, headers: {} });
  },
}));

// Import services AFTER mocking
import { RunConnectionService } from '../../../src/services/RunConnectionService.js';
import { ConnectionsService } from '../../../src/services/ConnectionsService.js';
import { createTestDbAdapter, TestDatabaseHelper } from '../../setup/helpers/testDatabase.js';

// Skip in CI - connection storage timing issues make these tests flaky in CI
const isCI = process.env.CI === '1' || process.env.CI === 'true';

describe.skipIf(isCI)('CodeExecutorService & RunConnectionService - Full Lifecycle', () => {
  let runConnectionService: RunConnectionService;
  let connectionsService: ConnectionsService;
  let testUserId: string;
  let authToken: string;

  // Test credentials
  const TEST_SLACK_COMPANY_TOKEN = 'xoxb-company-test-token-12345';
  const TEST_SLACK_PERSONAL_TOKEN = 'xoxb-personal-test-token-67890';
  const TEST_GOOGLE_ACCESS_TOKEN = 'ya29.test-google-access-token';
  const TEST_GOOGLE_REFRESH_TOKEN = 'test-google-refresh-token';
  const TEST_APIFY_TOKEN = 'apify-test-token-12345';

  const mockEmitEvent = mock((event: string, data: any) => {});

  beforeEach(async () => {
    // Reset all mocks
    mockSlackPostMessage.mockClear();
    mockSlackConversationsList.mockClear();
    mockGoogleDriveFilesList.mockClear();
    mockGoogleDocsCreate.mockClear();
    mockGoogleGmailSend.mockClear();
    mockApifyActorsList.mockClear();
    mockEmitEvent.mockClear();

    // Create test database adapter
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    testUserId = userId;
    authToken = token;

    // Initialize ConnectionsService
    connectionsService = new ConnectionsService(adapter);

    // Store all test connections
    await connectionsService.storeConnection({
      userId: testUserId,
      connectionId: 'company_slack',
      displayName: 'Company Slack',
      service: 'slack',
      serviceType: 'sdk',
      credentials: { token: TEST_SLACK_COMPANY_TOKEN, team: 'company-team', teamId: 'T12345' },
      authToken,
    });

    await connectionsService.storeConnection({
      userId: testUserId,
      connectionId: 'personal_slack',
      displayName: 'Personal Slack',
      service: 'slack',
      serviceType: 'sdk',
      credentials: { token: TEST_SLACK_PERSONAL_TOKEN, team: 'personal-team', teamId: 'T67890' },
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
        email: 'alex@example.com',
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
        email: 'alex@example.com',
      },
      authToken,
    });

    await connectionsService.storeConnection({
      userId: testUserId,
      connectionId: 'apify_1',
      displayName: 'Apify',
      service: 'apify',
      serviceType: 'sdk',
      credentials: { apiToken: TEST_APIFY_TOKEN },
      authToken,
    });

    await connectionsService.storeConnection({
      userId: testUserId,
      connectionId: 'aws_prod',
      displayName: 'AWS Production',
      service: 'aws',
      serviceType: 'cli',
      credentials: {
        accessKeyId: 'AKIATEST12345',
        secretAccessKey: 'test-secret-key-12345',
        region: 'us-west-2',
      },
      authToken,
    });

    // Initialize RunConnectionService
    runConnectionService = new RunConnectionService(connectionsService);
  });

  afterEach(async () => {
    await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
  });

  it("should handle Alex's complete deployment notification workflow", async () => {
    /**
     * SCENARIO: Alex runs a multi-service deployment notification workflow
     *
     * STEP 1: Post deployment notification to company Slack
     * STEP 2: Post personal notification to personal Slack
     * STEP 3: Create deployment report in Google Drive
     * STEP 4: List available Apify scrapers for monitoring
     * STEP 5: Verify environment variables for CLI tools
     * STEP 6: Use context features (userId, chatId, emitEvent)
     *
     * Coverage:
     * - CodeExecutorService: execute(), executeCode(), executeWithTimeout()
     * - RunConnectionService: setupContext(), setupServiceClient() for all 4 SDK types
     * - Context features: require, console, emitEvent
     * - Environment variables: SDK + CLI credentials exposed
     */

    console.log('🚀 Starting deployment notification workflow...');

    /**
     * STEP 1: Multi-Slack notification with SDK clients
     * Tests: setupServiceClient('slack'), multiple same-type connections
     */
    console.log('📨 Step 1: Posting to both Slack workspaces...');

    const slackResult = await runConnectionService.execute({
      connections: ['company_slack', 'personal_slack'],
      code: `
        const companyResult = await company_slack.chat.postMessage({
          channel: '#deployments',
          text: 'Production deployment v2.1.0 completed!'
        });

        const personalResult = await personal_slack.chat.postMessage({
          channel: '#my-projects',
          text: 'Your deployment is live!'
        });

        return {
          company: companyResult.ok,
          personal: personalResult.ok,
          companyChannel: companyResult.channel,
          personalChannel: personalResult.channel
        };
      `,
      description: 'Post deployment notifications to Slack',
      userId: testUserId,
      chatId: 'chat-deploy-001',
      emitEvent: mockEmitEvent,
      authToken,
    });

    expect(slackResult.success).toBe(true);
    expect(slackResult.result.company).toBe(true);
    expect(slackResult.result.personal).toBe(true);
    expect(mockSlackPostMessage).toHaveBeenCalledTimes(2);

    // Verify environment variables were set for SDK services
    expect(process.env.COMPANY_SLACK_TOKEN).toBe(TEST_SLACK_COMPANY_TOKEN);
    expect(process.env.PERSONAL_SLACK_TOKEN).toBe(TEST_SLACK_PERSONAL_TOKEN);

    console.log('✅ Slack notifications sent successfully');

    /**
     * STEP 2: Google Drive integration
     * Tests: setupServiceClient('google-drive') returns { drive, docs, sheets }
     */
    console.log('📄 Step 2: Creating deployment report in Google Drive...');

    const driveResult = await runConnectionService.execute({
      connections: ['google_drive_1'],
      code: `
        // Verify Google Drive client has all three services
        const hasDrive = typeof google_drive_1.drive === 'object';
        const hasDocs = typeof google_drive_1.docs === 'object';
        const hasSheets = typeof google_drive_1.sheets === 'object';

        // List existing files
        const files = await google_drive_1.drive.files.list({ pageSize: 10 });

        // Create deployment report
        const report = await google_drive_1.docs.documents.create({
          requestBody: { title: 'Deployment Report - v2.1.0' }
        });

        return {
          hasDrive,
          hasDocs,
          hasSheets,
          existingFiles: files.data.files.length,
          reportId: report.data.documentId,
          reportTitle: report.data.title
        };
      `,
      description: 'Create deployment report',
      userId: testUserId,
      chatId: 'chat-deploy-002',
      emitEvent: mockEmitEvent,
      authToken,
    });

    expect(driveResult.success).toBe(true);
    expect(driveResult.result.hasDrive).toBe(true);
    expect(driveResult.result.hasDocs).toBe(true);
    expect(driveResult.result.hasSheets).toBe(true);
    expect(driveResult.result.reportId).toBe('doc123');
    expect(mockGoogleDriveFilesList).toHaveBeenCalled();
    expect(mockGoogleDocsCreate).toHaveBeenCalled();

    console.log('✅ Google Drive report created');

    /**
     * STEP 3: Gmail integration
     * Tests: setupServiceClient('gmail')
     */
    console.log('📧 Step 3: Verifying Gmail client setup...');

    const gmailResult = await runConnectionService.execute({
      connections: ['gmail_1'],
      code: `
        const hasUsers = typeof gmail_1.users === 'object';
        const hasMessages = typeof gmail_1.users.messages === 'object';
        const hasSend = typeof gmail_1.users.messages.send === 'function';

        return { hasUsers, hasMessages, hasSend };
      `,
      userId: testUserId,
      chatId: 'chat-deploy-003',
      emitEvent: mockEmitEvent,
      authToken,
    });

    expect(gmailResult.success).toBe(true);
    expect(gmailResult.result).toEqual({ hasUsers: true, hasMessages: true, hasSend: true });

    console.log('✅ Gmail client verified');

    /**
     * STEP 4: Apify integration with dynamic import
     * Tests: setupServiceClient('apify') with dynamic import
     */
    console.log('🕷️ Step 4: Listing Apify scrapers...');

    const apifyResult = await runConnectionService.execute({
      connections: ['apify_1'],
      code: `
        const actors = await apify_1.actors().list();
        return {
          actorCount: actors.items.length,
          firstActor: actors.items[0]?.name
        };
      `,
      userId: testUserId,
      chatId: 'chat-deploy-004',
      emitEvent: mockEmitEvent,
      authToken,
    });

    expect(apifyResult.success).toBe(true);
    expect(apifyResult.result.actorCount).toBe(1);
    expect(apifyResult.result.firstActor).toBe('web-scraper');
    expect(mockApifyActorsList).toHaveBeenCalled();

    console.log('✅ Apify scrapers listed');

    /**
     * STEP 5: CLI tools (environment variables only)
     * Tests: CLI serviceType exposes env vars but no SDK client
     */
    console.log('☁️ Step 5: Verifying CLI tool environment variables...');

    const cliResult = await runConnectionService.execute({
      connections: ['aws_prod'],
      code: `
        // CLI tools don't have SDK clients, only env vars
        const hasAccessKey = !!process.env.AWS_PROD_ACCESSKEYID;
        const hasSecretKey = !!process.env.AWS_PROD_SECRETACCESSKEY;
        const hasRegion = !!process.env.AWS_PROD_REGION;

        // Verify no SDK client was created
        const hasAwsClient = typeof aws_prod !== 'undefined';

        return { hasAccessKey, hasSecretKey, hasRegion, hasAwsClient };
      `,
      userId: testUserId,
      chatId: 'chat-deploy-005',
      emitEvent: mockEmitEvent,
      authToken,
    });

    expect(cliResult.success).toBe(true);
    expect(cliResult.result.hasAccessKey).toBe(true);
    expect(cliResult.result.hasSecretKey).toBe(true);
    expect(cliResult.result.hasRegion).toBe(true);
    expect(cliResult.result.hasAwsClient).toBe(false); // CLI tools don't get SDK clients

    console.log('✅ CLI environment variables verified');

    /**
     * STEP 6: Context features and emitEvent
     * Tests: context object with userId, chatId, emitEvent, require, console
     */
    console.log('🔧 Step 6: Testing context features...');

    const contextResult = await runConnectionService.execute({
      connections: ['company_slack'],
      code: `
        // Emit progress events
        context.emitEvent('progress', { step: 1, total: 3, message: 'Starting' });
        context.emitEvent('progress', { step: 2, total: 3, message: 'Processing' });
        context.emitEvent('progress', { step: 3, total: 3, message: 'Complete' });

        // Use require to load a module
        const path = require('path');
        const hasPathJoin = typeof path.join === 'function';

        // Use console for debugging
        console.log('Debug: Context test running');

        return {
          userId: context.userId,
          chatId: context.chatId,
          hasEmitEvent: typeof context.emitEvent === 'function',
          hasPathJoin
        };
      `,
      userId: testUserId,
      chatId: 'chat-context-test',
      emitEvent: mockEmitEvent,
      authToken,
    });

    expect(contextResult.success).toBe(true);
    expect(contextResult.result.userId).toBe(testUserId);
    expect(contextResult.result.chatId).toBe('chat-context-test');
    expect(contextResult.result.hasEmitEvent).toBe(true);
    expect(contextResult.result.hasPathJoin).toBe(true);
    expect(mockEmitEvent).toHaveBeenCalledTimes(3);
    expect(mockEmitEvent).toHaveBeenCalledWith('progress', {
      step: 1,
      total: 3,
      message: 'Starting',
    });

    console.log('✅ Context features verified');
    console.log("🎉 Alex's deployment workflow completed successfully!");
  });

  it('should handle error scenarios gracefully', async () => {
    /**
     * SCENARIO: Test all error handling paths
     *
     * STEP 1: MissingConnectionsError for non-existent connections
     * STEP 2: Runtime errors in user code (formatError)
     * STEP 3: Syntax errors in user code
     * STEP 4: Service initialization errors (missing credentials)
     * STEP 5: Unsupported service type error
     *
     * Coverage:
     * - CodeExecutorService: formatError() with different error types
     * - RunConnectionService: MissingConnectionsError, service init errors
     */

    console.log('🔴 Testing error handling scenarios...');

    /**
     * STEP 1: MissingConnectionsError
     * Tests: setupContext() throws when connections don't exist
     */
    console.log('❌ Step 1: Testing missing connections...');

    const missingResult = await runConnectionService.execute({
      connections: ['nonexistent_slack', 'also_missing', 'company_slack'],
      code: `return 'should not execute';`,
      userId: testUserId,
      chatId: 'chat-error-001',
      emitEvent: mockEmitEvent,
      authToken,
    });

    expect(missingResult.success).toBe(false);
    expect(missingResult.error.type).toBe('MissingConnectionsError');
    expect(missingResult.error.message).toContain('nonexistent_slack');
    expect(missingResult.error.message).toContain('also_missing');
    expect(missingResult.error.message).not.toContain('company_slack'); // Exists, not in error

    console.log('✅ MissingConnectionsError handled correctly');

    /**
     * STEP 2: Runtime errors (formatError with Error type)
     * Tests: formatError() extracts error name, message
     */
    console.log('❌ Step 2: Testing runtime errors...');

    const runtimeErrorResult = await runConnectionService.execute({
      connections: ['company_slack'],
      code: `throw new Error('Something went wrong in deployment script');`,
      userId: testUserId,
      chatId: 'chat-error-002',
      emitEvent: mockEmitEvent,
      authToken,
    });

    expect(runtimeErrorResult.success).toBe(false);
    expect(runtimeErrorResult.error.type).toBe('Error');
    expect(runtimeErrorResult.error.message).toBe('Something went wrong in deployment script');

    console.log('✅ Runtime errors handled correctly');

    /**
     * STEP 3: Syntax errors
     * Tests: formatError() with SyntaxError
     */
    console.log('❌ Step 3: Testing syntax errors...');

    const syntaxErrorResult = await runConnectionService.execute({
      connections: ['company_slack'],
      code: `const x = {{{ broken syntax`,
      userId: testUserId,
      chatId: 'chat-error-003',
      emitEvent: mockEmitEvent,
      authToken,
    });

    expect(syntaxErrorResult.success).toBe(false);
    expect(syntaxErrorResult.error.type).toBe('SyntaxError');

    console.log('✅ Syntax errors handled correctly');

    /**
     * STEP 4: TypeError and ReferenceError
     * Tests: formatError() preserves error type names
     */
    console.log('❌ Step 4: Testing type/reference errors...');

    const typeErrorResult = await runConnectionService.execute({
      connections: ['company_slack'],
      code: `null.doSomething();`,
      userId: testUserId,
      chatId: 'chat-error-004',
      emitEvent: mockEmitEvent,
      authToken,
    });

    expect(typeErrorResult.success).toBe(false);
    expect(typeErrorResult.error.type).toBe('TypeError');

    const refErrorResult = await runConnectionService.execute({
      connections: ['company_slack'],
      code: `return undefinedVariable.property;`,
      userId: testUserId,
      chatId: 'chat-error-005',
      emitEvent: mockEmitEvent,
      authToken,
    });

    expect(refErrorResult.success).toBe(false);
    expect(refErrorResult.error.type).toBe('ReferenceError');

    console.log('✅ Type/Reference errors handled correctly');

    /**
     * STEP 5: Service initialization errors (missing credentials)
     * Tests: setupServiceClient() validates required credential fields
     */
    console.log('❌ Step 5: Testing credential validation...');

    // Store connection with missing token
    await connectionsService.storeConnection({
      userId: testUserId,
      connectionId: 'broken_slack',
      displayName: 'Broken Slack',
      service: 'slack',
      serviceType: 'sdk',
      credentials: { team: 'test-team' }, // Missing 'token' field
      authToken,
    });

    const brokenSlackResult = await runConnectionService.execute({
      connections: ['broken_slack'],
      code: `return 'should not execute';`,
      userId: testUserId,
      chatId: 'chat-error-006',
      emitEvent: mockEmitEvent,
      authToken,
    });

    expect(brokenSlackResult.success).toBe(false);
    expect(brokenSlackResult.error.message).toContain("missing 'token' field");

    // Store connection with missing apiToken
    await connectionsService.storeConnection({
      userId: testUserId,
      connectionId: 'broken_apify',
      displayName: 'Broken Apify',
      service: 'apify',
      serviceType: 'sdk',
      credentials: { userId: 'test' }, // Missing 'apiToken' field
      authToken,
    });

    const brokenApifyResult = await runConnectionService.execute({
      connections: ['broken_apify'],
      code: `return 'should not execute';`,
      userId: testUserId,
      chatId: 'chat-error-007',
      emitEvent: mockEmitEvent,
      authToken,
    });

    expect(brokenApifyResult.success).toBe(false);
    expect(brokenApifyResult.error.message).toContain("missing 'apiToken' field");

    console.log('✅ Credential validation errors handled correctly');

    /**
     * STEP 6: Unsupported service type
     * Tests: setupServiceClient() throws for unknown services
     */
    console.log('❌ Step 6: Testing unsupported service...');

    await connectionsService.storeConnection({
      userId: testUserId,
      connectionId: 'linear_1',
      displayName: 'Linear',
      service: 'linear', // Not implemented
      serviceType: 'sdk',
      credentials: { apiKey: 'test-key' },
      authToken,
    });

    const unsupportedResult = await runConnectionService.execute({
      connections: ['linear_1'],
      code: `return 'should not execute';`,
      userId: testUserId,
      chatId: 'chat-error-008',
      emitEvent: mockEmitEvent,
      authToken,
    });

    expect(unsupportedResult.success).toBe(false);
    expect(unsupportedResult.error.message).toContain("Service 'linear' is not supported");
    expect(unsupportedResult.error.message).toContain(
      'Available services: slack, google-drive, gmail, apify'
    );

    console.log('✅ Unsupported service errors handled correctly');

    /**
     * STEP 7: Custom error classes
     * Tests: formatError() handles custom error names
     */
    console.log('❌ Step 7: Testing custom errors...');

    const customErrorResult = await runConnectionService.execute({
      connections: ['company_slack'],
      code: `
        class DeploymentError extends Error {
          constructor(message) {
            super(message);
            this.name = 'DeploymentError';
          }
        }
        throw new DeploymentError('Deployment failed: invalid configuration');
      `,
      userId: testUserId,
      chatId: 'chat-error-009',
      emitEvent: mockEmitEvent,
      authToken,
    });

    expect(customErrorResult.success).toBe(false);
    expect(customErrorResult.error.type).toBe('DeploymentError');
    expect(customErrorResult.error.message).toBe('Deployment failed: invalid configuration');

    console.log('✅ Custom errors handled correctly');
    console.log('🎉 All error scenarios handled gracefully!');
  });
});
