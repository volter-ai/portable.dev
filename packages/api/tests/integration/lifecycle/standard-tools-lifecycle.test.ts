/**
 * Standard Tools Lifecycle Tests
 *
 * THE STORY: "Developer debugging a web application"
 *
 * Marcus is debugging a login flow bug in his React + Express app.
 * These tests follow his realistic workflow from setup to resolution.
 *
 * REAL SERVICES:
 * - ✅ TunnelService logic (mocked external calls)
 * - ✅ TokenAdapter (JWT token extraction)
 * - ✅ File system operations
 *
 * MOCKED EXTERNAL:
 * - 🔴 Cloudflare Quick Tunnels (createLocalTunnel)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';

import { createTunnelTool } from '../../../src/tools/standard/create-tunnel';
import { displayVideoTool } from '../../../src/tools/standard/display-video';
import { linkIssueToChatTool } from '../../../src/tools/standard/link-issue-to-chat';
import { requestUserSecretsTool } from '../../../src/tools/standard/request-user-secrets';
import { requestUserConnectionTool } from '../../../src/tools/standard/request-user-connection';
import { showTunnelTool } from '../../../src/tools/standard/show-tunnel';
import { portableExecuteTool } from '../../../src/tools/standard/portable-execute';
import type { ToolExecutionContext } from '../../../src/tools/types';

// =============================================================================
// MOCK SERVICES
// =============================================================================

class MockTunnelService {
  private tunnels = new Map<number, { url: string; name?: string; main?: boolean }>();
  private activePorts = new Set<number>();

  async createLocalTunnel(
    port: number,
    _userId: string,
    _chatId?: string,
    _repoPath?: string,
    name?: string,
    _description?: string,
    main?: boolean
  ) {
    const url = `https://mock-tunnel-${port}.trycloudflare.com`;
    this.tunnels.set(port, { url, name, main });
    return url;
  }

  async checkPortHealth(port: number) {
    return this.activePorts.has(port)
      ? { healthy: true, statusCode: 200 }
      : { healthy: false, error: 'ECONNREFUSED' };
  }

  setPortActive(port: number, active: boolean) {
    active ? this.activePorts.add(port) : this.activePorts.delete(port);
  }

  getTunnels() {
    return this.tunnels;
  }

  getUserTunnels(_userId: string) {
    return Array.from(this.tunnels.entries()).map(([port, data]) => ({
      port,
      url: data.url,
      name: data.name,
    }));
  }
}

class MockWebSocket {
  sentMessages: any[] = [];
  send(msg: string) {
    this.sentMessages.push(JSON.parse(msg));
  }
  getMessagesByType(type: string) {
    return this.sentMessages.filter((m) => m.type === type);
  }
  reset() {
    this.sentMessages = [];
  }
}

class MockChatService {
  private chats = new Map<string, any>();
  private messages = new Map<string, any[]>();
  dbAdapter = {
    getLastChatActivityByRepo: async () => new Map([['local/my-app', Date.now().toString()]]),
  };

  async getChats(userId: string, _authToken: string) {
    return Array.from(this.chats.values()).filter((c) => c.user_id === userId);
  }

  async getChat(chatId: string, _userId: string, _authToken: string) {
    return this.chats.get(chatId);
  }

  async saveChat(params: any) {
    this.chats.set(params.chatId, {
      id: params.chatId,
      user_id: params.userId,
      title: params.title,
      status: params.status,
      repo_path: params.repoPath,
    });
    return true;
  }

  async bufferMessage(
    _userId: string,
    chatId: string,
    type: string,
    data: any,
    _authToken: string
  ) {
    const msgs = this.messages.get(chatId) || [];
    msgs.push({ type, data, timestamp: Date.now() });
    this.messages.set(chatId, msgs);
  }

  async getMessages(chatId: string, _authToken: string) {
    return this.messages.get(chatId) || [];
  }

  async archiveChat(chatId: string, _userId: string, archived: boolean, _authToken: string) {
    const chat = this.chats.get(chatId);
    if (chat) chat.archived = archived;
  }

  async updateChatStatus(chatId: string, _userId: string, status: string, _authToken: string) {
    const chat = this.chats.get(chatId);
    if (chat) chat.status = status;
  }

  addChat(chatId: string, chat: any) {
    this.chats.set(chatId, chat);
  }
}

class MockSecretsService {
  private secrets = new Map<string, { key: string; value: string; source: string }>();

  async getSecrets(_userId: string) {
    return Array.from(this.secrets.values());
  }

  async saveSecretToVault(_userId: string, key: string, value: string, source: string) {
    this.secrets.set(key, { key, value, source });
  }

  addSecret(key: string, value: string, source: string) {
    this.secrets.set(key, { key, value, source });
  }
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe('Standard Tools - Realistic Developer Workflows', () => {
  let mockTunnelService: MockTunnelService;
  let mockWs: MockWebSocket;
  let mockChatService: MockChatService;
  let mockSecretsService: MockSecretsService;
  let testRepoPath: string;
  let testImagePath: string;
  let testVideoPath: string;
  const TEST_USER_ID = 'marcus@example.com';
  const TEST_CHAT_ID = 'chat-login-bug-investigation';

  beforeEach(async () => {
    mockTunnelService = new MockTunnelService();
    mockWs = new MockWebSocket();
    mockChatService = new MockChatService();
    mockSecretsService = new MockSecretsService();

    testRepoPath = `/tmp/test-standard-tools-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.mkdir(testRepoPath, { recursive: true });

    // Create test image (1x1 PNG)
    testImagePath = path.join(testRepoPath, 'error-screenshot.png');
    const minimalPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
      0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x60,
      0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x05, 0x00, 0x01, 0xa5, 0xf6, 0x45, 0x40, 0x00, 0x00,
      0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    await fs.writeFile(testImagePath, minimalPng);

    // Create test video file
    testVideoPath = path.join(testRepoPath, 'login-flow-recording.webm');
    await fs.writeFile(testVideoPath, Buffer.from('mock video content'));

    // Set up initial chat state
    mockChatService.addChat(TEST_CHAT_ID, {
      id: TEST_CHAT_ID,
      user_id: TEST_USER_ID,
      title: 'Investigating login bug #42',
      status: 'running',
      repo_path: testRepoPath,
    });
  });

  afterEach(async () => {
    try {
      await fs.rm(testRepoPath, { recursive: true, force: true });
    } catch {}
  });

  function createContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
    return {
      userId: TEST_USER_ID,
      chatId: TEST_CHAT_ID,
      repoPath: testRepoPath,
      emitEvent: (event, data) => mockWs.send(JSON.stringify({ type: event, ...data })),
      ws: mockWs,
      tunnelService: mockTunnelService as any,
      chatService: mockChatService as any,
      secretsService: mockSecretsService as any,
      ...overrides,
    };
  }

  // =============================================================================
  // SCENARIO 1: Complete Bug Investigation Workflow
  // =============================================================================

  it('Scenario: Marcus investigates a login bug from setup to resolution', async () => {
    /**
     * THE STORY:
     * Marcus receives a bug report: "Login fails with valid credentials"
     * He needs to debug his React frontend + Express backend locally.
     *
     * WORKFLOW:
     * 1. Link the GitHub issue to track his investigation
     * 2. Set up tunnels for frontend and backend (before servers are running)
     * 3. Start servers and verify tunnels work
     * 4. Request API keys needed for the auth service
     * 5. Take a screenshot showing the error state
     * 6. Analyze the screenshot with AI
     * 7. Record a video of the login flow
     * 8. Analyze the video to understand the timing
     * 9. Use SDK to check chat state and runtime info
     */

    const context = createContext();

    // =========================================================================
    // PHASE 1: Setup and Issue Tracking
    // =========================================================================

    // Link the bug report issue to this chat session
    const linkResult = await linkIssueToChatTool.execute(
      { owner: 'marcus-dev', repo: 'my-app', issue_number: 42 },
      context
    );
    const linkResponse = JSON.parse(linkResult.content[0].text);
    expect(linkResponse.success).toBe(true);
    expect(linkResponse.issue_url).toBe('https://github.com/marcus-dev/my-app/issues/42');

    // Verify WebSocket notified frontend
    const linkEvent = mockWs.getMessagesByType('chat:linkIssue')[0];
    expect(linkEvent.linkedIssue.number).toBe(42);

    // =========================================================================
    // PHASE 2: Tunnel Setup (Before Servers Running)
    // =========================================================================

    // Try to create frontend tunnel before server is running
    const frontendTunnelBefore = await createTunnelTool.execute(
      { port: 3000, name: 'frontend', description: 'React dev server', main: true },
      context
    );
    // Should warn that port isn't accessible
    expect(frontendTunnelBefore.content[0].text).toContain('NOT accessible');
    expect(frontendTunnelBefore.content[0].text).toContain('ECONNREFUSED');

    // =========================================================================
    // PHASE 3: Start Servers and Verify Tunnels
    // =========================================================================

    // Simulate starting the servers
    mockTunnelService.setPortActive(3000, true);
    mockTunnelService.setPortActive(4000, true);

    // Create frontend tunnel (now healthy)
    const frontendTunnel = await createTunnelTool.execute(
      { port: 3000, name: 'frontend', description: 'React dev server', main: true },
      context
    );
    expect(frontendTunnel.content[0].text).toContain('Tunnel ready');
    expect(frontendTunnel.content[0].text).toContain('HEALTHY');

    // Create backend tunnel
    const backendTunnel = await createTunnelTool.execute(
      { port: 4000, name: 'backend', description: 'Express API server' },
      context
    );
    expect(backendTunnel.content[0].text).toContain('Tunnel ready');

    // Verify both tunnels registered correctly
    const tunnels = mockTunnelService.getTunnels();
    expect(tunnels.size).toBe(2);
    expect(tunnels.get(3000)?.main).toBe(true);
    expect(tunnels.get(4000)?.main).toBeUndefined();

    // Show tunnel info (reuses existing)
    const showTunnelResult = await showTunnelTool.execute(
      { port: 3000, name: 'frontend', main: true },
      context
    );
    expect(showTunnelResult.content[0].text).toContain('3000');

    // =========================================================================
    // PHASE 4: Request Required Secrets
    // =========================================================================

    const envFilePath = path.join(testRepoPath, '.env.local');

    // Verify file doesn't exist yet
    const existsBefore = await fs
      .access(envFilePath)
      .then(() => true)
      .catch(() => false);
    expect(existsBefore).toBe(false);

    // Request API keys for auth testing
    await requestUserSecretsTool.execute(
      {
        file_path: envFilePath,
        secrets: [
          { key: 'AUTH0_CLIENT_ID', description: 'Auth0 client ID for OAuth', required: true },
          { key: 'AUTH0_CLIENT_SECRET', description: 'Auth0 client secret', required: true },
          { key: 'JWT_SECRET', description: 'JWT signing secret', required: true },
        ],
      },
      context
    );

    // Verify file was created with template
    const envContent = await fs.readFile(envFilePath, 'utf-8');
    expect(envContent).toContain('AUTH0_CLIENT_ID=');
    expect(envContent).toContain('JWT_SECRET=');

    // Verify WebSocket event sent to open editor
    const secretsEvent = mockWs.getMessagesByType('request_user_secrets')[0];
    expect(secretsEvent.file_path).toBe(envFilePath);

    // =========================================================================
    // PHASE 5: Display video for the user to see
    // =========================================================================

    mockWs.reset();
    const displayResult = await displayVideoTool.execute({ video_path: testVideoPath }, context);
    expect(displayResult.content[0].text).toContain('Video displayed');

    // =========================================================================
    // PHASE 7: SDK Operations - Check State
    // =========================================================================

    // Add a secret for SDK test
    mockSecretsService.addSecret('JWT_SECRET', 'test-secret-value', 'manual');

    // Use SDK to get current context
    const contextResult = await portableExecuteTool.execute(
      {
        code: `
          const chat = await portable.context.getCurrentChat();
          const tunnels = await portable.runtime.getTunnels();
          const secrets = await portable.user.getSecrets();
          return {
            chatTitle: chat?.title,
            tunnelCount: tunnels.length,
            secretCount: secrets.length,
            hasJwtSecret: secrets.some(s => s.key === 'JWT_SECRET'),
          };
        `,
        description: 'Get current debugging session state',
      },
      context
    );
    const state = JSON.parse(contextResult.content[0].text);
    expect(state.chatTitle).toBe('Investigating login bug #42');
    expect(state.tunnelCount).toBe(2);
    expect(state.secretCount).toBe(1);
    expect(state.hasJwtSecret).toBe(true);

    // =========================================================================
    // PHASE 8: Cleanup - Unlink Issue When Done
    // =========================================================================

    mockWs.reset();
    const unlinkResult = await linkIssueToChatTool.execute({ issue_number: null }, context);
    const unlinkResponse = JSON.parse(unlinkResult.content[0].text);
    expect(unlinkResponse.action).toBe('unlinked');
  });

  // =============================================================================
  // SCENARIO 2: Error Handling and Edge Cases
  // =============================================================================

  it('Scenario: Graceful handling when services are unavailable or inputs are invalid', async () => {
    /**
     * THE STORY:
     * Marcus is working in a degraded environment where some services
     * are unavailable. The tools should fail gracefully with helpful messages.
     *
     * TESTS:
     * 1. Tunnel creation without TunnelService
     * 2. Image analysis without an AI media credential
     * 3. Video analysis without an AI media credential
     * 4. Secrets request with path outside repository (security)
     * 5. Issue linking with missing required fields
     * 6. SDK execution without ChatService
     * 7. Image/video analysis with missing files
     * 8. Connection request (should always work - just sends WebSocket)
     */

    // =========================================================================
    // Test: Tunnel tools without TunnelService
    // =========================================================================

    const noTunnelContext = createContext({ tunnelService: undefined });

    const createTunnelResult = await createTunnelTool.execute(
      { port: 3000, name: 'app' },
      noTunnelContext
    );
    expect(createTunnelResult.content[0].text).toContain('Tunnel service not available');

    const showTunnelResult = await showTunnelTool.execute(
      { port: 3000, name: 'app' },
      noTunnelContext
    );
    expect(showTunnelResult.content[0].text).toContain('Tunnel service not available');

    const context = createContext();

    // =========================================================================
    // Test: Security - Secrets path traversal prevention
    // =========================================================================

    const pathTraversal = await requestUserSecretsTool.execute(
      {
        file_path: '/etc/passwd',
        secrets: [{ key: 'HACK', description: 'Malicious' }],
      },
      context
    );
    expect(pathTraversal.content[0].text).toContain('must be within the repository');

    // =========================================================================
    // Test: Issue linking validation
    // =========================================================================

    const missingRepo = await linkIssueToChatTool.execute(
      { owner: 'marcus-dev', issue_number: 42 }, // Missing repo
      context
    );
    const linkError = JSON.parse(missingRepo.content[0].text);
    expect(linkError.success).toBe(false);
    expect(linkError.error).toContain('owner, repo, and issue_number are required');

    // =========================================================================
    // Test: SDK without ChatService
    // =========================================================================

    const noChatContext = createContext({ chatService: undefined });
    const sdkNoChat = await portableExecuteTool.execute({ code: `return 'test';` }, noChatContext);
    expect(sdkNoChat.content[0].text).toContain('ChatService not available');

    // =========================================================================
    // Test: SDK with runtime errors
    // =========================================================================

    const sdkError = await portableExecuteTool.execute(
      { code: `throw new Error('Intentional test error');` },
      context
    );
    expect(sdkError.content[0].text).toContain('Intentional test error');

    // =========================================================================
    // Test: Connection request always works (just sends WebSocket message)
    // =========================================================================

    mockWs.reset();
    const connectionResult = await requestUserConnectionTool.execute(
      {
        service: 'slack',
        reason: 'To send build notifications to your team channel',
        required: true,
      },
      context
    );
    expect(connectionResult.content[0].text).toContain('Requesting slack connection');

    const connEvent = mockWs.getMessagesByType('request_user_connection')[0];
    expect(connEvent.service).toBe('slack');
    expect(connEvent.required).toBe(true);

    // Optional connection request
    const optionalConn = await requestUserConnectionTool.execute(
      { service: 'linear', reason: 'To sync tasks (optional)', required: false },
      context
    );
    expect(optionalConn.content[0].text).toContain('optional');
  });
});
