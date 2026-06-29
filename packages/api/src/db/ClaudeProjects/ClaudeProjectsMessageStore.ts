/**
 * ClaudeProjectsMessageStore — sources a chat's message STREAM
 * from the SDK's `~/.claude/projects/<slug>/<session>.jsonl` transcript (read via the
 * pure transcript reader), MERGED on read with the portable-only OVERLAY side stream
 * (synthesized media / action chips that have no JSONL home — Q-F3a hybrid).
 *
 * Ownership split: the SDK owns conversation CONTENT in its clean JSONL (portable reads
 * it, stops duplicating it to SQLite); portable owns its presentation OVERLAY in the
 * side store. The merged read produces the uniform `BufferedMessage[]` wire shape, with
 * a unified monotonic `id` so the cursor / load-more stay coherent.
 */
import { promises as fs } from 'fs';

import { OverlayMessageStore } from './OverlayMessageStore.js';
import { transcriptPath } from './projectsPaths.js';
import { parseTranscript, transcriptToMessages } from './transcriptReader.js';

import type { IMessageStore } from './IMessageStore.js';
import type { MessageRow } from '../JsonDbAdapter/JsonChatStore.js';

/** Resolves a chatId to the keys that locate its JSONL transcript (from the chat ROW). */
export type ChatTranscriptResolver = (
  chatId: string
) => Promise<{ repoPath: string | null; sessionId: string | null } | null>;

/** Block `data.type`s that are portable-synthesized overlays (no JSONL representation). */
const OVERLAY_BLOCK_TYPES = new Set(['image', 'video', 'actions']);

/**
 * True if a buffered message is a portable-only OVERLAY that must be kept in the side
 * stream (no JSONL home). Everything else is SDK-authored conversation read from the
 * JSONL and must NOT be re-persisted (it would duplicate the transcript).
 */
export function isOverlayMessage(type: string, data: unknown): boolean {
  if (type === 'claude_code_block' && data && typeof data === 'object') {
    const t = (data as { type?: string }).type;
    return !!t && OVERLAY_BLOCK_TYPES.has(t);
  }
  return false;
}

export class ClaudeProjectsMessageStore implements IMessageStore {
  constructor(
    private readonly configDir: string,
    private readonly overlay: OverlayMessageStore,
    private readonly resolve: ChatTranscriptResolver
  ) {}

  async initialize(): Promise<void> {
    await this.overlay.initialize();
  }

  close(): void {
    this.overlay.close();
  }

  async appendMessage(
    chatId: string,
    type: string,
    data: unknown,
    timestamp: number
  ): Promise<number> {
    // The SDK already wrote the conversation to the JSONL; portable persists ONLY its
    // overlay events. SDK-authored user/assistant rows are dropped here so the merged
    // read never double-renders them (the D29a net simplification).
    if (!isOverlayMessage(type, data)) return 0;
    return this.overlay.append(chatId, type, data, timestamp);
  }

  async readMessages(chatId: string): Promise<MessageRow[]> {
    const jsonlRows = await this.readTranscriptRows(chatId);
    const overlayRows = await this.overlay.read(chatId);
    return mergeStreams(jsonlRows, overlayRows);
  }

  async getMessageCount(chatId: string): Promise<number> {
    return (await this.readMessages(chatId)).length;
  }

  async deleteMessages(chatId: string): Promise<void> {
    // We never delete the SDK's transcript (we don't own it) — only the overlay rows.
    await this.overlay.deleteChat(chatId);
  }

  private async readTranscriptRows(chatId: string): Promise<MessageRow[]> {
    const keys = await this.resolve(chatId);
    if (!keys?.repoPath || !keys.sessionId) return []; // fresh chat — no transcript yet
    const file = transcriptPath(this.configDir, keys.repoPath, keys.sessionId);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      return []; // transcript not on disk yet (session id captured but file not flushed)
    }
    return transcriptToMessages(parseTranscript(raw));
  }
}

/**
 * Merge the JSONL-derived stream with the overlay stream by timestamp and RE-ASSIGN a
 * single ascending `id` so the cursor space is unified. JSC's stable sort keeps the
 * JSONL row before an equal-timestamp overlay (overlays are generated post-turn). Ids
 * are deterministic for a given (transcript, overlay) state and stay stable as the
 * transcript APPENDS. A Portable chat's transcript is forked at most ONCE (at
 * claim time — fork-on-first-write of a Claude Code chat) and only APPENDS
 * thereafter, so a given chat's (transcript, overlay) state keeps stable ids.
 */
export function mergeStreams(jsonl: MessageRow[], overlay: MessageRow[]): MessageRow[] {
  const merged = [...jsonl, ...overlay].sort((a, b) => a.timestamp - b.timestamp);
  return merged.map((row, i) => ({ ...row, id: i + 1 }));
}
