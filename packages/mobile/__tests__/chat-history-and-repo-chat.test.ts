/**
 * Chat-history transform + block dedup + home repo→chat flow (pure units).
 *
 *  - `transformBufferedMessages`: the `chat:join` ack carries raw
 *    BufferedMessages; the transform must produce renderable MobileChatMessages
 *    — without it an opened chat renders empty (the original bug).
 *  - `appendBlockToMessages`: a redelivered block with the same `blockId` must
 *    be dropped even when it has no `id` (error/image/actions blocks) — the
 *    source of the "two children with the same key" warning.
 *  - `startRepoChatFlow`: the repo-Overview chat hand-off emits `chat:create`
 *    for the repo, navigates to the
 *    new chat, and — with a first `message` — titles the chat with it and sends
 *    it via `chat:message`.
 */

import type { BufferedMessage } from '@vgit2/shared/types';
import { AUTOPILOT_COMPLETION_INSTRUCTION } from '@vgit2/shared/utils/autopilotHelpers';
import type {
  ChatCreatePayload,
  ChatMessagePayload,
  ClaudeStreamBlock,
} from '@vgit2/shared/socket';

// The chat barrel transitively reaches MMKV-backed stores + SecureStore-backed
// auth helpers at module scope — mock the native modules (established pattern).
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    createMMKV: () => ({
      set: (k: string, v: string) => void store.set(k, v),
      getString: (k: string) => store.get(k),
      remove: (k: string) => void store.delete(k),
      clearAll: () => void store.clear(),
    }),
    MMKV: class {},
  };
});
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: async (k: string) => store.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});
jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});

import {
  appendBlockToMessages,
  mergeJoinedHistory,
  RUN_START_SYNC_GRACE_MS,
  useChatMessagesStore,
  type MobileChatMessage,
} from '../src/features/chat/chatMessagesStore';
import { transformBufferedMessages } from '../src/features/chat/messageTransformers';
import { startRepoChatFlow } from '../src/features/chat/startRepoChat';
import { DEFAULT_NEW_CHAT_SETTINGS } from '../src/features/state/chatStore';

const buffered = (overrides: Partial<BufferedMessage>): BufferedMessage =>
  ({ id: 1, type: 'user_message', data: {}, timestamp: 1000, ...overrides }) as BufferedMessage;

describe('transformBufferedMessages (chat:join history → renderable messages)', () => {
  it('maps user_message / claude_code_stream and preserves the numeric id as the key', () => {
    const history: BufferedMessage[] = [
      buffered({ id: 1, type: 'user_message', data: { content: 'hello' }, timestamp: 1 }),
      buffered({
        id: 2,
        type: 'claude_code_stream',
        data: {
          blocks: [
            { type: 'text', blockId: 'b1', content: 'hi there' },
            { type: 'tool_use', blockId: 'b2', id: 'toolu_1', toolName: 'Bash' },
          ],
        },
        timestamp: 2,
      }),
    ];

    const messages = transformBufferedMessages(history);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ id: '1', role: 'user', content: 'hello' });
    expect(messages[1]).toMatchObject({ id: '2', role: 'assistant', content: 'hi there' });
    expect(messages[1].blocks).toHaveLength(2);
  });

  it('prefers the autopilot customDisplay text for user messages', () => {
    const messages = transformBufferedMessages([
      buffered({
        type: 'user_message',
        data: { content: 'augmented + instruction', customDisplay: { displayText: 'original' } },
      }),
    ]);
    expect(messages[0].content).toBe('original');
  });

  it('strips the leaked autopilot instruction from raw content with no customDisplay', () => {
    // The persisted user_message can carry the AUGMENTED content directly (no
    // displayText) — the injected completion instruction must be stripped on re-join.
    const messages = transformBufferedMessages([
      buffered({
        type: 'user_message',
        data: { content: `add a comment to the README${AUTOPILOT_COMPLETION_INSTRUCTION}` },
      }),
    ]);
    expect(messages[0].content).toBe('add a comment to the README');
    expect(messages[0].content).not.toContain('<promise>COMPLETE</promise>');
    expect(messages[0].content).not.toContain('IMPORTANT: You MUST');
  });

  it('renders the auto-continue quick-action label, never its augmented prompt', () => {
    // The autopilot auto-continue message is buffered with a quickAction customDisplay
    // (the "continued by auto-pilot" pill) + the augmented prompt as content — the pill
    // label is shown, never the leaked prompt.
    const messages = transformBufferedMessages([
      buffered({
        type: 'user_message',
        data: {
          content: `Continue if there's anything else...${AUTOPILOT_COMPLETION_INSTRUCTION}`,
          customDisplay: {
            category: 'quickAction',
            action: { id: 'autopilot-continue', label: 'continued by auto-pilot' },
          },
        },
      }),
    ]);
    expect(messages[0].content).toBe('continued by auto-pilot');
    expect(messages[0].content).not.toContain('<promise>COMPLETE</promise>');
  });

  it('consolidates consecutive assistant messages, deduping merged blocks by blockId', () => {
    const sharedBlock: ClaudeStreamBlock = { type: 'text', blockId: 'dup', content: 'same' };
    const messages = transformBufferedMessages([
      buffered({ id: 1, type: 'user_message', data: { content: 'go' } }),
      buffered({ id: 2, type: 'claude_code_stream', data: { blocks: [sharedBlock] } }),
      buffered({
        id: 3,
        type: 'claude_code_stream',
        data: { blocks: [sharedBlock, { type: 'text', blockId: 'b9', content: 'more' }] },
      }),
    ]);

    expect(messages).toHaveLength(2);
    const assistant = messages[1];
    // The duplicate `dup` block merged once; the consolidated id is the LATEST.
    expect(assistant.blocks?.map((b) => b.blockId)).toEqual(['dup', 'b9']);
    expect(assistant.id).toBe('3');
  });

  it('drops status/control messages (claude_code_start, runtime_state_update, navigate)', () => {
    const messages = transformBufferedMessages([
      buffered({ type: 'claude_code_start' }),
      buffered({ type: 'chat_status_update' }),
      buffered({ type: 'runtime_state_update' }),
      buffered({ type: 'navigate' }),
      buffered({ type: 'user_message', data: { content: 'only me' } }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('only me');
  });
});

describe('appendBlockToMessages blockId dedup (duplicate React key regression)', () => {
  const assistant = (blocks: ClaudeStreamBlock[]) => [
    { role: 'assistant' as const, content: '', blocks },
  ];

  it('drops a redelivered block with the same blockId even when it has no id', () => {
    const errorBlock: ClaudeStreamBlock = {
      type: 'error',
      blockId: 'e98c4e58-8207-4a6c-a670-470ea59b2a83',
      content: 'boom',
    };
    const once = appendBlockToMessages(assistant([errorBlock]), { ...errorBlock });
    expect(once[0].blocks).toHaveLength(1);
  });

  it('still appends distinct blocks of the same type', () => {
    const a: ClaudeStreamBlock = { type: 'error', blockId: 'one', content: 'a' };
    const b: ClaudeStreamBlock = { type: 'error', blockId: 'two', content: 'b' };
    const next = appendBlockToMessages(assistant([a]), b);
    expect(next[0].blocks).toHaveLength(2);
  });

  it('keeps the id+type and text-content dedups', () => {
    const toolUse: ClaudeStreamBlock = { type: 'tool_use', id: 'toolu_1', blockId: 'x' };
    const sameToolNewBlockId: ClaudeStreamBlock = { type: 'tool_use', id: 'toolu_1', blockId: 'y' };
    expect(appendBlockToMessages(assistant([toolUse]), sameToolNewBlockId)[0].blocks).toHaveLength(
      1
    );

    const text: ClaudeStreamBlock = { type: 'text', blockId: 'p', content: 'same words' };
    const sameTextNewBlockId: ClaudeStreamBlock = {
      type: 'text',
      blockId: 'q',
      content: 'same words',
    };
    expect(appendBlockToMessages(assistant([text]), sameTextNewBlockId)[0].blocks).toHaveLength(1);
  });
});

describe('mergeJoinedHistory (re-join MERGE)', () => {
  const userMsg = (id: string, content: string): MobileChatMessage => ({
    id,
    role: 'user',
    content,
    timestamp: Number(id) * 1000,
  });

  it('returns the joined history when nothing is in memory yet (first open)', () => {
    const joined = [userMsg('1', 'a'), userMsg('2', 'b')];
    expect(mergeJoinedHistory([], joined, false)).toEqual(joined);
    expect(mergeJoinedHistory([], joined, true)).toEqual(joined);
  });

  it('ACTIVE: appends local-only (not-in-ack) messages after the backend set', () => {
    const existing = [userMsg('1', 'a'), userMsg('2', 'b')]; // '2' is live, not yet persisted
    const joined = [userMsg('1', 'a')]; // backend buffer lags — only has '1'
    const merged = mergeJoinedHistory(existing, joined, true);
    // backend first, then the local-only live message — chronological order kept.
    expect(merged.map((m) => m.id)).toEqual(['1', '2']);
  });

  it('INACTIVE: trusts the backend wholesale (drops local-only)', () => {
    const existing = [userMsg('1', 'a'), userMsg('2', 'b')];
    const joined = [userMsg('1', 'a')];
    expect(mergeJoinedHistory(existing, joined, false).map((m) => m.id)).toEqual(['1']);
  });

  it('dedups by id — a message present in both is not duplicated', () => {
    const existing = [userMsg('1', 'a'), userMsg('2', 'b')];
    const joined = [userMsg('1', 'a'), userMsg('2', 'b')]; // backend re-sent both
    expect(mergeJoinedHistory(existing, joined, true).map((m) => m.id)).toEqual(['1', '2']);
  });

  it('ACTIVE: an empty join keeps all existing messages (never wipes live content)', () => {
    const existing = [userMsg('1', 'a'), userMsg('2', 'b')];
    expect(mergeJoinedHistory(existing, [], true)).toEqual(existing);
  });

  it('ACTIVE: reconciles an optimistic user message against its persisted copy by CONTENT', () => {
    // The home-composer seed carries a CLIENT id (`msg-…`) + a client timestamp; the
    // backend persists the SAME message with a NUMERIC buffered id + its own stored
    // timestamp — they share neither id nor ts, so an id/ts-only merge kept BOTH and the
    // user bubble rendered twice on a re-join/resync while the run was still live. The
    // persisted copy's user-visible content matches the seed → the local copy is dropped.
    const optimistic: MobileChatMessage = {
      id: 'msg-1700',
      role: 'user',
      content: 'add a restart button',
      timestamp: 1700,
    };
    const persisted: MobileChatMessage = {
      id: '42',
      role: 'user',
      content: 'add a restart button',
      timestamp: 1000,
    };
    const merged = mergeJoinedHistory([optimistic], [persisted], true);
    expect(merged).toEqual([persisted]); // exactly one user message — the backend's
  });

  it('ACTIVE: reconciles a local user message that has NO id by content (repo hand-off)', () => {
    // `startRepoChatFlow` sends `chat:message` WITHOUT a messageId, so the backend echo
    // appends with `id: undefined` — it can only ever reconcile against the persisted
    // copy by content.
    const echo: MobileChatMessage = { role: 'user', content: 'fix the login bug', timestamp: 8888 };
    const persisted: MobileChatMessage = {
      id: '7',
      role: 'user',
      content: 'fix the login bug',
      timestamp: 1000,
    };
    expect(mergeJoinedHistory([echo], [persisted], true)).toEqual([persisted]);
  });

  it('ACTIVE: keeps a genuinely-newer duplicate-content user message the backend lacks (1:1 claim, no over-dedup)', () => {
    // The user sent "yes" (persisted id=1, already reconciled), then "yes" AGAIN
    // (optimistic, not yet persisted). The content claim is 1:1 — the first "yes" claims
    // the backend copy, the second finds no unclaimed match and is kept (never lost).
    const firstReconciled = userMsg('1', 'yes');
    const secondOptimistic: MobileChatMessage = {
      id: 'msg-2',
      role: 'user',
      content: 'yes',
      timestamp: 9999,
    };
    const persisted = userMsg('1', 'yes');
    const merged = mergeJoinedHistory([firstReconciled, secondOptimistic], [persisted], true);
    expect(merged.map((m) => m.id)).toEqual(['1', 'msg-2']);
  });

  it('ACTIVE: a local-only USER message the backend genuinely lacks (distinct content) is kept', () => {
    // Content reconciliation must not over-reach: a user message whose content is NOT in
    // the backend set stays local-only (the protection still holds for user turns).
    const existing = [
      userMsg('1', 'a'),
      { role: 'user' as const, content: 'brand new', timestamp: 5 },
    ];
    const joined = [userMsg('1', 'a')];
    expect(mergeJoinedHistory(existing, joined, true).map((m) => m.content)).toEqual([
      'a',
      'brand new',
    ]);
  });
});

describe('applyJoinedHistory (store action; merge + status guard)', () => {
  const chatId = 'chat-merge';
  const asst = (blockId: string, content: string): MobileChatMessage => ({
    role: 'assistant',
    content: '',
    blocks: [{ type: 'text', blockId, content }],
  });

  beforeEach(() => useChatMessagesStore.getState().reset());

  it('an EMPTY ack never wipes live-streamed messages (the literal root cause)', () => {
    const store = useChatMessagesStore.getState();
    store.setMessages(chatId, [asst('a', 'live work')]);
    store.setStatus(chatId, 'running');
    // The persisted buffer lags → the re-join ack is `[]` (truthy → the old
    // `!ack.messages` guard missed it → setMessages([]) used to wipe the list).
    store.applyJoinedHistory(chatId, []);
    expect(useChatMessagesStore.getState().getMessages(chatId)).toHaveLength(1);
    // ...and the empty ack left the live 'running' status untouched.
    expect(useChatMessagesStore.getState().statuses[chatId]).toBe('running');
  });

  it('a SHORT/stale ack on a running chat merges (keeps live blocks)', () => {
    const store = useChatMessagesStore.getState();
    const user: MobileChatMessage = { id: '1', role: 'user', content: 'go', timestamp: 1000 };
    store.setMessages(chatId, [user, asst('a', 'live')]); // assistant streamed live
    store.setStatus(chatId, 'running');
    // Re-join returns only the persisted user message (assistant blocks lag) +
    // the honest 'running' status (the session is still processing).
    store.applyJoinedHistory(chatId, [{ ...user }], 'running');
    const msgs = useChatMessagesStore.getState().getMessages(chatId);
    expect(msgs).toHaveLength(2); // user (backend) + live assistant (local-only)
    expect(msgs[1].blocks?.[0]).toMatchObject({ blockId: 'a' });
    expect(useChatMessagesStore.getState().statuses[chatId]).toBe('running');
  });

  it('a COMPLETED chat trusts the backend and adopts the ack status', () => {
    const store = useChatMessagesStore.getState();
    store.setMessages(chatId, [asst('a', 'old')]);
    store.setStatus(chatId, 'completed');
    const joined: MobileChatMessage[] = [
      { id: '1', role: 'user', content: 'hi', timestamp: 1000 },
      { id: '2', role: 'assistant', content: 'done', timestamp: 2000 },
    ];
    store.applyJoinedHistory(chatId, joined, 'completed');
    expect(
      useChatMessagesStore
        .getState()
        .getMessages(chatId)
        .map((m) => m.id)
    ).toEqual(['1', '2']);
    expect(useChatMessagesStore.getState().statuses[chatId]).toBe('completed');
  });

  it('the optimistic-start GRACE window counts as live even when status is not running', () => {
    // Seed state directly: status NON-live ('idle') but runStartedAt FRESH — the
    // spawn-window race a resync / load-more can hit (the initial join short-circuits
    // on grace separately). The grace branch must still treat the chat as live.
    useChatMessagesStore.setState({
      messages: { [chatId]: [asst('a', 'live')] },
      statuses: { [chatId]: 'idle' },
      runStartedAt: { [chatId]: Date.now() },
    });
    useChatMessagesStore
      .getState()
      .applyJoinedHistory(
        chatId,
        [{ id: '9', role: 'user', content: 'x', timestamp: 1 }],
        'completed'
      );
    const msgs = useChatMessagesStore.getState().getMessages(chatId);
    expect(msgs.some((m) => m.blocks?.[0]?.blockId === 'a')).toBe(true); // local-only preserved
    expect(useChatMessagesStore.getState().statuses[chatId]).toBe('idle'); // status not adopted
    expect(RUN_START_SYNC_GRACE_MS).toBeGreaterThan(0);
  });

  it('a re-join WHILE LIVE reconciles the optimistic first message — no duplicate user bubble', () => {
    // The exact repro: home composer seeds the first user message (client id +
    // client timestamp), the run starts, then a reconnect / AppState-foreground resync
    // re-joins while the chat is STILL running and returns the PERSISTED copy (numeric
    // buffered id + stored timestamp). Before the fix the merge kept both → two bubbles.
    const store = useChatMessagesStore.getState();
    store.appendUserMessage(chatId, {
      id: 'msg-1700',
      role: 'user',
      content: 'add a restart button',
      timestamp: 1700,
    });
    store.markRunStarted(chatId); // status running + the spawn grace
    store.applyJoinedHistory(
      chatId,
      [{ id: '42', role: 'user', content: 'add a restart button', timestamp: 1000 }],
      'running'
    );
    const userMsgs = useChatMessagesStore
      .getState()
      .getMessages(chatId)
      .filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1); // exactly one — not the duplicated bubble
    expect(userMsgs[0].id).toBe('42'); // the persisted copy supersedes the optimistic seed
  });
});

describe('startRepoChatFlow (repo Overview → new chat)', () => {
  it('emits chat:create for the repo with the new-chat settings and navigates', async () => {
    const emitted: ChatCreatePayload[] = [];
    const navigated: string[] = [];

    const chatId = await startRepoChatFlow({
      owner: 'octocat',
      repo: 'hello',
      settings: DEFAULT_NEW_CHAT_SETTINGS,
      emitCreateChat: async (payload) => {
        emitted.push(payload);
        return { success: true };
      },
      navigate: (id) => navigated.push(id),
      makeChatId: () => 'chat-test-1',
    });

    expect(chatId).toBe('chat-test-1');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      chatId: 'chat-test-1',
      type: 'claude_code',
      title: 'octocat/hello',
      owner: 'octocat',
      repo: 'hello',
      model: DEFAULT_NEW_CHAT_SETTINGS.model,
      permissions: DEFAULT_NEW_CHAT_SETTINGS.permissions,
      agentSetupId: DEFAULT_NEW_CHAT_SETTINGS.agentSetupId,
    });
    expect(navigated).toEqual(['chat-test-1']);
  });

  it('titles the chat with the first message and sends it after navigating', async () => {
    const emitted: ChatCreatePayload[] = [];
    const sent: ChatMessagePayload[] = [];
    const order: string[] = [];

    await startRepoChatFlow({
      owner: 'octocat',
      repo: 'hello',
      settings: DEFAULT_NEW_CHAT_SETTINGS,
      message: 'Fix the login bug',
      emitCreateChat: async (payload) => {
        emitted.push(payload);
        return { success: true };
      },
      emitSendMessage: async (payload) => {
        order.push('send');
        sent.push(payload);
        return { success: true };
      },
      navigate: () => order.push('navigate'),
      makeChatId: () => 'chat-test-2',
    });

    expect(emitted[0]).toMatchObject({ chatId: 'chat-test-2', title: 'Fix the login bug' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      chatId: 'chat-test-2',
      content: 'Fix the login bug',
      model: DEFAULT_NEW_CHAT_SETTINGS.model,
      permissions: DEFAULT_NEW_CHAT_SETTINGS.permissions,
      agentSetupId: DEFAULT_NEW_CHAT_SETTINGS.agentSetupId,
    });
    // Navigate first, then send the first message.
    expect(order).toEqual(['navigate', 'send']);
  });

  it('swallows a failed first-message send after a successful create (navigation is never undone)', async () => {
    const navigated: string[] = [];

    await expect(
      startRepoChatFlow({
        owner: 'octocat',
        repo: 'hello',
        settings: DEFAULT_NEW_CHAT_SETTINGS,
        message: 'Fix the login bug',
        emitCreateChat: async () => ({ success: true }),
        emitSendMessage: async () => {
          throw new Error('send failed');
        },
        navigate: (id) => navigated.push(id),
        makeChatId: () => 'chat-test-3',
      })
    ).resolves.toBe('chat-test-3');
    expect(navigated).toEqual(['chat-test-3']);
  });

  it('throws (and does not navigate) when the create ack fails', async () => {
    const navigated: string[] = [];
    await expect(
      startRepoChatFlow({
        owner: 'octocat',
        repo: 'hello',
        settings: DEFAULT_NEW_CHAT_SETTINGS,
        emitCreateChat: async () => ({ success: false, error: 'nope' }),
        navigate: (id) => navigated.push(id),
      })
    ).rejects.toThrow('nope');
    expect(navigated).toEqual([]);
  });

  it('a worktree rides the chat:create payload (start a chat INSIDE a worktree)', async () => {
    const emitted: ChatCreatePayload[] = [];

    await startRepoChatFlow({
      owner: 'octocat',
      repo: 'hello',
      settings: DEFAULT_NEW_CHAT_SETTINGS,
      message: 'Fix the flaky test',
      worktree: '/ws/hello/.worktrees/17',
      emitCreateChat: async (payload) => {
        emitted.push(payload);
        return { success: true };
      },
      emitSendMessage: async () => ({ success: true }),
      navigate: () => {},
      makeChatId: () => 'chat-test-wt',
    });

    expect(emitted[0]).toMatchObject({
      chatId: 'chat-test-wt',
      owner: 'octocat',
      repo: 'hello',
      worktree: '/ws/hello/.worktrees/17',
    });
  });

  it('without a worktree the chat:create payload carries none (unchanged wire shape)', async () => {
    const emitted: ChatCreatePayload[] = [];

    await startRepoChatFlow({
      owner: 'octocat',
      repo: 'hello',
      settings: DEFAULT_NEW_CHAT_SETTINGS,
      emitCreateChat: async (payload) => {
        emitted.push(payload);
        return { success: true };
      },
      navigate: () => {},
      makeChatId: () => 'chat-test-nowt',
    });

    expect('worktree' in emitted[0]).toBe(false);
  });

  it('optimistically marks the run started BEFORE navigating when a first message is seeded', async () => {
    useChatMessagesStore.getState().reset();
    let statusAtNavigate: string | undefined;

    await startRepoChatFlow({
      owner: 'octocat',
      repo: 'hello',
      settings: DEFAULT_NEW_CHAT_SETTINGS,
      message: 'Fix the login bug',
      emitCreateChat: async () => ({ success: true }),
      emitSendMessage: async () => ({ success: true }),
      navigate: () => {
        statusAtNavigate = useChatMessagesStore.getState().statuses['chat-test-5'];
      },
      makeChatId: () => 'chat-test-5',
    });

    // The chat screen mounts with the typing indicator already up…
    expect(statusAtNavigate).toBe('running');
    // …and the join-snapshot protection window is armed (useChatStream skips
    // the stale spawn-window 'completed' the backend reports while the Claude
    // session is still being created).
    expect(useChatMessagesStore.getState().runStartedAt['chat-test-5']).toBeDefined();
    useChatMessagesStore.getState().reset();
  });

  it('does NOT mark a run started for a message-less create (no run to indicate)', async () => {
    useChatMessagesStore.getState().reset();

    await startRepoChatFlow({
      owner: 'octocat',
      repo: 'hello',
      settings: DEFAULT_NEW_CHAT_SETTINGS,
      emitCreateChat: async () => ({ success: true }),
      navigate: () => {},
      makeChatId: () => 'chat-test-6',
    });

    expect(useChatMessagesStore.getState().statuses['chat-test-6']).toBeUndefined();
    expect(useChatMessagesStore.getState().runStartedAt['chat-test-6']).toBeUndefined();
  });
});
