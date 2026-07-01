/**
 * renderMessageBlocks — group + consolidate + render a message's blocks.
 *
 * `groupFileEditBlocks` pulls a scope's `Write`/`Edit`/`MultiEdit` tool blocks
 * into one `FileEditGroup` widget (the same "group by identity" treatment
 * `groupBlocksByAgent` gives sub-agent output), so a busy multi-file turn renders
 * one consolidated card instead of a stack of edit cards. Everything else renders
 * exactly as before via `renderConsolidatedBlocks` — the single integration seam
 * the MessageList uses so a message body shows real native block content instead
 * of one-line summaries.
 */

import type { ReactNode } from 'react';

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';
import type { MessageAction } from '@vgit2/shared/types';

import { FileEditGroup } from './FileEditGroup';
import { groupFileEditBlocks } from './groupFileEditBlocks';
import { renderConsolidatedBlocks } from './renderConsolidatedBlocks';

/**
 * Render a list of streamed blocks, consolidating consecutive/related file-edit
 * blocks into a single `FileEditGroup` widget first (see module docs).
 */
export function renderMessageBlocks(
  blocks: ClaudeStreamBlock[],
  keyPrefix: string,
  onActionClick?: (action: MessageAction) => void
): ReactNode {
  return groupFileEditBlocks(blocks).flatMap((segment, si) => {
    if (segment.type === 'file-edits') {
      return [
        <FileEditGroup
          key={`${keyPrefix}-edits-${si}`}
          blocks={segment.blocks}
          keyPrefix={`${keyPrefix}-edits-${si}`}
          onActionClick={onActionClick}
        />,
      ];
    }
    return renderConsolidatedBlocks(segment.blocks, `${keyPrefix}-${si}`, onActionClick);
  });
}
