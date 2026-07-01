/**
 * groupFileEditBlocks — consolidate a scope's file-edit tool blocks into one group.
 *
 * Mirrors `groupBlocksByAgent`'s identity-based grouping (see
 * `../groupBlocksByAgent.ts`): rather than starting a new group every time a
 * `Write` / `Edit` / `MultiEdit` block appears, ALL of a scope's file-edit tool_use
 * blocks (+ their matched `tool_result`) fold into ONE persistent group, positioned
 * at the first edit's location — robust to narration/other tool calls interleaved
 * between edits, exactly like a sub-agent's card accumulates non-contiguous output.
 * Non-edit blocks stay inline, split into their original relative runs, so
 * `consolidateBlocks` still pairs a non-edit tool_use with its own tool_result
 * (always adjacent in the stream — the SDK never interleaves a different tool
 * between a call and its own result) inside the same run.
 *
 * Only kicks in for 2+ edits in scope — a single file edit renders exactly as
 * before (no group wrapper for a one-off change; only a busy multi-edit turn is
 * the "long vertical stack of cards" this exists to fix).
 */

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

/** Tool names whose `tool_use` blocks this grouping consolidates. */
export const FILE_EDIT_TOOL_NAMES = new Set(['Write', 'Edit', 'MultiEdit']);

export function isFileEditToolUse(block: ClaudeStreamBlock): boolean {
  return block.type === 'tool_use' && !!block.toolName && FILE_EDIT_TOOL_NAMES.has(block.toolName);
}

export type FileEditSegment =
  | { type: 'other'; blocks: ClaudeStreamBlock[] }
  | { type: 'file-edits'; blocks: ClaudeStreamBlock[] };

export function groupFileEditBlocks(blocks: ClaudeStreamBlock[]): FileEditSegment[] {
  const editToolUseIds = new Set<string>();
  for (const block of blocks) {
    if (isFileEditToolUse(block) && block.id) editToolUseIds.add(block.id);
  }

  // Fewer than 2 edits in scope: nothing to consolidate — keep today's flat rendering.
  if (editToolUseIds.size < 2) {
    return blocks.length ? [{ type: 'other', blocks }] : [];
  }

  const segments: FileEditSegment[] = [];
  let editGroup: ClaudeStreamBlock[] | null = null;
  let otherGroup: ClaudeStreamBlock[] | null = null;

  for (const block of blocks) {
    const isEditResult = block.type === 'tool_result' && !!block.id && editToolUseIds.has(block.id);

    if (isFileEditToolUse(block) || isEditResult) {
      // Break the run of "other" blocks: a later non-edit block starts a FRESH
      // inline run after the group, it never folds back into the run above
      // (mirrors `groupBlocksByAgent`'s `mainGroup = null` on card creation).
      otherGroup = null;
      if (!editGroup) {
        editGroup = [];
        segments.push({ type: 'file-edits', blocks: editGroup });
      }
      editGroup.push(block);
      continue;
    }

    if (!otherGroup) {
      otherGroup = [];
      segments.push({ type: 'other', blocks: otherGroup });
    }
    otherGroup.push(block);
  }

  return segments;
}
