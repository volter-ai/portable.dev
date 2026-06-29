/**
 * blockHelpers — shared block utilities for the native BlockRenderer.
 *
 * Block helpers (`consolidateBlocks` / `ReadBlock.detectLanguage`) trimmed to
 * what the native renderers need. In the
 * RN streaming store a `tool_use` and its `tool_result` are SEPARATE blocks on
 * the same message, so `consolidateBlocks`
 * pairs each `tool_use` with its matching `tool_result` here, and the renderers
 * read the result text via `getToolResultText`.
 */

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

/** The result half of a tool block (the matching `tool_result`). */
export interface ToolResult {
  content?: unknown;
  is_error?: boolean;
}

/**
 * True for a content item that carries MEDIA (an `image`/`video` content block, or a
 * bare `{ source: { data | url } }`) — these render as native ImageBlock/VideoBlock, so
 * they must NEVER be stringified into a tool block's text (that leaked the raw base64 /
 * `{type:"image",...}` JSON the user saw instead of the picture).
 */
function isMediaResultItem(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const it = item as { type?: string; source?: { data?: unknown; url?: unknown } };
  if (it.type === 'image' || it.type === 'video') return true;
  return !!it.source && (it.source.data != null || it.source.url != null);
}

/** Extract displayable text from a tool result. */
export function getToolResultText(result: unknown): string {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result
      .filter((item) => !isMediaResultItem(item))
      .map((item) => (typeof item === 'string' ? item : ((item as { text?: string })?.text ?? '')))
      .filter(Boolean)
      .join('\n');
  }
  // A lone media object (the screenshot/video item) → render nothing here; the native
  // ImageBlock/VideoBlock shows it. Never JSON.stringify a base64 source into the chat.
  if (isMediaResultItem(result)) return '';
  const obj = result as { text?: string };
  if (obj.text) return obj.text;
  return JSON.stringify(result, null, 2);
}

/** True when a tool result carries the SDK error flag. */
export function isToolResultError(result: ToolResult | undefined): boolean {
  return result?.is_error === true;
}

/**
 * Pair each `tool_use` with its matching `tool_result` (by id) and drop the now-
 * merged standalone `tool_result` blocks. Non-tool blocks pass through. Operates
 * on the wire `ClaudeStreamBlock`s the RN store holds.
 */
export interface ConsolidatedBlock {
  block: ClaudeStreamBlock;
  result?: ToolResult;
}

export function consolidateBlocks(blocks: ClaudeStreamBlock[]): ConsolidatedBlock[] {
  const results = new Map<string, ToolResult>();
  for (const b of blocks) {
    if (b.type === 'tool_result' && b.id) {
      results.set(b.id, { content: b.content, is_error: b.is_error });
    }
  }

  const out: ConsolidatedBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'tool_result') continue; // merged into its tool_use
    if (b.type === 'tool_use' && b.id) {
      out.push({ block: b, result: results.get(b.id) });
    } else {
      out.push({ block: b });
    }
  }
  return out;
}

/** Extract a tool block's input object (typed loosely — the wire field is `unknown`). */
export function toolInput(block: ClaudeStreamBlock): Record<string, unknown> {
  const input = block.toolInput;
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

/** Basename of a path (`/a/b/c.ts` → `c.ts`). */
export function fileName(path: string): string {
  if (!path) return '';
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/**
 * Map a filename to a syntax-highlighting language id. Unknown extensions fall
 * back to `text`.
 */
export function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    rb: 'ruby',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cs: 'csharp',
    php: 'php',
    go: 'go',
    rs: 'rust',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'bash',
    ps1: 'powershell',
    sql: 'sql',
    html: 'html',
    xml: 'xml',
    css: 'css',
    scss: 'css',
    less: 'css',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    md: 'markdown',
    markdown: 'markdown',
    dockerfile: 'docker',
  };
  return langMap[ext] || 'text';
}

/** Truncate a single-line preview for a collapsed header. */
export function preview(value: string, max = 60): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

/**
 * Interaction-block dispatch predicates. The `request_user_secrets` /
 * `request_user_connection` / `needsPermission` checks: each interaction block is
 * a `tool_use` distinguished by its `toolName` (one of several MCP aliases) plus a
 * required `toolInput` key.
 */
const SECRETS_TOOLS = new Set(['request_user_secrets', 'mcp__standard__request_user_secrets']);
const CONNECTION_TOOLS = new Set([
  'request_user_connection',
  'mcp__standard__request_user_connection',
  'mcp__run-connection__request_user_connection',
]);

/** A `request_user_secrets` tool carrying a `secrets` list → native `SecretsBlock`. */
export function isSecretsBlock(block: ClaudeStreamBlock): boolean {
  return (
    block.type === 'tool_use' &&
    !!block.toolName &&
    SECRETS_TOOLS.has(block.toolName) &&
    !!toolInput(block).secrets
  );
}

/** A `request_user_connection` tool naming a `service` → native `ConnectionRequestBlock`. */
export function isConnectionRequestBlock(block: ClaudeStreamBlock): boolean {
  return (
    block.type === 'tool_use' &&
    !!block.toolName &&
    CONNECTION_TOOLS.has(block.toolName) &&
    !!toolInput(block).service
  );
}

/** True when a tool block is awaiting an approve/deny decision (wire `needsPermission`). */
export function needsPermission(block: ClaudeStreamBlock): boolean {
  return block.needsPermission === true;
}

/** The id the backend keys a permission response on (falls back to `block.id`). */
export function permissionRequestId(block: ClaudeStreamBlock): string | undefined {
  const explicit = block.permissionRequestId;
  if (typeof explicit === 'string' && explicit) return explicit;
  return block.id;
}
