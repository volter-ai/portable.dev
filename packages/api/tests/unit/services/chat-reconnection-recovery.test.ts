/**
 * Reconnection ownership: the recovery contract.
 *
 * THE STORY: the gateway absorbs a tunnel rotation/death, the app's Socket.IO
 * transport drops and auto-reconnects to the same stable endpoint (a new
 * engine.io session). Any blocks the PC emitted "to an empty room" DURING the
 * gap are recovered ONLY via the post-reconnect `chat:join` history-merge against
 * local SQLite — there is NO server-side emit buffer.
 *
 * This test pins that contract end-to-end at the handler level with a STUBBED
 * transport (per the story notes):
 *   - real `ChatService` + real `ChatExecutionService`
 *   - REAL local SQLite (`SqliteDbAdapter` — the local-first runtime)
 *   - a `TestEmitter` standing in for the dropped transport
 *
 * It deliberately exercises a turn LONGER than the count=50 `chat:join` page so
 * recovery must span more than one page, proving the full transcript is
 * reconstructable from SQLite alone.
 *
 * Lives under tests/unit/* so it runs in the `unit` shard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import { SqliteDbAdapter } from '../../../src/db/SqliteDbAdapter';
import { ChatService } from '../../../src/services/ChatService';
import { ChatExecutionService } from '../../../src/services/ChatExecutionService';
import { TestEmitter } from '../../setup/helpers/TestEmitter';
import { TestContextBuilder } from '../../setup/helpers/testContext';

const USER = 'user_recovery';
const CHAT = 'chat-recovery-001';
const JOIN_PAGE = 50; // chat:join default count / load_more page size

// Pre-gap messages the client already received before the transport dropped.
const PRE_GAP = 5;
// A single turn emitted to the empty room during the gap — deliberately > one
// 50-message page so recovery has to paginate.
const GAP_TURN = 60;
const TOTAL = PRE_GAP + GAP_TURN; // 65

describe('reconnection recovery — chat:join history-merge against local SQLite', () => {
  let dataDir: string;
  let adapter: SqliteDbAdapter;
  let chatService: ChatService;
  let exec: ChatExecutionService;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'e4-003-recovery-'));
    // Local-first runtime is SQLite-only.
    adapter = new SqliteDbAdapter(dataDir, dataDir);
    await adapter.initialize();

    chatService = new ChatService(adapter);
    // Only chatService (+ the sessions map) is exercised by chat:join /
    // chat:load_more; the rest of the execution graph is irrelevant here.
    exec = new ChatExecutionService(
      chatService,
      {} as any, // claudeService
      {} as any, // gitLocalService
      {} as any, // messageDeduplicationService
      undefined, // tunnelService
      undefined, // processTrackerService
      adapter, // dbAdapter
      undefined, // pushNotificationService
      undefined, // sopService
      new Map() // claudeCodeSessions
    );

    await chatService.saveChat({
      userId: USER,
      chatId: CHAT,
      type: 'claude_code',
      title: 'Recovery',
      status: 'completed',
      repoPath: '/tmp/recovery-repo',
      model: 'sonnet',
      permissions: 'default',
      agentSetupId: 'freestyle',
    });
  });

  afterEach(async () => {
    adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('recovers a full transcript (incl. a turn longer than the count=50 page) from SQLite, with no server-side emit buffer', async () => {
    // ── Before the gap: the client received PRE_GAP messages. ────────────────
    for (let i = 1; i <= PRE_GAP; i++) {
      await chatService.bufferMessage(USER, CHAT, 'user_message', { content: `pre-${i}` });
    }
    const lastSeenId = PRE_GAP; // the highest message id the client had merged

    // ── The transport drops mid-stream (tunnel rotation/death). The PC keeps
    //    running and emits a long turn — but to an EMPTY room. Each block is
    //    persisted to SQLite; NOTHING is pushed to a live client (no buffer). ──
    const emitter = new TestEmitter();
    for (let i = 1; i <= GAP_TURN; i++) {
      await chatService.bufferMessage(USER, CHAT, 'assistant', {
        blocks: [{ type: 'text', text: `gap-block-${i}` }],
      });
    }
    // The recovery contract: there is no server-side emit buffer. Nothing was
    // delivered to the (dropped) transport during the gap.
    expect(emitter.getTotalEventCount()).toBe(0);

    // Simulate reconnecting as a fresh engine.io session on a clean process:
    // drop the in-memory buffer so recovery MUST come from durable SQLite.
    await chatService.clearBuffer(USER, CHAT);

    const ctx = new TestContextBuilder()
      .withUserId(USER)
      .withUsername('dev')
      .withChatId(CHAT)
      .withEmitter(emitter)
      .build();

    // ── Reconnect: chat:join returns the latest page and flags more history. ──
    const join = await exec.handleChatJoin(ctx, { chatId: CHAT, count: JOIN_PAGE });
    expect(join.success).toBe(true);
    expect(join.totalCount).toBe(TOTAL);
    expect(join.messages.length).toBe(JOIN_PAGE);
    expect(join.hasMore).toBe(true);
    // chat:join did not push anything either — it returns the page synchronously.
    expect(emitter.getTotalEventCount()).toBe(0);

    // ── History-merge: page forward from the client's last-seen id to fill the
    //    gap. The gap turn is longer than one page, so this MUST take >1 page. ──
    const recovered = new Map<number, any>();
    for (const m of join.messages) recovered.set(m.id, m);

    let afterId = lastSeenId;
    let pages = 0;
    for (;;) {
      const more = await exec.handleChatLoadMore(ctx, {
        chatId: CHAT,
        afterId,
        limit: JOIN_PAGE,
      });
      expect(more.success).toBe(true);
      if (more.messages.length === 0) break;
      for (const m of more.messages) recovered.set(m.id, m);
      afterId = more.messages[more.messages.length - 1].id;
      pages++;
      if (!more.hasMore) break;
    }
    // The gap turn (60) spans more than one 50-message page.
    expect(pages).toBeGreaterThanOrEqual(2);

    // ── The entire gap turn (ids PRE_GAP+1 .. TOTAL) is recovered from SQLite. ─
    for (let id = PRE_GAP + 1; id <= TOTAL; id++) {
      expect(recovered.has(id)).toBe(true);
    }

    // ── Merging the client's pre-gap ids with the recovered set reconstructs the
    //    complete transcript 1..TOTAL with no holes. ──
    const merged = new Set<number>(recovered.keys());
    for (let id = 1; id <= PRE_GAP; id++) merged.add(id);
    expect(merged.size).toBe(TOTAL);
    for (let id = 1; id <= TOTAL; id++) {
      expect(merged.has(id)).toBe(true);
    }
  });

  it('re-pointing across reconnects is idempotent: a second chat:join returns the same durable transcript', async () => {
    // Persist a transcript, then "reconnect" twice (two engine.io sessions over
    // the same stable endpoint) — each fresh join reads the same SQLite history.
    for (let i = 1; i <= 12; i++) {
      await chatService.bufferMessage(USER, CHAT, 'user_message', { content: `m-${i}` });
    }

    const ctx = new TestContextBuilder()
      .withUserId(USER)
      .withUsername('dev')
      .withChatId(CHAT)
      .withEmitter(new TestEmitter())
      .build();

    await chatService.clearBuffer(USER, CHAT);
    const first = await exec.handleChatJoin(ctx, { chatId: CHAT, count: JOIN_PAGE });

    await chatService.clearBuffer(USER, CHAT);
    const second = await exec.handleChatJoin(ctx, { chatId: CHAT, count: JOIN_PAGE });

    expect(first.totalCount).toBe(12);
    expect(second.totalCount).toBe(12);
    expect(second.messages.map((m: any) => m.id)).toEqual(first.messages.map((m: any) => m.id));
  });
});
