/**
 * groupBlocksByAgent — group a message's streamed blocks by sub-agent.
 *
 * Groups by `parent_tool_use_id` **IDENTITY** rather than by consecutive runs.
 *
 * The Claude Agent SDK streams a sub-agent's output with `parent_tool_use_id` set
 * to the spawning `Task` tool's id, but that output is NOT contiguous: the main
 * agent emits the `Task` invocation (and narration) between sub-agent steps, and
 * parallel sub-agents interleave (A,B,A,B…). The old "new group on every parent-id
 * switch" therefore shattered one logical sub-agent into many tiny cards. Here each
 * `parent_tool_use_id` gets exactly ONE group (created at its first appearance and
 * accumulating ALL its blocks, wherever they land in the stream); main-agent blocks
 * stay inline in order.
 *
 * The spawning `Task` tool_use (and its main-facing `tool_result`) are FOLDED into
 * the sub-agent's group as the header source — its `subagent_type` supplies the
 * agent designation and its `description` the "what it's doing" line — rather than
 * rendering the verbose `Task` invocation inline next to its own card. A `Task` that
 * has not yet streamed any captured child blocks falls through to the inline flow
 * (so it renders as a normal tool block until its sub-agent produces output).
 */

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

import type { MobileChatMessage } from './chatMessagesStore';

export interface BlockGroup {
  /** `null` for the main agent; a Task tool-use id for a sub-agent. */
  parentToolUseId: string | null;
  blocks: ClaudeStreamBlock[];
  /** Display name ("Github Specialist") — main agent uses `mainAgentName`. */
  agentName?: string;
  /** Type identifier ("github-specialist") — main agent uses `agentSetupId`. */
  agentType?: string;
  /**
   * Short "what it's doing" line from the spawning `Task` tool's
   * `input.description` ("Find the auth middleware") — distinguishes two
   * sub-agents of the SAME type. Absent for the main agent / when unknown.
   */
  taskDescription?: string;
}

/** Humanize a `subagent_type` slug into a display name ("qa-specialist" → "Qa Specialist"). */
function humanizeAgentType(slug: string): string {
  return slug
    .split('-')
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** The agent designation + task description carried by a `Task` tool_use block. */
interface TaskInfo {
  agentName?: string;
  agentType?: string;
  taskDescription?: string;
}

/**
 * Read the sub-agent designation + description off a `Task` tool_use block.
 * Mirrors the backend `StreamHandler` fallback (`subagent_type` → `agent_type` →
 * `general-purpose`) so a Task that omitted `subagent_type` still gets a name
 * instead of the bare "Sub-agent".
 */
function taskInfoFromBlock(block: ClaudeStreamBlock): TaskInfo | null {
  if (!(block.type === 'tool_use' && block.toolName === 'Task')) return null;
  const input = block.toolInput as
    | { subagent_type?: string; agent_type?: string; description?: string }
    | undefined;
  const slug = input?.subagent_type || input?.agent_type;
  const taskDescription =
    typeof input?.description === 'string' && input.description.trim()
      ? input.description.trim()
      : undefined;
  if (!slug && !taskDescription) return null;
  return {
    agentType: slug,
    agentName: slug ? humanizeAgentType(slug) : undefined,
    taskDescription,
  };
}

/** Find the `Task` tool that spawned `parentToolUseId` and return its agent info. */
export function findTaskForParentId(
  parentToolUseId: string,
  currentBlocks: ClaudeStreamBlock[],
  allMessages?: MobileChatMessage[],
  currentMessageIndex?: number
): TaskInfo | null {
  const fromBlock = (block: ClaudeStreamBlock): TaskInfo | null =>
    block.id === parentToolUseId ? taskInfoFromBlock(block) : null;

  for (const block of currentBlocks) {
    const hit = fromBlock(block);
    if (hit) return hit;
  }

  if (allMessages && currentMessageIndex !== undefined) {
    for (let i = currentMessageIndex - 1; i >= 0; i--) {
      const blocks = allMessages[i]?.blocks;
      if (!blocks) continue;
      for (const block of blocks) {
        const hit = fromBlock(block);
        if (hit) return hit;
      }
    }
  }

  return null;
}

export function groupBlocksByAgent(
  blocks: ClaudeStreamBlock[],
  allMessages?: MobileChatMessage[],
  currentMessageIndex?: number,
  mainAgentName?: string,
  agentSetupId?: string
): BlockGroup[] {
  // Parent ids that ACTUALLY have streamed child blocks. Only these fold their
  // spawning `Task` into a card; a Task whose sub-agent hasn't produced output yet
  // stays inline (rendered as a normal tool block) until its first child arrives.
  const childParentIds = new Set<string>();
  for (const block of blocks) {
    const parentId = block.parent_tool_use_id ?? null;
    if (parentId) childParentIds.add(parentId);
  }

  const groups: BlockGroup[] = [];
  const subGroupByParent = new Map<string, BlockGroup>();
  let mainGroup: BlockGroup | null = null;

  // Create (positioned at first appearance) or fetch the card for a sub-agent.
  const ensureSubGroup = (parentId: string): BlockGroup => {
    let group = subGroupByParent.get(parentId);
    if (!group) {
      const info = findTaskForParentId(parentId, blocks, allMessages, currentMessageIndex);
      group = {
        parentToolUseId: parentId,
        blocks: [],
        agentName: info?.agentName,
        agentType: info?.agentType,
        taskDescription: info?.taskDescription,
      };
      subGroupByParent.set(parentId, group);
      groups.push(group);
      // The card breaks the inline run: a following main-agent block starts a
      // fresh inline group AFTER the card (it never folds back into the run above).
      mainGroup = null;
    }
    return group;
  };

  for (const block of blocks) {
    const parentId = block.parent_tool_use_id ?? null;

    // Fold the spawning `Task` tool_use into its sub-agent's card (header source) —
    // don't render the verbose invocation inline next to the card it spawned.
    if (
      block.type === 'tool_use' &&
      block.toolName === 'Task' &&
      block.id &&
      childParentIds.has(block.id)
    ) {
      ensureSubGroup(block.id);
      continue;
    }

    // Fold the `Task`'s main-facing `tool_result` (the sub-agent's returned summary).
    // `consolidateBlocks` drops a lone `tool_result` on render anyway, so dropping it
    // here keeps the card's block count = the sub-agent's own visible blocks.
    if (
      block.type === 'tool_result' &&
      parentId === null &&
      block.id &&
      childParentIds.has(block.id)
    ) {
      ensureSubGroup(block.id);
      continue;
    }

    // A sub-agent block → its card (accumulates regardless of interleaving).
    if (parentId) {
      ensureSubGroup(parentId).blocks.push(block);
      continue;
    }

    // Main-agent block → inline group (consecutive main blocks merge).
    if (!mainGroup) {
      mainGroup = {
        parentToolUseId: null,
        blocks: [],
        agentName: mainAgentName,
        agentType: agentSetupId,
      };
      groups.push(mainGroup);
    }
    mainGroup.blocks.push(block);
  }

  return groups;
}
