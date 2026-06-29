/**
 * Pure-function tests for the runtime + storage helpers and the ANSI terminal
 * parser. No renderer / mocks — framework-free units.
 */

import { ansiToSpans } from '../src/features/runtime/ansiToSpans';
import {
  claudeSessionStatusColor,
  claudeSessionStatusLabel,
  formatBytes,
  formatElapsed,
  formatUptime,
  processStatusColor,
  processStatusLabel,
  sessionDotColor,
  stripProtocol,
  tunnelDotColor,
  tunnelProvider,
  usageColor,
  type RuntimeStatusColors,
} from '../src/features/runtime/runtimeHelpers';

const COLORS: RuntimeStatusColors = {
  success: '#0f0',
  danger: '#f00',
  info: '#00f',
  warning: '#ff0',
  textTertiary: '#888',
};

describe('runtimeHelpers', () => {
  it('formats byte sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512.0 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.50 MB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20.0 MB');
  });

  it('formats uptime', () => {
    expect(formatUptime(45)).toBe('45s');
    expect(formatUptime(120)).toBe('2m');
    expect(formatUptime(3 * 3600 + 5 * 60)).toBe('3h 5m');
    expect(formatUptime(2 * 86400 + 3600)).toBe('2d 1h 0m');
  });

  it('formats elapsed time tolerating seconds + skew', () => {
    const now = 10_000_000_000_000; // far-future ms
    expect(formatElapsed(now - 30_000, now)).toBe('30s');
    expect(formatElapsed(now - 5 * 60_000, now)).toBe('5m');
    expect(formatElapsed(now - (2 * 3600_000 + 3 * 60_000), now)).toBe('2h 3m');
    // future timestamp clamps to 0s, never negative.
    expect(formatElapsed(now + 5000, now)).toBe('0s');
    expect(formatElapsed(0, now)).toBe('');
  });

  it('detects the tunnel provider (Cloudflare only — no Modal detection remains)', () => {
    expect(tunnelProvider('https://x.trycloudflare.com')).toBe('cloudflare');
    // Modal is gone — a `.modal.run`/`.modal.host` URL no longer
    // resolves to a provider.
    expect(tunnelProvider('https://y.modal.host')).toBeNull();
    expect(tunnelProvider('https://y.modal.run')).toBeNull();
    expect(tunnelProvider('https://example.com')).toBeNull();
    expect(tunnelProvider(undefined)).toBeNull();
  });

  it('strips the protocol', () => {
    expect(stripProtocol('https://abc.example.com/x')).toBe('abc.example.com/x');
    expect(stripProtocol('http://abc')).toBe('abc');
  });

  it('maps statuses to colors + labels', () => {
    expect(processStatusColor('running', COLORS)).toBe('#0f0');
    expect(processStatusColor('completed', COLORS)).toBe('#00f');
    expect(processStatusColor('failed', COLORS)).toBe('#f00');
    expect(processStatusLabel('running')).toContain('Running');
    expect(tunnelDotColor(true, COLORS)).toBe('#0f0');
    expect(tunnelDotColor(false, COLORS)).toBe('#f00');
    expect(tunnelDotColor(undefined, COLORS)).toBe('#888');
    expect(sessionDotColor('active', COLORS)).toBe('#0f0');
    expect(sessionDotColor('inactive', COLORS)).toBe('#888');
    expect(usageColor(10, COLORS)).toBe('#0f0');
    expect(usageColor(60, COLORS)).toBe('#ff0');
    expect(usageColor(90, COLORS)).toBe('#f00');
  });

  it('maps Claude session statuses to colors + labels', () => {
    expect(claudeSessionStatusColor('running', COLORS)).toBe('#0f0');
    expect(claudeSessionStatusColor('waiting', COLORS)).toBe('#00f');
    expect(claudeSessionStatusColor('idle', COLORS)).toBe('#ff0');
    expect(claudeSessionStatusLabel('running')).toBe('Running');
    expect(claudeSessionStatusLabel('waiting')).toBe('Waiting');
    expect(claudeSessionStatusLabel('idle')).toBe('Idle');
  });
});

describe('ansiToSpans', () => {
  it('returns a single default span for plain text', () => {
    expect(ansiToSpans('hello')).toEqual([
      { text: 'hello', color: undefined, bold: undefined, dim: undefined },
    ]);
  });

  it('applies fg color then resets', () => {
    const spans = ansiToSpans('\x1b[31mred\x1b[0m ok');
    expect(spans[0]).toMatchObject({ text: 'red', color: '#ef4444' });
    expect(spans[1]).toMatchObject({ text: ' ok', color: undefined });
  });

  it('tracks bold / dim intensity', () => {
    const spans = ansiToSpans('\x1b[1mB\x1b[22mN');
    expect(spans[0]).toMatchObject({ text: 'B', bold: true });
    expect(spans[1]).toMatchObject({ text: 'N', bold: undefined });
  });

  it('strips non-SGR escape sequences (cursor moves, clears)', () => {
    const spans = ansiToSpans('a\x1b[2Kb\x1b[1;1Hc');
    expect(spans.map((s) => s.text).join('')).toBe('abc');
  });

  it('returns empty array for empty input', () => {
    expect(ansiToSpans('')).toEqual([]);
  });
});
