/**
 * TunnelService Unit Tests
 *
 * The local-first runtime uses a single tunnel provider:
 * - Quick Tunnels - temporary Cloudflare Quick Tunnels (per dev-server, any port)
 *
 * The pre-configured-tunnel path and the stable Named-Tunnel path were removed.
 *
 * Philosophy: Test the actual TunnelService, mock only external calls
 * - Mock: child_process.spawn, exec
 * - Real: TunnelService business logic
 *
 * IMPORTANT: mock.module MUST be called before any imports that use child_process
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, mock } from 'bun:test';
import { EventEmitter } from 'events';

// Mock tracking variables for child_process
let mockSpawnFn: Function | null = null;
let mockExecFn: Function | null = null;
// Controls the Windows `isPortActive` net-probe (POSIX uses the `lsof` exec mock
// above; Windows uses a TCP connect via net.Socket). Defaults to "port active".
let mockPortActiveFn: ((port: number) => boolean) | null = null;

// Mock `net` so the Windows isPortActive TCP-connect probe is deterministic
// without binding real ports. Only `Socket` is overridden; the rest of `net` is
// intact. On POSIX the production code never instantiates this (it uses lsof).
mock.module('net', () => {
  const originalModule = require('net');
  class FakeSocket {
    private handlers: Record<string, (arg?: unknown) => void> = {};
    setTimeout() {
      return this;
    }
    once(event: string, cb: (arg?: unknown) => void) {
      this.handlers[event] = cb;
      return this;
    }
    removeAllListeners() {
      return this;
    }
    destroy() {
      return this;
    }
    connect(port: number) {
      const active = mockPortActiveFn ? mockPortActiveFn(port) : true;
      setImmediate(() => {
        if (active) this.handlers['connect']?.();
        else this.handlers['error']?.(new Error('ECONNREFUSED'));
      });
      return this;
    }
  }
  // Provide BOTH named (`import { Socket }`) and default (`import net from 'net'`)
  // shapes — the production code uses the default import.
  const mocked = { ...originalModule, Socket: FakeSocket };
  return { ...mocked, default: mocked };
});

// Set up module mock for child_process BEFORE any imports that use it
// NOTE: In Bun, mock.module must be called at the top level before the module is imported
mock.module('child_process', () => {
  const originalModule = require('child_process');
  return {
    ...originalModule,
    spawn: (...args: any[]) => {
      if (mockSpawnFn) {
        return mockSpawnFn(...args);
      }
      return originalModule.spawn(...args);
    },
    exec: (...args: any[]) => {
      if (mockExecFn) {
        return mockExecFn(...args);
      }
      return originalModule.exec(...args);
    },
  };
});

// TunnelService types - imported for type annotations only (doesn't trigger module load)
import type { TunnelServiceOptions } from '../../../src/services/TunnelService.js';

// TunnelService module will be dynamically imported after mock.module is set up
let TunnelService: typeof import('../../../src/services/TunnelService.js').TunnelService;

// Store original env for restoration
const originalEnv = { ...process.env };

// Factory to create a mock child process for cloudflared
// Returns a factory function that creates the process when spawn is called
// This ensures URL emission happens AFTER spawn returns the process
const createMockProcessFactory = (
  options: {
    url?: string;
    exitCode?: number;
    error?: Error;
  } = {}
) => {
  return () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const proc = new EventEmitter() as any;
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.killed = false;
    proc.exitCode = null;
    proc.pid = Math.floor(Math.random() * 10000);
    proc.kill = mock(() => {
      proc.killed = true;
    });

    // Emit URL after a tick (cloudflared outputs URL to stderr)
    // This happens AFTER spawn returns, so listeners are already attached
    if (options.url) {
      setTimeout(() => {
        stderr.emit('data', Buffer.from(`INF |  https://${options.url}\n`));
      }, 10);
    }

    if (options.error) {
      setTimeout(() => {
        proc.emit('error', options.error);
      }, 10);
    }

    if (options.exitCode !== undefined) {
      setTimeout(() => {
        proc.exitCode = options.exitCode;
        proc.emit('exit', options.exitCode, null);
      }, 50);
    }

    return proc;
  };
};

// Helper to reset mocks
const resetMocks = () => {
  mockSpawnFn = null;
  mockExecFn = null;
  mockPortActiveFn = null;
};

// Helper to create TunnelService with optional config
const createTunnelService = (options?: TunnelServiceOptions) => {
  return new TunnelService(options);
};

describe('TunnelService', () => {
  // Dynamically import TunnelService after mock.module is set up
  beforeAll(async () => {
    const module = await import('../../../src/services/TunnelService.js');
    TunnelService = module.TunnelService;
  });

  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    resetMocks();
    // Restore original environment
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);
  });

  describe('Quick Tunnels (the single local cloudflared provider)', () => {
    /**
     * Quick tunnels spawn individual cloudflared processes
     * with --url flag for each port
     */

    const quickTunnelConfig: TunnelServiceOptions = { mode: 'quick' };

    it('should create Quick Tunnel with dynamic URL', async () => {
      // Use factory so process is created when spawn is called (not before)
      const mockProcFactory = createMockProcessFactory({
        url: 'random-words-123.trycloudflare.com',
      });

      mockSpawnFn = (cmd: string) => {
        // Match a cloudflared command generically: POSIX spawns bare 'cloudflared',
        // Windows spawns the resolved full path (…\cloudflared.exe).
        if (String(cmd).includes('cloudflared')) {
          return mockProcFactory();
        }
        throw new Error('Unexpected spawn');
      };

      // Mock exec for isPortActive - simulate port is listening
      mockExecFn = (cmd: string, callback: Function) => {
        if (cmd.includes('lsof')) {
          // Simulate port is listening
          callback(null, { stdout: 'COMMAND  PID USER\nnode    1234 user' });
          return;
        }
        if (cmd.includes('ps aux')) {
          callback(null, { stdout: '' });
          return;
        }
        callback(new Error('Unexpected'), null);
      };

      const tunnelService = createTunnelService(quickTunnelConfig);

      // Wait for cleanup of orphaned processes
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Create quick tunnel
      const url = await tunnelService.createLocalTunnel(
        8080,
        'test-user',
        'chat-123',
        'owner/repo',
        'api'
      );

      // Should have trycloudflare.com URL
      expect(url).toContain('trycloudflare.com');

      const tunnels = tunnelService.getUserTunnels('test-user');
      expect(tunnels.length).toBe(1);

      await tunnelService.shutdown();
    });

    it('should fail if port is not listening', async () => {
      // POSIX: lsof returns empty (below). Windows: net probe reports inactive.
      mockPortActiveFn = () => false;
      mockExecFn = (cmd: string, callback: Function) => {
        if (cmd.includes('lsof')) {
          // Port NOT listening
          callback(null, { stdout: '' });
          return;
        }
        if (cmd.includes('ps aux')) {
          callback(null, { stdout: '' });
          return;
        }
        callback(new Error('Unexpected'), null);
      };

      const tunnelService = createTunnelService(quickTunnelConfig);

      await new Promise((resolve) => setTimeout(resolve, 100));

      await expect(
        tunnelService.createLocalTunnel(8080, 'test-user', 'chat-123', 'owner/repo', 'api')
      ).rejects.toThrow(/not listening/);

      await tunnelService.shutdown();
    });

    it('should support any port in Quick Tunnel mode', async () => {
      // Use factory so process is created when spawn is called (not before)
      const mockProcFactory = createMockProcessFactory({ url: 'random-9999.trycloudflare.com' });
      mockSpawnFn = () => mockProcFactory();

      mockExecFn = (cmd: string, callback: Function) => {
        if (cmd.includes('lsof')) {
          callback(null, { stdout: 'COMMAND  PID\nnode    1234' });
          return;
        }
        if (cmd.includes('ps aux')) {
          callback(null, { stdout: '' });
          return;
        }
        callback(new Error('Unexpected'), null);
      };

      const tunnelService = createTunnelService(quickTunnelConfig);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Any port works for Quick Tunnels (no pre-configured port list)
      const url = await tunnelService.createLocalTunnel(
        9999,
        'test-user',
        'chat-123',
        'owner/repo',
        'custom'
      );

      expect(url).toContain('trycloudflare.com');

      await tunnelService.shutdown();
    });
  });

  describe('Common Tunnel Operations', () => {
    // Use quick tunnel mode for common operation tests
    const quickTunnelConfig: TunnelServiceOptions = { mode: 'quick' };

    it('should replace tunnel when same name+repoPath on different port', async () => {
      let callCount = 0;
      mockSpawnFn = () => {
        callCount++;
        // Use factory inline to create fresh process for each spawn call
        return createMockProcessFactory({ url: `tunnel-${callCount}.trycloudflare.com` })();
      };

      mockExecFn = (cmd: string, callback: Function) => {
        if (cmd.includes('lsof')) {
          callback(null, { stdout: 'COMMAND  PID\nnode    1234' });
          return;
        }
        if (cmd.includes('ps aux')) {
          callback(null, { stdout: '' });
          return;
        }
        callback(new Error('Unexpected'), null);
      };

      const tunnelService = createTunnelService(quickTunnelConfig);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Create first tunnel on port 3000
      await tunnelService.createLocalTunnel(3000, 'test-user', 'chat-123', 'owner/repo', 'app');

      let tunnels = tunnelService.getUserTunnels('test-user');
      expect(tunnels.length).toBe(1);
      expect(tunnels[0].port).toBe(3000);

      // Create second tunnel with same name+repo but different port
      await tunnelService.createLocalTunnel(
        4000,
        'test-user',
        'chat-123',
        'owner/repo',
        'app' // Same name
      );

      // Should have replaced, not added
      tunnels = tunnelService.getUserTunnels('test-user');
      expect(tunnels.length).toBe(1);
      expect(tunnels[0].port).toBe(4000);

      await tunnelService.shutdown();
    });

    it('should unset previous main tunnel when new main tunnel created', async () => {
      let callCount = 0;
      mockSpawnFn = () => {
        callCount++;
        // Use factory inline to create fresh process for each spawn call
        return createMockProcessFactory({ url: `tunnel-${callCount}.trycloudflare.com` })();
      };

      mockExecFn = (cmd: string, callback: Function) => {
        if (cmd.includes('lsof')) {
          callback(null, { stdout: 'COMMAND  PID\nnode    1234' });
          return;
        }
        if (cmd.includes('ps aux')) {
          callback(null, { stdout: '' });
          return;
        }
        callback(new Error('Unexpected'), null);
      };

      const tunnelService = createTunnelService(quickTunnelConfig);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Create first main tunnel
      await tunnelService.createLocalTunnel(
        3000,
        'test-user',
        'chat-123',
        'owner/repo',
        'frontend',
        undefined,
        true // main
      );

      let tunnels = tunnelService.getUserTunnels('test-user');
      expect(tunnels[0].main).toBe(true);

      // Create second main tunnel (different name)
      await tunnelService.createLocalTunnel(
        4000,
        'test-user',
        'chat-123',
        'owner/repo',
        'backend',
        undefined,
        true // Also main
      );

      tunnels = tunnelService.getUserTunnels('test-user');
      expect(tunnels.length).toBe(2);

      // Only the new one should be main
      const frontend = tunnels.find((t: any) => t.port === 3000);
      const backend = tunnels.find((t: any) => t.port === 4000);
      expect(frontend?.main).toBe(false);
      expect(backend?.main).toBe(true);

      await tunnelService.shutdown();
    });
  });

  describe('Health Checks', () => {
    // Use quick tunnel mode for health check tests
    const quickTunnelConfig: TunnelServiceOptions = { mode: 'quick' };

    it('should check port health via HTTP', async () => {
      mockExecFn = (cmd: string, callback: Function) => {
        callback(null, { stdout: '' });
      };

      const tunnelService = createTunnelService(quickTunnelConfig);

      // Check health of a port that's likely not running
      const result = await tunnelService.checkPortHealth(59999);

      // Should return unhealthy since nothing is running on that port
      expect(result.healthy).toBe(false);
      expect(result.error).toBeDefined();

      await tunnelService.shutdown();
    });

    it('should check if port is active via lsof', async () => {
      // Windows path: net probe — 3000 active, others inactive (mirrors lsof mock).
      mockPortActiveFn = (port: number) => port === 3000;
      mockExecFn = (cmd: string, callback: Function) => {
        if (cmd.includes('lsof') && cmd.includes(':3000')) {
          // Port 3000 is listening
          callback(null, { stdout: 'node    1234 user\n' });
          return;
        }
        if (cmd.includes('lsof')) {
          // Other ports not listening
          callback(null, { stdout: '' });
          return;
        }
        if (cmd.includes('ps aux')) {
          callback(null, { stdout: '' });
          return;
        }
        callback(new Error('Unexpected'), null);
      };

      const tunnelService = createTunnelService(quickTunnelConfig);

      const isActive3000 = await tunnelService.isPortActive(3000);
      const isActive9999 = await tunnelService.isPortActive(9999);

      expect(isActive3000).toBe(true);
      expect(isActive9999).toBe(false);

      await tunnelService.shutdown();
    });
  });

  describe('Tunnel Cleanup', () => {
    // Use quick tunnel mode for cleanup tests
    const quickTunnelConfig: TunnelServiceOptions = { mode: 'quick' };

    it('should destroy all tunnels on shutdown', async () => {
      const mockProcs: any[] = [];
      mockSpawnFn = () => {
        // Use factory inline to create fresh process for each spawn call
        const proc = createMockProcessFactory({
          url: `tunnel-${mockProcs.length}.trycloudflare.com`,
        })();
        mockProcs.push(proc);
        return proc;
      };

      mockExecFn = (cmd: string, callback: Function) => {
        if (cmd.includes('lsof')) {
          callback(null, { stdout: 'node 1234' });
          return;
        }
        if (cmd.includes('ps aux')) {
          callback(null, { stdout: '' });
          return;
        }
        callback(new Error('Unexpected'), null);
      };

      const tunnelService = createTunnelService(quickTunnelConfig);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Create some tunnels
      await tunnelService.createLocalTunnel(3000, 'user1', 'chat', 'repo', 'app1');
      await tunnelService.createLocalTunnel(4000, 'user1', 'chat', 'repo', 'app2');

      let tunnels = tunnelService.getUserTunnels('user1');
      expect(tunnels.length).toBe(2);

      // Shutdown should destroy all
      await tunnelService.shutdown();

      tunnels = tunnelService.getUserTunnels('user1');
      expect(tunnels.length).toBe(0);

      // Verify processes were killed
      mockProcs.forEach((proc) => {
        expect(proc.killed).toBe(true);
      });
    });

    it('should destroy all tunnels for a specific user', async () => {
      let counter = 0;
      // Use factory inline to create fresh process for each spawn call
      mockSpawnFn = () =>
        createMockProcessFactory({ url: `tunnel-${counter++}.trycloudflare.com` })();

      mockExecFn = (cmd: string, callback: Function) => {
        if (cmd.includes('lsof') || cmd.includes('ps aux')) {
          callback(null, { stdout: cmd.includes('lsof') ? 'node 1234' : '' });
          return;
        }
        callback(new Error('Unexpected'), null);
      };

      const tunnelService = createTunnelService(quickTunnelConfig);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Create tunnels for two users
      await tunnelService.createLocalTunnel(3000, 'user1', 'chat', 'repo', 'app');
      await tunnelService.createLocalTunnel(4000, 'user2', 'chat', 'repo', 'app');

      expect(tunnelService.getUserTunnels('user1').length).toBe(1);
      expect(tunnelService.getUserTunnels('user2').length).toBe(1);

      // Destroy only user1's tunnels
      await tunnelService.destroyUserTunnels('user1');

      expect(tunnelService.getUserTunnels('user1').length).toBe(0);
      expect(tunnelService.getUserTunnels('user2').length).toBe(1);

      await tunnelService.shutdown();
    });
  });

  describe('Lazy repair (dead-tunnel recovery)', () => {
    const quickTunnelConfig: TunnelServiceOptions = { mode: 'quick' };

    const lsofListening = (listening: boolean) => (cmd: string, callback: Function) => {
      if (cmd.includes('lsof')) {
        callback(null, { stdout: listening ? 'COMMAND PID\nnode 1234' : '' });
        return;
      }
      if (cmd.includes('ps aux')) {
        callback(null, { stdout: '' });
        return;
      }
      callback(new Error('Unexpected'), null);
    };

    it('re-creates a FRESH tunnel (new URL, preserved metadata) when the port is still listening', async () => {
      let counter = 0;
      mockSpawnFn = () =>
        createMockProcessFactory({ url: `repair-${counter++}.trycloudflare.com` })();
      mockPortActiveFn = () => true;
      mockExecFn = lsofListening(true);

      const tunnelService = createTunnelService(quickTunnelConfig);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const firstUrl = await tunnelService.createLocalTunnel(
        3000,
        'u',
        'chat-1',
        'owner/repo',
        'app',
        undefined,
        true // main
      );

      const result = await tunnelService.repairTunnel('u', 3000);
      expect(result.status).toBe('repaired');
      if (result.status === 'repaired') {
        expect(result.url).toContain('trycloudflare.com');
        expect(result.url).not.toBe(firstUrl); // a genuinely fresh tunnel
        expect(result.port).toBe(3000);
      }

      // Exactly one tunnel for the port, carrying the preserved metadata.
      const tunnels = tunnelService.getUserTunnels('u');
      expect(tunnels.length).toBe(1);
      expect(tunnels[0].port).toBe(3000);
      expect(tunnels[0].name).toBe('app');
      expect(tunnels[0].main).toBe(true);

      await tunnelService.shutdown();
    });

    it('reports dev_server_down and CLEARS the stale tunnel when the port is gone', async () => {
      let active = true;
      mockSpawnFn = () => createMockProcessFactory({ url: 'gone.trycloudflare.com' })();
      mockPortActiveFn = () => active;
      mockExecFn = (cmd: string, callback: Function) => lsofListening(active)(cmd, callback);

      const tunnelService = createTunnelService(quickTunnelConfig);
      await new Promise((resolve) => setTimeout(resolve, 100));

      await tunnelService.createLocalTunnel(3000, 'u', 'chat-1', 'owner/repo', 'app');
      expect(tunnelService.getUserTunnels('u').length).toBe(1);

      active = false; // the dev server stopped too — nothing to tunnel
      const result = await tunnelService.repairTunnel('u', 3000);

      expect(result.status).toBe('dev_server_down');
      expect(result.port).toBe(3000);
      // The stale (dead) tunnel must be cleared so the client converges.
      expect(tunnelService.getUserTunnels('u').length).toBe(0);

      await tunnelService.shutdown();
    });

    it('evicts a tunnel and notifies clients when its cloudflared child EXITS', async () => {
      const procs: any[] = [];
      mockSpawnFn = () => {
        const proc = createMockProcessFactory({ url: 'evict.trycloudflare.com' })();
        procs.push(proc);
        return proc;
      };
      mockPortActiveFn = () => true;
      mockExecFn = lsofListening(true);

      const tunnelService = createTunnelService(quickTunnelConfig);
      await new Promise((resolve) => setTimeout(resolve, 100));

      let notifiedFor: string | null = null;
      tunnelService.setStateChangeCallback((userId: string) => {
        notifiedFor = userId;
      });

      await tunnelService.createLocalTunnel(3000, 'u', 'chat-1', 'owner/repo', 'app');
      expect(tunnelService.getUserTunnels('u').length).toBe(1);
      notifiedFor = null; // ignore the create-time notification

      // Simulate cloudflared crashing / the tunnel flapping.
      const proc = procs[procs.length - 1];
      proc.exitCode = 1;
      proc.emit('exit', 1, null);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The dead tunnel is evicted and clients are told to refresh.
      expect(tunnelService.getUserTunnels('u').length).toBe(0);
      expect(notifiedFor).toBe('u');

      await tunnelService.shutdown();
    });
  });
});
