/**
 * Tests for Tunnel Prompt Generation
 *
 * Ensures buildSystemPromptFromSetup() correctly handles tunnel service integration
 * and generates the runtime tunnel section.
 *
 * The local-first runtime uses a single tunnel type:
 * - Temporary Cloudflare Quick Tunnels (dynamic trycloudflare.com URLs, 15-minute lifetime)
 *
 * The pre-configured / stable Named-Tunnel paths (and the old `useStableTunnels`
 * branch + port list) were removed in the local-first pivot.
 */

import { describe, it, expect } from 'bun:test';
import {
  buildSystemPromptFromSetup,
  buildRuntimeTunnelSection,
} from '../../../src/prompts/systemPrompts';

describe('Tunnel Prompt Generation', () => {
  // Helper to create mock tunnel service
  const createMockTunnelService = (tunnels: Array<{ port: number; url: string }>) => ({
    getTunnelMappings: (_userId?: string) => tunnels,
  });

  describe('buildRuntimeTunnelSection - Scenario Tests', () => {
    describe('Temporary/Dynamic Tunnels', () => {
      it('should generate temporary tunnel prompt (Cloudflare Quick Tunnels)', () => {
        const mockTunnelService = createMockTunnelService([
          { port: 5173, url: 'https://random-words-123.trycloudflare.com' },
          { port: 8080, url: 'https://another-random-456.trycloudflare.com' },
          { port: 3000, url: 'https://third-random-789.trycloudflare.com' },
        ]);

        const prompt = buildRuntimeTunnelSection(mockTunnelService, 'user123');

        // Verify temporary tunnel content
        expect(prompt).toContain('TEMPORARY TUNNELS');
        expect(prompt).toContain('temporary HTTPS tunnels (15-minute lifetime)');
        expect(prompt).toContain('Use create_tunnel to create new tunnels');

        // Verify tunnel URLs
        expect(prompt).toContain('localhost:5173 → https://random-words-123.trycloudflare.com');
        expect(prompt).toContain('localhost:8080 → https://another-random-456.trycloudflare.com');
        expect(prompt).toContain('localhost:3000 → https://third-random-789.trycloudflare.com');

        // Should NOT contain the removed stable/pre-configured content or port list
        expect(prompt).not.toContain('PRE-CONFIGURED TUNNELS');
        expect(prompt).not.toContain('Persistent HTTPS tunnels');
        expect(prompt).not.toContain('All tunnels are active and ready');
        expect(prompt).not.toContain('5173, 5174, 5175');
      });
    });

    describe('Edge Cases', () => {
      it('should return empty string when tunnel mappings are empty', () => {
        const mockTunnelService = createMockTunnelService([]);
        const prompt = buildRuntimeTunnelSection(mockTunnelService, 'user123');
        expect(prompt).toBe('');
      });

      it('should filter tunnels by userId when provided', () => {
        const mockTunnelService = {
          getTunnelMappings: (userId?: string) => {
            if (userId === 'user123') {
              return [{ port: 5173, url: 'https://user123-tunnel.example.com' }];
            }
            return [];
          },
        };

        const prompt = buildRuntimeTunnelSection(mockTunnelService, 'user123');
        expect(prompt).toContain('https://user123-tunnel.example.com');
      });
    });
  });

  describe('Tunnel Service Integration', () => {
    it('should include tunnel information when tunnel service is provided', () => {
      const mockTunnelService = createMockTunnelService([
        { port: 5173, url: 'https://tunnel-5173.example.com' },
        { port: 8080, url: 'https://tunnel-8080.example.com' },
        { port: 3000, url: 'https://tunnel-3000.example.com' },
      ]);

      const systemPrompt = buildSystemPromptFromSetup(
        'freestyle',
        { userId: 'user123' },
        mockTunnelService
      );

      // Verify tunnel content is included
      expect(systemPrompt).toContain('TUNNELS');
      expect(systemPrompt).toContain('localhost:5173 → https://tunnel-5173.example.com');
      expect(systemPrompt).toContain('localhost:8080 → https://tunnel-8080.example.com');
      expect(systemPrompt).toContain('localhost:3000 → https://tunnel-3000.example.com');

      // Verify tunnel usage instructions
      expect(systemPrompt).toContain('CRITICAL INSTRUCTIONS FOR TUNNELS');
      expect(systemPrompt).toContain('temporary HTTPS tunnels (15-minute lifetime)');
      expect(systemPrompt).toContain('Use create_tunnel to create new tunnels');
    });
  });

  describe('Edge Cases', () => {
    it('should handle no tunnel service provided (graceful degradation)', () => {
      const systemPrompt = buildSystemPromptFromSetup(
        'freestyle',
        {
          userId: 'user123',
        },
        undefined // No tunnel service
      );

      // Should not contain any tunnel content
      expect(systemPrompt).not.toContain('TUNNELS');
      expect(systemPrompt).not.toContain('localhost:');
    });

    it('should handle empty tunnel mappings', () => {
      const mockTunnelService = {
        getTunnelMappings: (_userId?: string) => [],
      };

      const systemPrompt = buildSystemPromptFromSetup(
        'freestyle',
        {
          userId: 'user123',
        },
        mockTunnelService
      );

      // Should not contain any tunnel content
      expect(systemPrompt).not.toContain('TUNNELS');
      expect(systemPrompt).not.toContain('localhost:');
    });

    it('should filter tunnels by userId when provided', () => {
      const mockTunnelService = {
        getTunnelMappings: (userId?: string) => {
          // Only return tunnels for specific user
          if (userId === 'user123') {
            return [{ port: 5173, url: 'https://user123-tunnel.example.com' }];
          }
          return [];
        },
      };

      const systemPrompt = buildSystemPromptFromSetup(
        'freestyle',
        {
          userId: 'user123',
        },
        mockTunnelService
      );

      // Should contain user123's tunnel
      expect(systemPrompt).toContain('https://user123-tunnel.example.com');
    });
  });
});
