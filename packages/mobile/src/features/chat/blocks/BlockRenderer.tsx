/**
 * BlockRenderer — native block dispatch scaffold.
 *
 * Takes a single streamed `ClaudeStreamBlock` (+ its matched `tool_result`) and
 * dispatches to the right native renderer by `block.type`, and for `tool_use`
 * blocks by `toolName`. The dispatch covers:
 *   - core text / file blocks
 *   - media / tool / agent blocks (image, video, Playwright, generic tool, Todo,
 *     Tunnel, ExitPlanMode, Actions, WebSearch, WebFetch)
 *   - interaction blocks (Permission, Secrets, ConnectionRequest)
 *   - the GitHub block set + the `error` block + the completion check
 *
 * Extension points are the `TOOL_RENDERERS` map (exact `toolName`),
 * `resolveToolRenderer` (prefix / multi-name tools), `resolveGitHubRenderer`
 * (GitHub entity `block.type`s), and the `block.type` switch. A `tool_use` with
 * no specialised renderer falls through to the GENERIC `ToolBlock` (a real native
 * block), NOT the fallback; the `error` block and the GitHub entity blocks
 * dispatch to native components too, so the visible `FallbackBlock` placeholder
 * (which NEVER dumps raw JSON) is the last resort for a genuinely unknown block
 * type only.
 */

import { memo, type ComponentType } from 'react';

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';
import type { MessageAction } from '@vgit2/shared/types';

import {
  ActionsBlock,
  ExitPlanModeBlock,
  TodoBlock,
  ToolBlock,
  type ToolBlockProps,
} from './AgentToolBlocks';
import { BashBlock, BashOutputBlock } from './BashBlock';
import { ErrorBlock } from './ErrorBlock';
import { EditBlock, ReadBlock, WriteBlock } from './FileBlocks';
import { FallbackBlock } from './FallbackBlock';
import { resolveGitHubRenderer } from './GitHubBlocks';
import { ConnectionRequestBlock, PermissionBlock, SecretsBlock } from './InteractionBlocks';
import { ImageBlock, VideoBlock } from './MediaBlocks';
import { GlobBlock, GrepBlock } from './SearchBlocks';
import { TextBlock } from './TextBlock';
import { PlaywrightBlock, TunnelBlock, WebFetchBlock, WebSearchBlock } from './WebToolBlocks';
import {
  isConnectionRequestBlock,
  isSecretsBlock,
  needsPermission,
  type ToolResult,
} from './blockHelpers';

export interface BlockRendererProps {
  block: ClaudeStreamBlock;
  /** The matched `tool_result` for a `tool_use` block (paired by `consolidateBlocks`). */
  result?: ToolResult;
  /** Auto-expand the block (recent tool blocks auto-expand). */
  isRecent?: boolean;
  /**
   * Tap handler for an `actions` block's `MessageAction` chips. Threaded
   * down from `ActiveChatScreen` so the buttons actually send / pre-fill; absent
   * (e.g. block-renderer unit tests) ⇒ the chips render but are inert.
   */
  onActionClick?: (action: MessageAction) => void;
}

/**
 * `toolName` → native renderer, for tools matched by their EXACT wire name (the
 * Claude Agent SDK names). Keys must equal the wire `toolName`. Prefix / aliased
 * tools (Playwright, tunnel…) are matched in
 * `resolveToolRenderer` below; everything unmatched falls through to `ToolBlock`.
 */
export const TOOL_RENDERERS: Record<string, ComponentType<ToolBlockProps>> = {
  Bash: BashBlock,
  BashOutput: BashOutputBlock,
  Read: ReadBlock,
  Write: WriteBlock,
  Edit: EditBlock,
  Grep: GrepBlock,
  Glob: GlobBlock,
  TodoWrite: TodoBlock,
  ExitPlanMode: ExitPlanModeBlock,
  WebSearch: WebSearchBlock,
  WebFetch: WebFetchBlock,
};

/**
 * Resolve the renderer for a `tool_use` block. Exact-name matches come from
 * `TOOL_RENDERERS`; the remaining branches cover prefix / multi-name / aliased
 * tools (matched via `startsWith` / OR conditions). Returns
 * `undefined` when no specialised renderer exists → the GENERIC `ToolBlock`.
 */
export function resolveToolRenderer(toolName: string): ComponentType<ToolBlockProps> | undefined {
  if (TOOL_RENDERERS[toolName]) return TOOL_RENDERERS[toolName];
  // NB: `mcp__standard__display_video` is NOT mapped here — its tool_result is only a
  // text confirmation pointing at a local PC path. The PC copies that file into the
  // served media dir and emits the playable video as a SEPARATE `video` block (see
  // MediaProcessingService.processDisplayVideo), which renders via `VideoBlock` below;
  // the tool_use itself falls through to the generic ToolBlock.
  if (toolName.startsWith('mcp__playwright__browser_')) return PlaywrightBlock;
  if (toolName === 'mcp__standard__create_tunnel' || toolName === 'mcp__standard__show_tunnel') {
    return TunnelBlock;
  }
  return undefined;
}

export const BlockRenderer = memo(function BlockRenderer({
  block,
  result,
  isRecent,
  onActionClick,
}: BlockRendererProps) {
  // Text block → Markdown.
  if (block.type === 'text') {
    return <TextBlock content={block.content ?? block.text ?? ''} />;
  }

  // Tool-use block.
  if (block.type === 'tool_use') {
    // Interaction blocks — secrets / connection requests are their
    // OWN inline surface, not a collapsible tool block.
    if (isSecretsBlock(block)) {
      return <SecretsBlock block={block} />;
    }
    if (isConnectionRequestBlock(block)) {
      return <ConnectionRequestBlock block={block} />;
    }

    // Otherwise: specialised renderer, else the generic ToolBlock.
    const Renderer = block.toolName ? resolveToolRenderer(block.toolName) : undefined;
    const inner = Renderer ? (
      <Renderer block={block} result={result} isRecent={isRecent} />
    ) : (
      // No specialised renderer (Task, unknown MCP tool…) → real generic block, never raw JSON.
      <ToolBlock block={block} result={result} isRecent={isRecent} />
    );

    // Permission gate — wraps the underlying tool block with an
    // approve/deny prompt while it awaits a decision; the response emit is wired separately.
    if (needsPermission(block)) {
      return (
        <PermissionBlock block={block} result={result}>
          {inner}
        </PermissionBlock>
      );
    }
    return inner;
  }

  // Media / actions content blocks.
  if (block.type === 'image') {
    return <ImageBlock block={block} />;
  }
  if (block.type === 'video') {
    return <VideoBlock block={block} />;
  }
  if (block.type === 'actions') {
    return <ActionsBlock block={block} onActionClick={onActionClick} />;
  }

  // Inline error block — the `errorBlock` payload of `claude:error`.
  if (block.type === 'error') {
    return <ErrorBlock block={block} />;
  }

  // GitHub entity blocks — issue / PR / branch / workflow-run /
  // commit / comment / repo. Keyed on `block.type` via the GitHub renderer table.
  const GitHubRenderer = resolveGitHubRenderer(block.type);
  if (GitHubRenderer) {
    return <GitHubRenderer block={block} />;
  }

  // Genuinely unknown block type → the visible placeholder (never raw JSON).
  return <FallbackBlock block={block} />;
});

/**
 * Completion-check coverage checklist: every block type / tool the native
 * `BlockRenderer` dispatches to a real renderer. The
 * AC requires "at least one fixture message per block type … renders without
 * error … no block falls back to raw-JSON rendering" — the integration test
 * iterates this list and asserts each dispatches (no `block-fallback`). Device-
 * only visual parity (iOS + Android screenshot match) is the deferred final pass.
 */
export const BLOCK_COVERAGE = {
  /** `block.type` values dispatched directly (non-`tool_use`). */
  blockTypes: [
    'text',
    'image',
    'video',
    'actions',
    'error',
    'github_issue',
    'github_pr',
    'github_pull_request',
    'github_branch',
    'github_workflow',
    'github_workflow_run',
    'github_commit',
    'github_comment',
    'github_repo',
    'github_repository',
  ] as const,
  /** `tool_use` tool names with a specialised renderer (others → generic ToolBlock). */
  toolNames: [
    'Bash',
    'BashOutput',
    'Read',
    'Write',
    'Edit',
    'Grep',
    'Glob',
    'TodoWrite',
    'ExitPlanMode',
    'WebSearch',
    'WebFetch',
    'mcp__playwright__browser_*',
    'mcp__standard__create_tunnel',
    'mcp__standard__show_tunnel',
    'request_user_secrets',
    'request_user_connection',
  ] as const,
} as const;
