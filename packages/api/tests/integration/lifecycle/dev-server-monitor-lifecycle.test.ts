/**
 * Dev Server Monitor Service Lifecycle Tests
 *
 * THE STORY: "Developer running multiple dev servers"
 *
 * Alex is a developer working on a full-stack app. The DevServerMonitorService:
 * 1. Detects dev server ports from framework output (Vite, Next.js, etc.)
 * 2. Creates Cloudflare Quick Tunnels so the mobile in-chat preview bubble can
 *    reach the dev server (the phone can't reach the PC's localhost)
 * 3. Notifies the client via WebSocket
 *
 * REAL SERVICES:
 * - ✅ DevServerMonitorService - Port detection and tunnel orchestration
 *
 * MOCKED:
 * - 🔴 TunnelService - Cloudflare tunnel creation
 * - 🔴 WebSocket - Client notifications
 *
 * CONFIGURATION:
 * Test ports can be configured via environment variables:
 * - TEST_FRONTEND_PORT (default: 5173) - Frontend dev server port
 * - TEST_BACKEND_PORT (default: 4000) - Backend API port
 * - TEST_ARRAY_FORMAT_PORT (default: 4000) - Port for array format test
 *
 * NOTE: Tunnels are now created via Cloudflare Quick Tunnels for ANY detected port —
 * there is no production port restriction (the earlier stable-tunnel support was removed).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

// ========================================
// MOCK CLASSES
// ========================================

class MockTunnelService {
  private tunnels = new Map<number, { url: string; name?: string; main?: boolean }>();
  createTunnelCalls: any[] = [];

  async createLocalTunnel(
    port: number,
    userId: string,
    chatId?: string,
    repoPath?: string,
    name?: string,
    description?: string,
    main?: boolean
  ) {
    this.createTunnelCalls.push({ port, userId, chatId, repoPath, name, description, main });
    const url = `https://tunnel-${port}.trycloudflare.com`;
    this.tunnels.set(port, { url, name, main });
    return url;
  }

  getTunnels() {
    return this.tunnels;
  }

  reset() {
    this.tunnels.clear();
    this.createTunnelCalls = [];
  }
}

class MockWebSocket {
  sentMessages: any[] = [];
  readyState = 1; // OPEN

  send(msg: string) {
    this.sentMessages.push(JSON.parse(msg));
  }

  reset() {
    this.sentMessages = [];
  }
}

// ========================================
// IMPORT SERVICES
// ========================================

import { DevServerMonitorService } from '../../../src/services/DevServerMonitorService';

// ========================================
// TEST SUITES
// ========================================

describe('Dev Server Monitor - Port Detection and Tunnel Lifecycle', () => {
  let devServerMonitorService: DevServerMonitorService;
  let mockTunnelService: MockTunnelService;
  let mockWs: MockWebSocket;
  let claudeCodeSessions: Map<string, any>;

  const TEST_USER_ID = 'alex@example.com';
  const TEST_CHAT_ID = 'chat-dev-session-001';
  const TEST_REPO_PATH = '/workspace/testowner/fullstack-app';

  // Test ports - configurable via env vars with fallback to defaults
  const TEST_FRONTEND_PORT = parseInt(process.env.TEST_FRONTEND_PORT || '5173');
  const TEST_BACKEND_PORT = parseInt(process.env.TEST_BACKEND_PORT || '4000');
  const TEST_ARRAY_FORMAT_PORT = parseInt(process.env.TEST_ARRAY_FORMAT_PORT || '4000');

  beforeEach(() => {
    mockTunnelService = new MockTunnelService();
    mockWs = new MockWebSocket();

    // Create Claude sessions map with test session
    claudeCodeSessions = new Map();
    claudeCodeSessions.set(TEST_CHAT_ID, {
      repo_path: TEST_REPO_PATH,
      messageQueue: [],
    });

    devServerMonitorService = new DevServerMonitorService(
      mockTunnelService as any,
      claudeCodeSessions
    );
  });

  afterEach(() => {
    mockTunnelService.reset();
    mockWs.reset();
  });

  it("should handle Alex's complete full-stack development workflow: detect multiple frameworks → create tunnels → notify", async () => {
    /**
     * SCENARIO: Alex is developing a full-stack app with multiple dev servers
     *
     * Step 1: Test port detection for various frameworks (Vite, Next.js, CRA, Django, Flask)
     * Step 2: Test ANSI color code stripping
     * Step 3: Test that system ports are ignored
     * Step 4: Alex starts frontend (Vite) - detect port and create tunnel
     * Step 5: Alex starts backend (Express) - detect port and create tunnel
     * Step 6: Verify WebSocket notifications and message queue injection
     * Step 7: Verify tunnel reuse for same port
     */

    // === STEP 1: Test port detection for various frameworks ===
    console.log('🔍 Step 1: Testing port detection patterns for various frameworks...');

    // NOTE: The regex `:(\d+)(?:[/\s\n]|$)` requires colon before port
    // Output must have `:PORT` followed by /, space, newline, or end of string

    // Vite dev server
    const viteOutput = `VITE v5.0.0 ready in 234 ms\n\n  ➜  Local:   http://localhost:${TEST_FRONTEND_PORT}/`;
    expect(devServerMonitorService.detectDevServerPort(viteOutput)).toBe(TEST_FRONTEND_PORT);

    // Next.js dev server
    const nextOutput = 'ready - started server on 0.0.0.0:3000, url: http://localhost:3000';
    expect(devServerMonitorService.detectDevServerPort(nextOutput)).toBe(3000);

    // Create React App
    const craOutput =
      'Local:            http://localhost:3001\n  On Your Network:  http://192.168.1.100:3001';
    expect(devServerMonitorService.detectDevServerPort(craOutput)).toBe(3001);

    // Django dev server
    const djangoOutput =
      'Starting development server at http://127.0.0.1:8000/\nQuit the server with CONTROL-C.';
    expect(devServerMonitorService.detectDevServerPort(djangoOutput)).toBe(8000);

    // Flask dev server
    const flaskOutput = ' * Running on http://127.0.0.1:5000/ (Press CTRL+C to quit)';
    expect(devServerMonitorService.detectDevServerPort(flaskOutput)).toBe(5000);

    // Express server (with colon prefix)
    const expressOutput = 'Express server listening on :4000';
    expect(devServerMonitorService.detectDevServerPort(expressOutput)).toBe(4000);

    // === STEP 2: Test ANSI color code stripping ===
    console.log('🎨 Step 2: Testing ANSI color code stripping...');

    const ansiOutput = `  ➜  Local:   \u001b[36mhttp://localhost:\u001b[1m${TEST_FRONTEND_PORT}\u001b[22m\u001b[39m/`;
    expect(devServerMonitorService.detectDevServerPort(ansiOutput)).toBe(TEST_FRONTEND_PORT);

    // === STEP 3: Test system ports are ignored ===
    console.log('🚫 Step 3: Verifying system ports are ignored...');

    const systemPortOutput = 'SSH on port :22 HTTPS on :443 HTTP on :80';
    expect(devServerMonitorService.detectDevServerPort(systemPortOutput)).toBeNull();

    // No valid port patterns
    const noPortOutput = 'Compiling... Build successful!';
    expect(devServerMonitorService.detectDevServerPort(noPortOutput)).toBeNull();

    // === STEP 4: Alex starts frontend (Vite) - detect port and create tunnel ===
    console.log('🖥️ Step 4: Alex starts frontend (Vite)...');

    const frontendBashOutput = {
      content: `<stdout>VITE v5.0.0 ready in 234 ms

  ➜  Local:   http://localhost:${TEST_FRONTEND_PORT}/
  ➜  Network: http://192.168.1.100:${TEST_FRONTEND_PORT}/
</stdout>`,
    };

    await devServerMonitorService.monitorBashOutputForPorts(
      frontendBashOutput,
      TEST_USER_ID,
      TEST_CHAT_ID,
      mockWs as any
    );

    // Verify tunnel was created
    expect(mockTunnelService.createTunnelCalls.length).toBe(1);
    expect(mockTunnelService.createTunnelCalls[0].port).toBe(TEST_FRONTEND_PORT);
    expect(mockTunnelService.createTunnelCalls[0].main).toBe(true);

    // Verify WebSocket notification
    expect(mockWs.sentMessages.length).toBe(1);
    expect(mockWs.sentMessages[0].type).toBe('tunnel_created');
    expect(mockWs.sentMessages[0].port).toBe(TEST_FRONTEND_PORT);
    expect(mockWs.sentMessages[0].url).toContain(`tunnel-${TEST_FRONTEND_PORT}`);

    // === STEP 5: Alex starts backend API ===
    console.log('⚙️ Step 5: Alex starts backend (Express API)...');

    const backendBashOutput = {
      content: `<stdout>Backend API listening on :${TEST_BACKEND_PORT}</stdout>`,
    };

    await devServerMonitorService.monitorBashOutputForPorts(
      backendBashOutput,
      TEST_USER_ID,
      TEST_CHAT_ID,
      mockWs as any
    );

    // Verify second tunnel was created
    expect(mockTunnelService.createTunnelCalls.length).toBe(2);
    expect(mockTunnelService.createTunnelCalls[1].port).toBe(TEST_BACKEND_PORT);

    // Verify both tunnels are registered
    expect(mockTunnelService.getTunnels().has(TEST_FRONTEND_PORT)).toBe(true);
    expect(mockTunnelService.getTunnels().has(TEST_BACKEND_PORT)).toBe(true);

    // === STEP 6: Verify all notifications were sent ===
    console.log('📬 Step 6: Verifying WebSocket notifications...');

    expect(mockWs.sentMessages.length).toBe(2);
    expect(mockWs.sentMessages[1].type).toBe('tunnel_created');
    expect(mockWs.sentMessages[1].port).toBe(TEST_BACKEND_PORT);
    expect(mockWs.sentMessages[1].chat_id).toBe(TEST_CHAT_ID);
    expect(mockWs.sentMessages[1].message).toContain('Quick Tunnel created');

    // === STEP 7: Verify tunnel reuse for same port ===
    console.log('♻️ Step 7: Verifying tunnel reuse...');

    // Try to create tunnel for same frontend port
    const tunnelUrl1 = await devServerMonitorService.createTunnelForPort(
      TEST_FRONTEND_PORT,
      TEST_USER_ID
    );
    const tunnelUrl2 = await devServerMonitorService.createTunnelForPort(
      TEST_FRONTEND_PORT,
      TEST_USER_ID
    );

    expect(tunnelUrl1).toBe(tunnelUrl2);
    // Should not have created additional tunnel calls (beyond the first 2)
    expect(mockTunnelService.createTunnelCalls.length).toBe(2);

    console.log("✅ Alex's full-stack development workflow completed successfully");
  });

  it('creates a tunnel for the mobile preview bubble WITHOUT rewriting Claude to the tunnel, and degrades gracefully', async () => {
    /**
     * SCENARIO: Developer in local-first mode
     *
     * Local-first: the phone cannot reach the PC's localhost, so a dev-server tunnel IS
     * created for the mobile in-chat runtime preview bubble. Claude reaches localhost
     * directly, so nothing is injected into Claude's message queue.
     *
     * Step 1: Tunnel IS created for the bubble, NO agent injection
     * Step 2: Tunnel service unavailable - graceful null
     * Step 3: Empty/missing content - no port detected, no tunnel
     * Step 4: Array content format from other tools - tunnel created
     */

    // === STEP 1: Tunnel created for the mobile preview, no injection ===
    console.log('🏠 Step 1: Testing local-first mode...');

    const localBashOutput = {
      content: '<stdout>Local: http://localhost:3000</stdout>',
    };

    await devServerMonitorService.monitorBashOutputForPorts(
      localBashOutput,
      TEST_USER_ID,
      TEST_CHAT_ID,
      mockWs as any
    );

    // A tunnel IS created in local mode so the mobile preview bubble has a public URL
    expect(mockTunnelService.createTunnelCalls.length).toBe(1);
    expect(mockTunnelService.createTunnelCalls[0].port).toBe(3000);
    // The frontend (mobile bubble) is notified of the new tunnel
    expect(mockWs.sentMessages.length).toBe(1);
    expect(mockWs.sentMessages[0].type).toBe('tunnel_created');
    // But Claude's own automation is NOT redirected to the tunnel in local mode
    expect(claudeCodeSessions.get(TEST_CHAT_ID).messageQueue.length).toBe(0);

    // === STEP 2: Tunnel service unavailable - graceful null ===
    console.log('⚠️ Step 2: Testing graceful handling when tunnel service unavailable...');

    const serviceWithoutTunnel = new DevServerMonitorService(undefined, undefined);
    const result = await serviceWithoutTunnel.createTunnelForPort(3000, TEST_USER_ID);
    expect(result).toBeNull();

    // === STEP 3: Empty/missing content - no port detected, no tunnel ===
    console.log('📭 Step 3: Testing empty content handling...');

    mockTunnelService.reset();
    mockWs.reset();

    await devServerMonitorService.monitorBashOutputForPorts(
      { content: '' },
      TEST_USER_ID,
      TEST_CHAT_ID,
      mockWs as any
    );

    await devServerMonitorService.monitorBashOutputForPorts(
      {},
      TEST_USER_ID,
      TEST_CHAT_ID,
      mockWs as any
    );

    // No port => no tunnels, no notifications
    expect(mockTunnelService.createTunnelCalls.length).toBe(0);
    expect(mockWs.sentMessages.length).toBe(0);

    // === STEP 4: Array content format from other tools - tunnel created ===
    console.log('📦 Step 4: Testing array content format handling...');

    const arrayContentOutput = {
      content: [
        { type: 'text', text: 'Server starting...' },
        { type: 'text', text: `Listening on http://localhost:${TEST_ARRAY_FORMAT_PORT}` },
      ],
    };

    await devServerMonitorService.monitorBashOutputForPorts(
      arrayContentOutput,
      TEST_USER_ID,
      TEST_CHAT_ID,
      mockWs as any
    );

    expect(mockTunnelService.createTunnelCalls.length).toBe(1);
    expect(mockTunnelService.createTunnelCalls[0].port).toBe(TEST_ARRAY_FORMAT_PORT);

    console.log('✅ Local-first tunnel behavior verified successfully');
  });
});
