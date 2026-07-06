/**
 * ClaudeProjects transcript reader.
 *
 * Reverse-maps the Claude Agent SDK's own `~/.claude/projects/<slug>/<session>.jsonl`
 * transcript into the portable `BufferedMessage[]` wire shape the mobile client
 * already consumes — so a conversation the SDK wrote (whether started in portable OR
 * in the PC terminal `claude`) renders in the app with NO duplicate SQLite stream.
 *
 * The JSONL is a heterogeneous, type-discriminated log (Claude CLI 2.1.x). Empirical
 * facts this reader is built on (verified on disk):
 *  - The FILE has NO `system`/`init` line — `session_id` comes from the FILENAME, and
 *    `cwd` from any conversational line. Don't require an init header.
 *  - An assistant TURN is split across N records (thinking / text / tool_use), all
 *    sharing one `message.id`. A `user` line is either a human message (string content)
 *    OR a tool result (array content with a `tool_result` block).
 *  - Title carriers drifted: current CLIs use `ai-title {aiTitle}` (+ user override
 *    `custom-title {customTitle}`); older CLIs used `summary {summary}`. Handle all.
 *  - JSONL has only UUIDs — the per-chat monotonic numeric `id` the cursor/merge stack
 *    depends on is SYNTHESIZED here (sequential by transcript order).
 *
 * This module is PURE (no fs) so it is unit-tested against a golden fixture.
 */

import { stripTaskNotifications } from '@vgit2/shared/utils/taskNotificationHelpers';

import type { MessageRow } from '../JsonDbAdapter/JsonChatStore.js';

/** A single parsed JSONL record (only the fields this reader reads are typed). */
export interface TranscriptLine {
  type?: string;
  subtype?: string;
  isMeta?: boolean;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  version?: string;
  // user / assistant
  message?: {
    role?: string;
    id?: string;
    model?: string;
    content?: string | TranscriptBlock[];
    stop_reason?: string | null;
  };
  // control / meta carriers
  aiTitle?: string;
  customTitle?: string;
  summary?: string;
  [key: string]: unknown;
}

interface TranscriptBlock {
  type?: string;
  text?: string;
  thinking?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  is_error?: boolean | null;
  content?: unknown;
}

/** Line `type`s that are control/meta and never render in the chat view. */
const META_TYPES = new Set([
  'ai-title',
  'custom-title',
  'last-prompt',
  'summary',
  'queue-operation',
  'attachment',
  'mode',
  'permission-mode',
  'file-history-snapshot',
  'system',
  'pr-link',
  'agent-name',
  'worktree-state',
]);

/** Parse a JSONL transcript string into records, skipping blank/unparseable lines. */
export function parseTranscript(jsonl: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const raw of jsonl.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      // Only real records are objects. Drop a valid-JSON primitive / null / array so a
      // stray line can never null-deref the consumers (this reader must NEVER throw —
      // it parses an externally-written file).
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as TranscriptLine);
      }
    } catch {
      // A torn/partial last line (the SDK may be mid-write) — skip it, never throw.
    }
  }
  return out;
}

/** True if a user string message is a slash-command invocation (not a real turn). */
function isSlashCommandContent(content: string): boolean {
  const t = content.trimStart();
  return (
    t.startsWith('<command-name>') ||
    t.startsWith('<command-message>') ||
    t.startsWith('<local-command')
  );
}

/** Coerce a tool_result `content` (string | block array) into a display string. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object') {
          const blk = b as TranscriptBlock;
          if (typeof blk.text === 'string') return blk.text;
          if (blk.type === 'image') return '[image]';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function parseTs(ts: string | undefined, fallback: number): number {
  if (!ts) return fallback;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : fallback;
}

/**
 * Reverse-map parsed transcript records → portable `MessageRow[]` (= BufferedMessage),
 * exploding each assistant `message.content[]` block into its OWN `claude_code_block`
 * row (the shape the mobile renderer + the getMessagesAfterId Task-anchor depend on).
 * Synthesizes a monotonic numeric `id` per row (sequential by transcript order).
 *
 * @param lines - parsed transcript records (in file order)
 * @param idBase - first synthesized id (default 1). Lets callers offset into a shared id space.
 */
export function transcriptToMessages(lines: TranscriptLine[], idBase = 1): MessageRow[] {
  const rows: MessageRow[] = [];
  let nextId = idBase;
  // Monotonic fallback timestamp so rows keep a stable order even if a line lacks one.
  let lastTs = 0;

  const emit = (type: string, data: unknown, ts: number) => {
    rows.push({ id: nextId++, type, data, timestamp: ts });
  };

  for (const line of lines) {
    if (line.isMeta) continue;
    const type = line.type;
    if (!type || META_TYPES.has(type)) continue;

    const ts = parseTs(line.timestamp, lastTs + 1);
    lastTs = Math.max(lastTs, ts);

    if (type === 'user') {
      const content = line.message?.content;
      if (typeof content === 'string') {
        if (isSlashCommandContent(content)) continue;
        emit('user_message', { content }, ts);
      } else if (Array.isArray(content)) {
        // A user line can carry tool_result blocks AND/OR human text (Claude Code
        // records a pending tool_result together with a queued follow-up prompt in one
        // line). Emit BOTH, non-exclusively, in array order — dropping the text would
        // silently lose a real human message.
        for (const b of content) {
          if (b?.type === 'tool_result') {
            emit(
              'claude_code_block',
              {
                type: 'tool_result',
                id: b.tool_use_id,
                // DISTINCT from the tool_use's blockId (= tool_use_id) so the mobile
                // join-history dedup (blockId-only) doesn't collapse the result into the
                // use; `id` stays the tool_use_id so consolidation still PAIRS them.
                blockId: b.tool_use_id ? `${b.tool_use_id}:result` : undefined,
                content: toolResultText(b.content),
                is_error: b.is_error === true,
              },
              ts
            );
          }
        }
        const text = content
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n');
        if (text && !isSlashCommandContent(text)) emit('user_message', { content: text }, ts);
      }
      continue;
    }

    if (type === 'assistant') {
      const content = line.message?.content;
      const msgId = line.message?.id;
      if (!Array.isArray(content)) continue;
      let blockIdx = 0;
      for (const b of content) {
        const blockId = b.id ?? (msgId ? `${msgId}-${blockIdx}` : undefined);
        blockIdx++;
        if (b.type === 'text' && typeof b.text === 'string') {
          emit('claude_code_block', { type: 'text', content: b.text, blockId }, ts);
        } else if (b.type === 'tool_use') {
          emit(
            'claude_code_block',
            {
              type: 'tool_use',
              id: b.id,
              blockId: b.id ?? blockId,
              toolName: b.name,
              toolInput: b.input,
            },
            ts
          );
        }
        // thinking / other block types are intentionally not rendered.
      }
      continue;
    }

    // Unknown non-meta type — ignore (forward-compatible).
  }

  return rows;
}

/**
 * Pick the chat title from a transcript: a user-set `custom-title` wins, then the
 * latest AI-generated `ai-title` (or legacy `summary`), then the first human message
 * (truncated), else null. Latest carrier wins (titles are re-emitted as they change).
 */
export function transcriptTitle(lines: TranscriptLine[], maxLen = 120): string | null {
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let firstUser: string | null = null;
  for (const line of lines) {
    if (line.type === 'custom-title' && typeof line.customTitle === 'string') {
      customTitle = line.customTitle;
    } else if (line.type === 'ai-title' && typeof line.aiTitle === 'string') {
      aiTitle = line.aiTitle;
    } else if (line.type === 'summary' && typeof line.summary === 'string') {
      aiTitle = aiTitle ?? line.summary;
    } else if (
      firstUser === null &&
      line.type === 'user' &&
      !line.isMeta &&
      typeof line.message?.content === 'string' &&
      !isSlashCommandContent(line.message.content)
    ) {
      // An injected `<task-notification>` blob is machine context, never a title —
      // a notification-only message strips to '' and keeps looking for the first
      // HUMAN turn; an embedded one titles as the human part (public issue #11). The
      // transcript content is a full JSONL line (a torn line fails JSON.parse and is
      // dropped upstream), so the SDK blob is always complete → the STRICT strip is
      // lossless and never chops a human title that merely mentions the marker.
      const cleaned = stripTaskNotifications(line.message.content);
      if (cleaned) firstUser = cleaned;
    }
  }
  const pick = customTitle ?? aiTitle ?? firstUser;
  if (!pick) return null;
  const oneLine = pick.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;
}

/** The `cwd` (repo path) recorded in the transcript — read from any line that carries it. */
export function transcriptCwd(lines: TranscriptLine[]): string | null {
  for (const line of lines) {
    if (typeof line.cwd === 'string' && line.cwd) return line.cwd;
  }
  return null;
}

/** Last meaningful timestamp in the transcript (ms), or 0 if none. */
export function transcriptLastTimestamp(lines: TranscriptLine[]): number {
  let last = 0;
  for (const line of lines) {
    const ms = parseTs(line.timestamp, 0);
    if (ms > last) last = ms;
  }
  return last;
}

/**
 * True if a transcript has NO renderable user/assistant content (empty, /clear-only,
 * or meta-only) — such transcripts must NOT surface as phantom chats (D29b).
 */
export function transcriptIsEmpty(lines: TranscriptLine[]): boolean {
  return transcriptToMessages(lines).length === 0;
}
