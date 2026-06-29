/**
 * Pure helpers for the MCP Servers settings section — the framework-free
 * copy/derivation logic plus the `McpIcon` resolution priority.
 *
 * Copy strings are EXACT — never reword them:
 *   - category labels: 'Automation' / 'Development' / 'Productivity' /
 *     'Platform' / 'Media' / 'Other'
 *   - status labels: 'Available' / 'Configuration Required' / 'Disabled'
 *   - tool count: `${n} tool` / `${n} tools`
 *   - requirements: `Missing: ${requirements.join(', ')}`
 */

import type { GetMcpsAvailableResponse } from '@vgit2/shared/types';

/**
 * `McpStatus` is not re-exported from the `@vgit2/shared/types` barrel (only
 * the response wrapper is) — derive it instead of touching the shared package.
 */
export type McpStatus = GetMcpsAvailableResponse['mcps'][number];

/** Exact user-facing category labels — do not reword. */
export const MCP_CATEGORY_LABELS: Record<string, string> = {
  automation: 'Automation',
  development: 'Development',
  productivity: 'Productivity',
  platform: 'Platform',
  media: 'Media',
  other: 'Other',
};

/** Resolve the user-facing category label (missing category → 'Other'). */
export function getMcpCategoryLabel(mcp: Pick<McpStatus, 'category'>): string {
  const category = mcp.category || 'other';
  return MCP_CATEGORY_LABELS[category] || category;
}

/** Status badge config: exact label + glyph; `tone` maps to a theme color. */
export interface McpStatusConfig {
  label: string;
  glyph: string;
  tone: 'success' | 'warning' | 'muted';
}

/** Status config — success ✓ / warning ⚠️ / textTertiary ○. */
export const MCP_STATUS_CONFIG: Record<McpStatus['status'], McpStatusConfig> = {
  available: { label: 'Available', glyph: '✓', tone: 'success' },
  missing_token: { label: 'Configuration Required', glyph: '⚠️', tone: 'warning' },
  disabled: { label: 'Disabled', glyph: '○', tone: 'muted' },
};

/** Tool-count copy: `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`. */
export function formatToolCount(toolCount: number): string {
  return `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`;
}

/** Requirements copy: `Missing: ${requirements.join(', ')}`. */
export function formatMissingRequirements(requirements: string[]): string {
  return `Missing: ${requirements.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Icon resolution (`McpIcon` priority, RN-adapted)
// ---------------------------------------------------------------------------

/** Minimal icon data — works for both `McpStatus` and `McpMetadata`. */
export interface McpIconData {
  name: string;
  icon?: string;
  websiteUrl?: string;
  colorTheme?: string;
}

/**
 * Emoji predicate for the icon field. A naive `/\p{Emoji}/u` matches false
 * positives; RN renders the glyph DIRECTLY as `Text`, so the predicate must not
 * match digits / URLs / `fa:` names (all of which contain `\p{Emoji}`-property
 * characters like `0-9`). `Extended_Pictographic` is the proper "looks like an
 * emoji" property.
 */
export function isEmojiIcon(icon: string): boolean {
  if (icon.startsWith('http://') || icon.startsWith('https://') || icon.startsWith('fa:')) {
    return false;
  }
  return /\p{Extended_Pictographic}/u.test(icon);
}

/** Google s2 favicon URL. */
export function getFaviconUrl(websiteUrl: string, size = 64): string {
  try {
    const domain = new URL(websiteUrl).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`;
  } catch {
    return '';
  }
}

/** Resolved icon render strategy, in priority order. */
export type McpIconSource =
  | { kind: 'emoji'; emoji: string }
  | { kind: 'image'; uri: string }
  | { kind: 'fallback'; letter: string };

/**
 * `McpIcon` priority order — DO NOT reorder:
 *   1. emoji icon (RN: rendered as a `Text` glyph — no Fluent CDN)
 *   2. `fa:` icons are unimplemented → fall through
 *   3. custom `http(s)://` icon URL → image
 *   4. website favicon → image
 *   5. colored box with the first letter (fallback)
 */
export function resolveMcpIconSource(
  mcp: Pick<McpIconData, 'name' | 'icon' | 'websiteUrl'>
): McpIconSource {
  if (mcp.icon) {
    if (isEmojiIcon(mcp.icon)) {
      return { kind: 'emoji', emoji: mcp.icon };
    }
    // 'fa:' icons: unimplemented, falls through.
    if (mcp.icon.startsWith('http://') || mcp.icon.startsWith('https://')) {
      return { kind: 'image', uri: mcp.icon };
    }
  }
  if (mcp.websiteUrl) {
    const uri = getFaviconUrl(mcp.websiteUrl);
    if (uri) {
      return { kind: 'image', uri };
    }
  }
  return { kind: 'fallback', letter: (mcp.name.charAt(0) || '?').toUpperCase() };
}
