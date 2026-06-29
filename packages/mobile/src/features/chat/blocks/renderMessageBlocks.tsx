/**
 * renderMessageBlocks — consolidate + render a message's blocks.
 *
 * The store keeps a `tool_use` and its `tool_result` as separate blocks; this
 * pairs them (`consolidateBlocks`) and renders each via `BlockRenderer`, the
 * single integration seam the MessageList uses so a message body shows real
 * native block content instead of one-line summaries.
 */

import { Fragment, type ReactNode } from 'react';

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';
import type { MessageAction } from '@vgit2/shared/types';

import { BlockRenderer } from './BlockRenderer';
import { consolidateBlocks } from './blockHelpers';

/**
 * Render a list of streamed blocks (tool_use paired with its tool_result).
 *
 * Keys are position-namespaced (`prefix-index-blockId`): the consolidated list
 * is append-only, so the index is stable, and the namespace guarantees sibling
 * uniqueness even if the server ever redelivers a block with the same
 * blockId/id (a bare `block.blockId` key produced React's "two children with
 * the same key" warning on every such redelivery).
 *
 * `onActionClick` is forwarded to each `BlockRenderer` so an `actions` block's
 * `MessageAction` chips fire their handler.
 */
export function renderMessageBlocks(
  blocks: ClaudeStreamBlock[],
  keyPrefix: string,
  onActionClick?: (action: MessageAction) => void
): ReactNode {
  return consolidateBlocks(blocks).map(({ block, result }, i) => (
    <Fragment key={`${keyPrefix}-${i}-${block.blockId ?? block.id ?? block.type}`}>
      <BlockRenderer block={block} result={result} onActionClick={onActionClick} />
    </Fragment>
  ));
}
