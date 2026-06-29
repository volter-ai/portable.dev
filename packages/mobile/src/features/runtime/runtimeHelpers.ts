/**
 * Pure runtime formatting + status helpers (web `RuntimeOverviewInstance` /
 * `RuntimeStorageInstance` parity). Framework-free so they unit-test without a
 * renderer. Colors resolve from `theme.colors` at the call site (a `ThemeColors`
 * subset) so the helpers stay theme-agnostic.
 */

import { getRepoFromPath } from '@vgit2/shared/utils/pathHelpers';
import type { ClaudeSessionStatus, ProcessData } from '@vgit2/shared/types';

/** Human-readable byte size (web `formatBytes` parity). */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[i]}`;
}

/** Sandbox uptime as `Xd Yh Zm` / `Yh Zm` / `Zm` / `Ns` (web metrics parity). */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

/**
 * Elapsed-since label for a resource created/started at `tsMs` (web "elapsed
 * time" cards). Tolerates second-precision timestamps and clock skew → never
 * negative. `now` is injectable for deterministic tests.
 */
export function formatElapsed(tsMs: number, now: number = Date.now()): string {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return '';
  // A timestamp that looks like seconds (< ~year 2001 in ms) is upgraded to ms.
  const ms = tsMs < 1e11 ? tsMs * 1000 : tsMs;
  const diff = Math.max(0, now - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export type TunnelProvider = 'cloudflare' | null;

/**
 * Which provider hosts a dev-server tunnel URL (the CF badge). Local-first:
 * the old remote provider is gone, so there is NO legacy host detection
 * — dev-server tunnels are Cloudflare Quick Tunnels (`*.trycloudflare.com`).
 */
export function tunnelProvider(url: string | undefined): TunnelProvider {
  if (!url) return null;
  if (url.includes('.trycloudflare.com')) return 'cloudflare';
  return null;
}

/** Strip the protocol from a tunnel URL for compact display (web parity). */
export function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

/** `owner/repo` from a Claude-workspace repo path, or null. */
export function repoLabel(repoPath: string | undefined): string | null {
  return getRepoFromPath(repoPath);
}

/** GitHub owner avatar URL (16–64px) — same source the web cards use. */
export function ownerAvatarUrl(repoPath: string | undefined, size = 48): string | null {
  const full = getRepoFromPath(repoPath);
  const owner = full?.split('/')[0];
  return owner ? `https://github.com/${owner}.png?size=${size}` : null;
}

/** Minimal color subset the helpers index into (a `ThemeColors` slice). */
export interface RuntimeStatusColors {
  success: string;
  danger: string;
  info: string;
  warning: string;
  textTertiary: string;
}

/** Dot color for a background process (web: running=green / completed=blue / failed=red). */
export function processStatusColor(status: ProcessData['status'], c: RuntimeStatusColors): string {
  if (status === 'running') return c.success;
  if (status === 'completed') return c.info;
  if (status === 'failed') return c.danger;
  return c.textTertiary;
}

/** Glyph + label for a process status (text glyphs — FontAwesome is web-only). */
export function processStatusLabel(status: ProcessData['status']): string {
  if (status === 'running') return '▶ Running';
  if (status === 'completed') return '✓ Completed';
  if (status === 'failed') return '✗ Failed';
  return status;
}

/** Dot color for a tunnel (web: active=green / inactive=red / unknown=gray). */
export function tunnelDotColor(active: boolean | undefined, c: RuntimeStatusColors): string {
  if (active === true) return c.success;
  if (active === false) return c.danger;
  return c.textTertiary;
}

/** Dot color for a runtime session (active=green / else gray). */
export function sessionDotColor(status: string | undefined, c: RuntimeStatusColors): string {
  return status === 'active' ? c.success : c.textTertiary;
}

/**
 * Dot/badge color for a live Claude session: running=green,
 * waiting-on-permission=blue, idle (reap candidate)=amber.
 */
export function claudeSessionStatusColor(
  status: ClaudeSessionStatus,
  c: RuntimeStatusColors
): string {
  if (status === 'running') return c.success;
  if (status === 'waiting') return c.info;
  return c.warning; // idle
}

/** Short status label for a Claude session (text glyphs — FontAwesome is web-only). */
export function claudeSessionStatusLabel(status: ClaudeSessionStatus): string {
  if (status === 'running') return 'Running';
  if (status === 'waiting') return 'Waiting';
  return 'Idle';
}

/** Usage-bar color by percent (web `getUsageColor`: <50 green / <75 orange / red). */
export function usageColor(percent: number, c: RuntimeStatusColors): string {
  if (percent < 50) return c.success;
  if (percent < 75) return c.warning;
  return c.danger;
}

export const DEVICE_EMOJI = { mobile: '📱', desktop: '🖥️' } as const;
