/**
 * TunnelService Scenario-Based Tests
 *
 * Full end-to-end scenarios that simulate real user workflows for the
 * local Cloudflare Quick Tunnel provider (the only tunnel mode after the
 * local-first pivot — the earlier stable-tunnel support was removed).
 *
 * Philosophy: Test realistic workflows, not isolated methods.
 * Each scenario covers multiple methods and edge cases together.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { createServer } from 'net';

// Import types for config injection (doesn't trigger module load)
import type { TunnelServiceOptions } from '../../../src/services/TunnelService.js';

// TunnelService will be imported dynamically after mock.module
let TunnelService: typeof import('../../../src/services/TunnelService.js').TunnelService;

// Mock tracking variables for child_process
let mockSpawnFn: Function | null = null;
let mockExecFn: Function | null = null;

// Set up module mock for child_process BEFORE any test imports TunnelService
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

// Factory to create a mock child process for cloudflared
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
      proc.exitCode = 0;
    });

    // Emit URL after a tick (cloudflared outputs URL to stderr)
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
};

// Config preset for the local Quick Tunnel provider (the only mode)
const quickTunnelConfig: TunnelServiceOptions = { mode: 'quick' };

// Helper to create TunnelService with explicit config
const createTunnelService = (options?: TunnelServiceOptions) => {
  return new TunnelService(options);
};

// =============================================================================
// QUICK TUNNEL SCENARIOS (Development Default)
// =============================================================================

describe('Quick Tunnel Scenarios', () => {
  beforeAll(async () => {
    const module = await import('../../../src/services/TunnelService.js');
    TunnelService = module.TunnelService;
  });

  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    resetMocks();
  });

  describe('Scenario: Developer workflow with app restart', () => {
    it('should handle app crash and restart gracefully', async () => {
      let tunnelCounter = 0;
      const mockProcesses: any[] = [];

      mockSpawnFn = () => {
        tunnelCounter++;
        const proc = createMockProcessFactory({
          url: `tunnel-${tunnelCounter}.trycloudflare.com`,
        })();
        mockProcesses.push(proc);
        return proc;
      };

      let portListening = true;
      mockExecFn = (cmd: string, callback: Function) => {
        if (cmd.includes('lsof')) {
          callback(null, { stdout: portListening ? 'node 1234' : '' });
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

      const url1 = await tunnelService.createLocalTunnel(
        3000,
        'developer@example.com',
        'chat-123',
        'myorg/myapp',
        'dev-server'
      );
      expect(url1).toContain('tunnel-1.trycloudflare.com');

      let tunnels = tunnelService.getUserTunnels('developer@example.com');
      expect(tunnels.length).toBe(1);

      // Simulate app crash
      portListening = false;
      mockProcesses[0].killed = true;
      mockProcesses[0].exitCode = 1;

      // Restart app
      portListening = true;

      const url2 = await tunnelService.createLocalTunnel(
        3000,
        'developer@example.com',
        'chat-123',
        'myorg/myapp',
        'dev-server'
      );

      expect(url2).toContain('tunnel-2.trycloudflare.com');
      tunnels = tunnelService.getUserTunnels('developer@example.com');
      expect(tunnels.length).toBe(1);
      expect(tunnels[0].url).toContain('tunnel-2');

      await tunnelService.shutdown();
    });

    it('should return existing URL if tunnel and process are still healthy', async () => {
      let tunnelCounter = 0;
      let persistentMockProc: any = null;

      mockSpawnFn = () => {
        tunnelCounter++;
        if (!persistentMockProc) {
          persistentMockProc = createMockProcessFactory({
            url: 'healthy-tunnel.trycloudflare.com',
          })();
        }
        return persistentMockProc;
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

      const url1 = await tunnelService.createLocalTunnel(
        3000,
        'developer@example.com',
        'chat-123',
        'myorg/myapp',
        'dev-server'
      );

      expect(url1).toContain('trycloudflare.com');

      const url2 = await tunnelService.createLocalTunnel(
        3000,
        'developer@example.com',
        'chat-456',
        'myorg/myapp',
        'dev-server'
      );

      expect(url1).toBe(url2);
      expect(tunnelCounter).toBe(1);

      await tunnelService.shutdown();
    });
  });

  describe('Scenario: IPv4 tunnel origin (dual-stack / IPv6 ::1 502 fix)', () => {
    it('points cloudflared at 127.0.0.1, never localhost, so it cannot dial [::1]', async () => {
      // The dev server binds IPv4 (`isPortActive` probes 127.0.0.1). If the
      // tunnel origin were `localhost`, cloudflared on a dual-stack/Windows host
      // could dial `[::1]:port` first → `connection refused` → a 502 the phone
      // sees as a broken preview. The origin MUST be the IPv4 loopback.
      // Bind a REAL ephemeral loopback listener so the liveness check passes on
      // every platform (Windows uses a `net` TCP probe; POSIX uses the mocked
      // `lsof` below) — the assertion is the spawned cloudflared `--url`.
      const listener = createServer();
      const port: number = await new Promise((resolve) => {
        listener.listen(0, '127.0.0.1', () => {
          resolve((listener.address() as { port: number }).port);
        });
      });

      const spawnArgLists: string[][] = [];
      mockSpawnFn = (_bin: string, args: string[]) => {
        spawnArgLists.push(args);
        return createMockProcessFactory({ url: 'ipv4-origin.trycloudflare.com' })();
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

      try {
        const url = await tunnelService.createLocalTunnel(
          port,
          'developer@example.com',
          'chat-1',
          'myorg/myapp',
          'dev-server'
        );
        expect(url).toContain('ipv4-origin.trycloudflare.com');

        const cloudflaredArgs = spawnArgLists.find((a) => a.includes('--url'));
        expect(cloudflaredArgs).toBeDefined();
        const origin = cloudflaredArgs![cloudflaredArgs!.indexOf('--url') + 1];
        expect(origin).toBe(`http://127.0.0.1:${port}`);
        expect(origin).not.toContain('localhost');
      } finally {
        await tunnelService.shutdown();
        await new Promise<void>((resolve) => listener.close(() => resolve()));
      }
    });
  });

  describe('Scenario: Rate limiting enforcement', () => {
    it('should enforce rate limit after MAX_TUNNELS_PER_HOUR', async () => {
      let tunnelCounter = 0;
      mockSpawnFn = () => {
        tunnelCounter++;
        return createMockProcessFactory({
          url: `tunnel-${tunnelCounter}.trycloudflare.com`,
        })();
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

      for (let i = 1; i <= 5; i++) {
        await tunnelService.createDynamicTunnel('heavy-user@example.com', 3000 + i, `tunnel-${i}`);
      }

      await expect(
        tunnelService.createDynamicTunnel('heavy-user@example.com', 3006, 'tunnel-6')
      ).rejects.toThrow(/Rate limit exceeded/);

      await tunnelService.shutdown();
    });

    it('should track rate limits per user independently', async () => {
      let tunnelCounter = 0;
      mockSpawnFn = () => {
        tunnelCounter++;
        return createMockProcessFactory({
          url: `tunnel-${tunnelCounter}.trycloudflare.com`,
        })();
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

      for (let i = 1; i <= 5; i++) {
        await tunnelService.createDynamicTunnel('user-a@example.com', 3000 + i, `tunnel-${i}`);
      }

      await expect(
        tunnelService.createDynamicTunnel('user-a@example.com', 3006, 'tunnel-6')
      ).rejects.toThrow(/Rate limit/);

      const userBUrl = await tunnelService.createDynamicTunnel(
        'user-b@example.com',
        4000,
        'user-b-tunnel'
      );
      expect(userBUrl).toContain('trycloudflare.com');

      await tunnelService.shutdown();
    });
  });

  describe('Scenario: Multi-user workspace with statistics', () => {
    it('should track tunnels per user and provide accurate statistics', async () => {
      let tunnelCounter = 0;
      mockSpawnFn = () => {
        tunnelCounter++;
        return createMockProcessFactory({
          url: `tunnel-${tunnelCounter}.trycloudflare.com`,
        })();
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

      await tunnelService.createLocalTunnel(
        3000,
        'alice@example.com',
        'chat-1',
        'org/app1',
        'app1'
      );
      await tunnelService.createLocalTunnel(
        3001,
        'alice@example.com',
        'chat-1',
        'org/app1',
        'app2'
      );
      await tunnelService.createLocalTunnel(4000, 'bob@example.com', 'chat-2', 'org/app2', 'api');
      await tunnelService.createLocalTunnel(5000, 'carol@example.com', 'chat-3', 'org/app3', 'fe1');
      await tunnelService.createLocalTunnel(5001, 'carol@example.com', 'chat-3', 'org/app3', 'fe2');
      await tunnelService.createLocalTunnel(5002, 'carol@example.com', 'chat-3', 'org/app3', 'fe3');

      const stats = tunnelService.getTunnelStats();
      expect(stats.activeTunnels).toBe(6);
      expect(stats.tunnelsByUser.get('alice@example.com')).toBe(2);
      expect(stats.tunnelsByUser.get('bob@example.com')).toBe(1);
      expect(stats.tunnelsByUser.get('carol@example.com')).toBe(3);

      await tunnelService.destroyUserTunnels('alice@example.com');

      const statsAfter = tunnelService.getTunnelStats();
      expect(statsAfter.activeTunnels).toBe(4);
      expect(statsAfter.tunnelsByUser.has('alice@example.com')).toBe(false);

      await tunnelService.shutdown();
    });
  });

  describe('Scenario: Port health verification', () => {
    it('should detect unhealthy server (connection refused)', async () => {
      mockExecFn = (cmd: string, callback: Function) => {
        callback(null, { stdout: '' });
      };

      const tunnelService = createTunnelService(quickTunnelConfig);

      const result = await tunnelService.checkPortHealth(59998);

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');

      await tunnelService.shutdown();
    });
  });

  describe('Scenario: Tunnel mappings for system prompt', () => {
    it('should return correct tunnel mappings for system prompt generation', async () => {
      let tunnelCounter = 0;
      mockSpawnFn = () => {
        tunnelCounter++;
        return createMockProcessFactory({
          url: `tunnel-${tunnelCounter}.trycloudflare.com`,
        })();
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

      await tunnelService.createLocalTunnel(3000, 'alice@example.com', 'c1', 'org/app', 'frontend');
      await tunnelService.createLocalTunnel(3001, 'alice@example.com', 'c1', 'org/app', 'backend');
      await tunnelService.createLocalTunnel(4000, 'bob@example.com', 'c2', 'org/app', 'api');

      const aliceMappings = tunnelService.getTunnelMappings('alice@example.com');
      expect(aliceMappings.length).toBe(2);

      const allMappings = tunnelService.getTunnelMappings();
      expect(allMappings.length).toBe(3);

      await tunnelService.shutdown();
    });
  });
});
