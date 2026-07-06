/**
 * SqliteDbAdapter - SQLite-backed chat/message persistence
 *
 * Implements the full {@link DbAdapter} interface, persisting chats + messages
 * (via {@link SqliteChatStore}), connections (via {@link SqliteConnectionStore}),
 * themes (via {@link SqliteThemeStore}), push subscriptions (via
 * {@link SqlitePushStore}) and service accounts + audit log (via
 * {@link SqliteServiceAccountStore}) to local SQLite databases. Every domain is
 * local SQLite — there is no wrapped adapter. The local-first PC runtime
 * constructs this with `new SqliteDbAdapter()`.
 *
 * Drop-in replacement for JsonDbAdapter: same data dir, same DbAdapter
 * behavior, same DataTransformer read parity (snake_case row + camelCase
 * aliases, boolean→number for hidden/archived). The difference is durability —
 * JSON files could be torn/corrupted by a single bad write and then block ALL
 * chat reads; SQLite is transactional and one bad row fails in isolation.
 *
 * On initialize, legacy JSON chat data found in the data dir is imported into
 * SQLite automatically (once, marker-guarded, originals preserved) — see
 * {@link migrateJsonToSqlite}.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import { WORKSPACE_DIR } from '@vgit2/shared/constants';
import { DEFAULT_MODEL_MODE } from '@vgit2/shared/models';

import { migrateJsonToSqlite } from './JsonToSqliteMigrator.js';
import { SqliteChatStore } from './SqliteChatStore.js';
import { SqliteConnectionStore } from './SqliteConnectionStore.js';
import { SqlitePushStore } from './SqlitePushStore.js';
import { SqliteServiceAccountStore } from './SqliteServiceAccountStore.js';
import { SqliteThemeStore } from './SqliteThemeStore.js';
import {
  ClaudeProjectsChatIndex,
  type DiscoveredChat,
  type WorkspaceRepo,
} from '../ClaudeProjects/ClaudeProjectsChatIndex.js';
import { ClaudeProjectsMessageStore } from '../ClaudeProjects/ClaudeProjectsMessageStore.js';
import { OverlayMessageStore } from '../ClaudeProjects/OverlayMessageStore.js';
import { transcriptPath } from '../ClaudeProjects/projectsPaths.js';
import { pickPreviewRows } from '../previewRows.js';
import { DataTransformer } from '../utils/DataTransformer.js';

import type { IMessageStore } from '../ClaudeProjects/IMessageStore.js';
import type { ChatOrigin, DbAdapter, SaveChatOptions } from '../DbAdapter.js';
import type { ChatRow } from '../JsonDbAdapter/JsonChatStore.js';

/**
 * Opt-in: source the chat message STREAM (and discover the chat LIST) from
 * the SDK's `~/.claude/projects` JSONL instead of the SQLite `messages` table. Off by
 * default (SQLite); turned on via `CHAT_MESSAGE_SOURCE=jsonl` at the construction site.
 */
export interface ChatMessageSourceConfig {
  configDir: string;
  /** F1 `getLocalRepositories` over the workspace root — the D29b discovery scope. */
  reposProvider: () => Promise<WorkspaceRepo[]>;
}
import type {
  StoredChat,
  ChatCategory,
  ChatStatus,
  BufferedMessage,
  ServiceConnection,
  GetUserConnectionsOptions,
  GetConnectionOptions,
  GetConnectionsByServiceOptions,
  StoreConnectionOptions,
  RenameConnectionDbOptions,
} from '@vgit2/shared/types';

/**
 * Does a chat row match the requested view? A `category` (the mobile 3-way bucket)
 * SUPERSEDES the legacy `archived` boolean. Active = neither archived nor saved.
 * Legacy `archived=false` (terminal) means "not archived" and still includes saved.
 */
function chatMatchesCategory(
  c: ChatRow,
  category: ChatCategory | undefined,
  archived: boolean | undefined
): boolean {
  if (category === 'active') return !c.archived && !c.saved;
  if (category === 'saved') return !!c.saved;
  if (category === 'archived') return !!c.archived;
  return archived === undefined ? true : c.archived === archived;
}

/** Pinned chats float to the top; ties (and everything else) fall back to recency. */
function pinnedThenRecent(a: ChatRow, b: ChatRow): number {
  return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.last_updated - a.last_updated;
}

/**
 * Discovered (terminal) transcripts are always active (never saved/archived), so they
 * union into the active/legacy-non-archived views only — never the saved/archived lists.
 */
function includeDiscoveredFor(
  category: ChatCategory | undefined,
  archived: boolean | undefined
): boolean {
  if (category) return category === 'active';
  return archived !== true;
}

export class SqliteDbAdapter implements DbAdapter {
  private readonly store: SqliteChatStore;
  private readonly connectionStore: SqliteConnectionStore;
  private readonly themeStore: SqliteThemeStore;
  private readonly pushStore: SqlitePushStore;
  private readonly serviceAccountStore: SqliteServiceAccountStore;
  private readonly dataDir: string;
  private readonly transformer = new DataTransformer();

  // Opt-in (CHAT_MESSAGE_SOURCE=jsonl): when set, the message STREAM is
  // sourced from `~/.claude/projects` JSONL + an overlay side stream, and the chat LIST
  // is unioned with terminal-originated transcripts scoped to the workspace's repos.
  // Undefined → unchanged default (SQLite messages table + SQLite-only list).
  private readonly messageStore?: IMessageStore;
  private readonly chatIndex?: ClaudeProjectsChatIndex;
  private readonly reposProvider?: () => Promise<WorkspaceRepo[]>;
  /** The `~/.claude` config dir (when JSONL mode is on) — used to locate transcripts. */
  private readonly configDir?: string;

  /**
   * @param dataDir  Directory for the chat SQLite database (and any legacy JSON
   *                 files to migrate). Defaults to `<WORKSPACE_DIR>/.chat-data`
   *                 (persistent workspace volume) — same dir JsonDbAdapter used,
   *                 so existing users are picked up for migration automatically.
   * @param connectionDataDir Directory for the connections + themes + push
   *                 SQLite databases. Defaults to `resolveDataDir()`
   *                 (DATA_DIR), so this metadata lives next to the
   *                 LocalSecretStore's encrypted credentials.
   */
  constructor(dataDir?: string, connectionDataDir?: string, chatSource?: ChatMessageSourceConfig) {
    this.dataDir = dataDir ?? path.join(WORKSPACE_DIR, '.chat-data');
    this.store = new SqliteChatStore(this.dataDir);
    this.connectionStore = new SqliteConnectionStore(connectionDataDir);
    this.themeStore = new SqliteThemeStore(connectionDataDir);
    this.pushStore = new SqlitePushStore(connectionDataDir);
    this.serviceAccountStore = new SqliteServiceAccountStore(connectionDataDir);

    if (chatSource) {
      // Opt-in. The message store resolves a chatId → (repo_path,
      // session_id) from the SQLite chat ROW first; for a TERMINAL-originated chat
      // (no row, chatId IS the session id) it falls back to discovery so the chat
      // still opens and renders.
      this.configDir = chatSource.configDir;
      this.chatIndex = new ClaudeProjectsChatIndex(chatSource.configDir);
      this.reposProvider = chatSource.reposProvider;
      this.messageStore = new ClaudeProjectsMessageStore(
        chatSource.configDir,
        new OverlayMessageStore(this.dataDir),
        (chatId) => this.resolveTranscriptKeys(chatId)
      );
    }
  }

  /** Resolve a chatId to the keys that locate its JSONL transcript. */
  private async resolveTranscriptKeys(
    chatId: string
  ): Promise<{ repoPath: string | null; sessionId: string | null } | null> {
    const row = await this.store.getChat(chatId);

    // Common case (a portable-created chat: the SDK ran with cwd == repo_path): the row's
    // repo_path + session_id locate the transcript directly. GUARDED by an existence check
    // so a row whose repo_path is the repo ROOT but whose session actually ran in a SUBDIR
    // (a terminal-originated chat reconciled into a row — e.g. a `<repo>/.worktrees/…` or
    // `<repo>/packages/api` session) FALLS THROUGH to discovery: reading slug(repo_root)
    // would 404 → an EMPTY chat (the "previous messages don't show" bug).
    if (this.configDir && row?.repo_path && row.session_id) {
      const file = transcriptPath(this.configDir, row.repo_path, row.session_id);
      if (await this.transcriptExists(file)) {
        return { repoPath: row.repo_path, sessionId: row.session_id };
      }
    }

    // Locate by discovery, which knows each transcript's REAL cwd (the slug input — may be
    // a SUBDIR of the matched repo). Covers BOTH a terminal-originated chat with NO row AND
    // a row whose repo_path-based transcript is missing (subdir session). Keyed by the
    // SESSION id (the `.jsonl` filename); for a terminal chat that equals chatId.
    const sessionId = row?.session_id ?? chatId;
    if (this.chatIndex && this.reposProvider) {
      try {
        const discovered = await this.chatIndex.discoverChats(await this.reposProvider());
        const match = discovered.find((d) => d.sessionId === sessionId);
        if (match) return { repoPath: match.cwd, sessionId: match.sessionId };
      } catch {
        // discovery failed — fall through to the row's own keys
      }
    }

    // Last resort: trust the row even if its transcript isn't on disk yet (a fresh chat
    // whose SDK session just minted an id but hasn't flushed the file).
    return row?.repo_path && row.session_id
      ? { repoPath: row.repo_path, sessionId: row.session_id }
      : null;
  }

  /** True if a transcript file exists on disk (best-effort; never throws). */
  private async transcriptExists(file: string): Promise<boolean> {
    try {
      await fs.access(file);
      return true;
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  async initialize(): Promise<boolean> {
    await this.store.initialize();
    // Open the JSONL message store's overlay side stream (opt-in).
    if (this.messageStore?.initialize) {
      await this.messageStore.initialize();
    }
    // Connections persist to local SQLite under DATA_DIR.
    await this.connectionStore.initialize();
    // Themes now persist to local SQLite under DATA_DIR.
    await this.themeStore.initialize();
    // Push subscriptions now persist to local SQLite under DATA_DIR.
    await this.pushStore.initialize();
    // Service accounts + audit log now persist to local SQLite under DATA_DIR.
    await this.serviceAccountStore.initialize();

    // Automatic one-time JSON → SQLite migration. A failure here
    // must not prevent the server from starting: without a marker the import
    // simply retries on the next startup.
    try {
      await migrateJsonToSqlite(this.dataDir, this.store);
    } catch (error) {
      console.error('[SqliteDbAdapter] JSON → SQLite migration failed (will retry):', error);
    }

    // All domains persist to local SQLite.
    console.log(
      '[SqliteDbAdapter] Initialized (chats/messages + connections + themes + push + service-accounts on SQLite)'
    );
    return true;
  }

  async isHealthy(): Promise<boolean> {
    // Every domain is local SQLite (always reachable once initialized), so the
    // runtime is healthy as soon as the stores are up.
    return true;
  }

  getAdapterType(): string {
    return 'SQLite(chats,connections,themes,push,service-accounts)';
  }

  /** Close the underlying SQLite handles (tests / graceful shutdown). */
  close(): void {
    this.store.close();
    this.messageStore?.close?.();
    this.connectionStore.close();
    this.themeStore.close();
    this.pushStore.close();
    this.serviceAccountStore.close();
  }

  // ==========================================================================
  // CHAT METHODS (SQLite)
  // ==========================================================================

  async saveChat(options: SaveChatOptions): Promise<boolean> {
    const {
      userId,
      chatId,
      type,
      title,
      status,
      repoPath,
      repoFullName,
      sessionId,
      forkSourceSessionId,
      systemPrompt,
      playwrightDevice,
      summary,
      model,
      permissions,
      agentSetupId,
      parentChatId,
      workflowRunId,
    } = options;

    await this.store.upsertChat(chatId, (existing) => {
      const now = Date.now();
      // saveChat upsert: preserves selected existing fields, applies schema
      // defaults, and (as on upsert) resets hidden/archived to false.
      const row: ChatRow = {
        id: chatId,
        user_id: userId,
        type,
        title,
        summary: summary !== undefined ? summary : (existing?.summary ?? null),
        status: status ?? null,
        hidden: false,
        archived: false,
        last_updated: now,
        repo_path: repoPath ?? null,
        repo_full_name: repoFullName ?? existing?.repo_full_name ?? null,
        session_id: sessionId ?? null,
        fork_source_session_id: forkSourceSessionId ?? existing?.fork_source_session_id ?? null,
        system_prompt: systemPrompt ?? null,
        playwright_device:
          playwrightDevice !== undefined ? playwrightDevice : (existing?.playwright_device ?? null),
        model: model !== undefined ? model : (existing?.model ?? DEFAULT_MODEL_MODE),
        permissions:
          permissions !== undefined ? permissions : (existing?.permissions ?? 'bypass_permissions'),
        effort: existing?.effort ?? null,
        agent_setup_id:
          agentSetupId !== undefined ? agentSetupId : (existing?.agent_setup_id ?? 'freestyle'),
        parent_chat_id:
          parentChatId !== undefined ? parentChatId : (existing?.parent_chat_id ?? null),
        workflow_run_id: workflowRunId ?? null,
        routine_id: existing?.routine_id ?? null,
        last_read_message_id: existing?.last_read_message_id ?? null,
        linked_issue: existing?.linked_issue ?? null,
        created_at: existing?.created_at ?? now,
      };
      return row;
    });

    return true;
  }

  /** Discover in-scope terminal-originated transcripts. [] when off. */
  private async discoverChatsInScope(): Promise<DiscoveredChat[]> {
    if (!this.chatIndex || !this.reposProvider) return [];
    try {
      return await this.chatIndex.discoverChats(await this.reposProvider());
    } catch (err) {
      console.warn('[SqliteDbAdapter] chat discovery failed (continuing with SQLite rows):', err);
      return [];
    }
  }

  /** Synthesize a chat ROW for a discovered terminal transcript (no SQLite row). */
  private discoveredToRow(d: DiscoveredChat, userId: string): ChatRow {
    return {
      id: d.sessionId,
      user_id: userId,
      type: 'claude_code',
      title: d.title,
      summary: null,
      status: 'completed',
      hidden: false,
      archived: false,
      saved: false,
      pinned: false,
      last_updated: d.lastUpdated,
      repo_path: d.repoPath,
      // The GitHub full_name (owner/repo from the git remote) so the chat list can
      // show the repo NAME — the flat-clone repo_path is a raw disk path the mobile client
      // can't parse for owner/repo (it would fall back to a generic "Workspace" label).
      repo_full_name: d.repoFullName,
      session_id: d.sessionId,
      system_prompt: null,
      playwright_device: null,
      model: DEFAULT_MODEL_MODE,
      permissions: 'default',
      agent_setup_id: null,
      parent_chat_id: null,
      workflow_run_id: null,
      routine_id: null,
      last_read_message_id: null,
      linked_issue: null,
      created_at: d.lastUpdated,
    };
  }

  /**
   * Union the SQLite chat rows with terminal-originated transcripts,
   * reconciled by session_id: a SQLite row whose session_id matches a transcript is the
   * OVERLAY (kept as-is); a transcript with no matching row becomes a synthesized
   * terminal chat. SQLite rows with session_id=null list until their transcript appears.
   * Discovered chats are never archived, so they only appear in the non-archived view.
   */
  private async unionChatRows(
    sqliteRows: ChatRow[],
    knownSessionIds: Set<string>,
    userId: string,
    archived?: boolean,
    category?: ChatCategory
  ): Promise<ChatRow[]> {
    if (!this.chatIndex) return sqliteRows;
    // Discovered transcripts are always active — only union them into the active view.
    if (!includeDiscoveredFor(category, archived)) return sqliteRows;
    const discovered = await this.discoverChatsInScope();
    const terminal = discovered
      .filter((d) => !knownSessionIds.has(d.sessionId))
      .map((d) => this.discoveredToRow(d, userId));
    return [...sqliteRows, ...terminal];
  }

  async getChats(
    userId: string,
    _authToken?: string,
    archived?: boolean,
    portableOnly?: boolean,
    category?: ChatCategory
  ): Promise<StoredChat[]> {
    const chats = await this.store.readAllChats();
    const sqliteRows = Array.from(chats.values())
      .filter((c) => c.user_id === userId)
      .filter((c) => chatMatchesCategory(c, category, archived));
    // Terminal-only: just the portable-native chats (real rows that were messaged →
    // session_id set), with NO discovered-transcript union.
    if (portableOnly) {
      return sqliteRows
        .filter((c) => c.session_id != null)
        .sort(pinnedThenRecent)
        .map((c) => this.transformer.transformChatFromDb(c));
    }
    const known = new Set(sqliteRows.map((c) => c.session_id).filter((s): s is string => !!s));
    const all = await this.unionChatRows(sqliteRows, known, userId, archived, category);
    return all.sort(pinnedThenRecent).map((c) => this.transformer.transformChatFromDb(c));
  }

  async getChatsWithPreviews(
    userId: string,
    limit: number = 50,
    offset: number = 0,
    _authToken?: string,
    archived?: boolean,
    portableOnly?: boolean,
    category?: ChatCategory
  ): Promise<any[]> {
    const chats = await this.store.readAllChats();
    const sqliteRows = Array.from(chats.values())
      .filter((c) => c.user_id === userId)
      .filter((c) => chatMatchesCategory(c, category, archived))
      // Terminal-only: keep only portable-native chats that were actually messaged
      // (session_id set). The discovered union below is also skipped when portableOnly.
      .filter((c) => (portableOnly ? c.session_id != null : true));
    const known = new Set(sqliteRows.map((c) => c.session_id).filter((s): s is string => !!s));
    const discovered =
      portableOnly === true || !includeDiscoveredFor(category, archived)
        ? []
        : await this.discoverChatsInScope().then((ds) => ds.filter((d) => !known.has(d.sessionId)));
    const discMap = new Map(discovered.map((d) => [d.sessionId, d]));
    const all = [...sqliteRows, ...discovered.map((d) => this.discoveredToRow(d, userId))]
      .sort(pinnedThenRecent)
      .slice(offset, offset + limit);

    return Promise.all(
      all.map(async (chat) => {
        // A synthesized terminal row (chat.id not in the SQLite map) takes its preview
        // from the discovered transcript; a real SQLite row reads its message stream.
        if (!chats.has(chat.id)) {
          const d = discMap.get(chat.id);
          return {
            ...this.transformer.transformChatFromDb(chat),
            message_count: d?.messageCount ?? 0,
            first_message_data: d?.firstMessageData,
            last_message_data: d?.lastMessageData,
          };
        }
        const messages = this.messageStore
          ? await this.messageStore.readMessages(chat.id)
          : await this.store.readMessages(chat.id);
        // Skip injected task-notification rows as preview candidates (public issue #11).
        const { firstUserMessage, lastMessage } = pickPreviewRows(messages);
        return {
          ...this.transformer.transformChatFromDb(chat),
          message_count: messages.length,
          first_message_data: firstUserMessage?.data,
          last_message_data: lastMessage?.data,
        };
      })
    );
  }

  async getChat(
    chatId: string,
    userId: string,
    _authToken?: string
  ): Promise<StoredChat | undefined> {
    const chat = await this.store.getChat(chatId);
    if (chat && chat.user_id === userId) {
      return this.transformer.transformChatFromDb(chat);
    }
    // A terminal-originated chat has a transcript but no SQLite row — open it
    // by synthesizing a row from discovery (chatId is the session id).
    if (this.chatIndex) {
      const d = (await this.discoverChatsInScope()).find((x) => x.sessionId === chatId);
      if (d) return this.transformer.transformChatFromDb(this.discoveredToRow(d, userId));
    }
    return undefined;
  }

  /**
   * Classify a chatId as a real Portable row, a discovered CC transcript, or unknown
   * (fork-on-first-write). A discovered chat (no row, transcript only) is the one
   * Portable must FORK instead of resume so the source transcript is never mutated.
   */
  async getChatOrigin(chatId: string, userId: string, _authToken?: string): Promise<ChatOrigin> {
    const row = await this.store.getChat(chatId);
    if (row && row.user_id === userId) {
      return { origin: 'sqlite' };
    }
    // Discovery only exists in JSONL mode (chatIndex wired). In SQLite mode there are no
    // terminal transcripts to fork, so this can only be 'none' for a missing row.
    if (this.chatIndex) {
      const d = (await this.discoverChatsInScope()).find((x) => x.sessionId === chatId);
      if (d) {
        return {
          origin: 'discovered',
          sourceSessionId: d.sessionId,
          cwd: d.cwd,
          repoPath: d.repoPath,
          repoFullName: d.repoFullName,
          title: d.title,
          lastUpdated: d.lastUpdated,
        };
      }
    }
    return { origin: 'none' };
  }

  async updateChatStatus(
    chatId: string,
    userId: string,
    status: ChatStatus,
    _authToken?: string
  ): Promise<boolean> {
    // Status update is best-effort and reports success regardless.
    await this.store.patchChat(chatId, userId, () => ({ status }));
    return true;
  }

  async updateChatTitle(
    chatId: string,
    userId: string,
    title: string,
    _authToken?: string
  ): Promise<boolean> {
    // Title update is best-effort and reports success regardless.
    await this.store.patchChat(chatId, userId, () => ({ title }));
    return true;
  }

  async updateChatSummary(
    chatId: string,
    userId: string,
    summary: string,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({ summary }));
  }

  async deleteChat(chatId: string, userId: string, _authToken?: string): Promise<boolean> {
    const deleted = await this.store.deleteChat(chatId, userId);
    // Also drop this chat's overlay side-stream rows (we never touch the
    // SDK-owned JSONL transcript). Best-effort; the chat row delete is authoritative.
    if (deleted && this.messageStore?.deleteMessages) {
      await this.messageStore.deleteMessages(chatId).catch(() => {});
    }
    return deleted;
  }

  async archiveChat(
    chatId: string,
    userId: string,
    archived: boolean,
    _authToken?: string
  ): Promise<boolean> {
    // Archiving clears "saved" (the buckets are mutually exclusive).
    return this.store.patchChat(chatId, userId, () =>
      archived ? { archived: true, saved: false } : { archived: false }
    );
  }

  async setChatSaved(
    chatId: string,
    userId: string,
    saved: boolean,
    _authToken?: string
  ): Promise<boolean> {
    // Saving clears "archived" (the buckets are mutually exclusive).
    return this.store.patchChat(chatId, userId, () =>
      saved ? { saved: true, archived: false } : { saved: false }
    );
  }

  async setChatPinned(
    chatId: string,
    userId: string,
    pinned: boolean,
    _authToken?: string
  ): Promise<boolean> {
    // Pin is orthogonal to the category — it never changes archived/saved.
    return this.store.patchChat(chatId, userId, () => ({ pinned }));
  }

  async updateChatSession(
    chatId: string,
    userId: string,
    sessionId: string,
    systemPrompt: string,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({
      session_id: sessionId,
      system_prompt: systemPrompt,
    }));
  }

  async updatePlaywrightDevice(
    chatId: string,
    userId: string,
    device: 'mobile' | 'desktop',
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({ playwright_device: device }));
  }

  async updatePermissions(
    chatId: string,
    userId: string,
    permissions: string,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({ permissions }));
  }

  async updateModel(
    chatId: string,
    userId: string,
    model: string,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({ model }));
  }

  async updateEffort(
    chatId: string,
    userId: string,
    effort: string,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({ effort }));
  }

  async updateAgentSetupId(
    chatId: string,
    userId: string,
    agentSetupId: string,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({ agent_setup_id: agentSetupId }));
  }

  async updateLastReadMessageId(
    chatId: string,
    userId: string,
    messageId: number,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({ last_read_message_id: messageId }));
  }

  async updateLinkedIssue(
    chatId: string,
    userId: string,
    linkedIssue: { owner: string; repo: string; number: number } | null,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({ linked_issue: linkedIssue }));
  }

  async getLastChatActivityByRepo(
    userId: string,
    _authToken?: string
  ): Promise<Map<string, string>> {
    const chats = await this.store.readAllChats();
    const activityMap = new Map<string, string>();

    for (const row of chats.values()) {
      if (row.user_id !== userId || !row.repo_path || !row.last_updated) {
        continue;
      }
      const existing = activityMap.get(row.repo_path);
      const existingTime = existing ? new Date(existing).getTime() : 0;
      if (row.last_updated > existingTime) {
        activityMap.set(row.repo_path, new Date(row.last_updated).toISOString());
      }
    }

    return activityMap;
  }

  async getChatsByWorkflowRunId(workflowRunId: string, _authToken?: string): Promise<StoredChat[]> {
    const chats = await this.store.readAllChats();
    return Array.from(chats.values())
      .filter((c) => c.workflow_run_id === workflowRunId)
      .sort((a, b) => b.created_at - a.created_at)
      .map((c) => this.transformer.transformChatFromDb(c));
  }

  // ==========================================================================
  // MESSAGE METHODS (SQLite)
  // ==========================================================================

  async saveMessage(
    chatId: string,
    type: string,
    data: any,
    timestamp: number,
    _authToken?: string
  ): Promise<boolean> {
    // In JSONL mode the message store persists ONLY portable overlay events
    // (the SDK already wrote the conversation to the transcript); the SQLite default
    // persists every row as before.
    if (this.messageStore) {
      await this.messageStore.appendMessage(chatId, type, data, timestamp);
      return true;
    }
    await this.store.appendMessage(chatId, type, data, timestamp);
    return true;
  }

  async getMessages(chatId: string, _authToken?: string): Promise<BufferedMessage[]> {
    return this.messageStore
      ? this.messageStore.readMessages(chatId)
      : this.store.readMessages(chatId);
  }

  async getMessageCount(chatId: string, _authToken?: string): Promise<number> {
    return this.messageStore
      ? this.messageStore.getMessageCount(chatId)
      : this.store.getMessageCount(chatId);
  }

  // ==========================================================================
  // CONNECTIONS (SQLite)
  // Connection METADATA persists to local SQLite under DATA_DIR. Credentials
  // still live encrypted in the LocalSecretStore (LocalSecretsAdapter writes an
  // empty `{}` here); single-user scoping is enforced by the user_id filter in
  // every query (see SqliteConnectionStore).
  // ==========================================================================

  getUserConnections(options: GetUserConnectionsOptions): Promise<ServiceConnection[]> {
    return this.connectionStore.getUserConnections(options);
  }
  getConnectionCredentials(options: GetConnectionOptions): Promise<any | null> {
    return this.connectionStore.getConnectionCredentials(options);
  }
  getConnection(options: GetConnectionOptions): Promise<ServiceConnection | null> {
    return this.connectionStore.getConnection(options);
  }
  getConnectionsByService(options: GetConnectionsByServiceOptions): Promise<ServiceConnection[]> {
    return this.connectionStore.getConnectionsByService(options);
  }
  storeConnection(options: StoreConnectionOptions): Promise<ServiceConnection> {
    return this.connectionStore.storeConnection(options);
  }
  deleteConnection(options: GetConnectionOptions): Promise<void> {
    return this.connectionStore.deleteConnection(options);
  }
  renameConnection(options: RenameConnectionDbOptions): Promise<ServiceConnection> {
    return this.connectionStore.renameConnection(options);
  }
  toggleConnectionActive(
    options: GetConnectionOptions & { isActive: boolean }
  ): Promise<ServiceConnection> {
    return this.connectionStore.toggleConnectionActive(options);
  }
  getActiveConnectionsByService(
    options: GetConnectionsByServiceOptions
  ): Promise<ServiceConnection[]> {
    return this.connectionStore.getActiveConnectionsByService(options);
  }
  hasConnection(options: GetConnectionOptions): Promise<boolean> {
    return this.connectionStore.hasConnection(options);
  }

  // ==========================================================================
  // THEMES (SQLite)
  // User themes persist to local SQLite under DATA_DIR. Single-user scoping is
  // enforced by the user_id filter in every query (see SqliteThemeStore).
  // authToken is ignored locally.
  // ==========================================================================

  getTheme(userEmail: string, _authToken?: string): Promise<Record<string, any> | null> {
    return this.themeStore.getTheme(userEmail);
  }
  saveTheme(
    userEmail: string,
    themeConfig: Record<string, any>,
    _authToken?: string
  ): Promise<boolean> {
    return this.themeStore.saveTheme(userEmail, themeConfig);
  }
  deleteTheme(userEmail: string, _authToken?: string): Promise<boolean> {
    return this.themeStore.deleteTheme(userEmail);
  }

  // ==========================================================================
  // SERVICE ACCOUNTS + AUDIT LOG (SQLite)
  // The service-accounts and service-account-audit-log domains persist to local
  // SQLite under DATA_DIR. Single-user scoping enforced by the user_id filter in
  // every service-account query (see SqliteServiceAccountStore). authToken
  // ignored locally.
  // ==========================================================================

  createServiceAccount(
    serviceAccount: Parameters<DbAdapter['createServiceAccount']>[0],
    _authToken?: string
  ): Promise<boolean> {
    return this.serviceAccountStore.createServiceAccount(serviceAccount);
  }
  getServiceAccounts(
    userId: string,
    _authToken?: string
  ): ReturnType<DbAdapter['getServiceAccounts']> {
    return this.serviceAccountStore.getServiceAccounts(userId);
  }
  getServiceAccount(
    id: string,
    userId: string,
    _authToken?: string
  ): ReturnType<DbAdapter['getServiceAccount']> {
    return this.serviceAccountStore.getServiceAccount(id, userId);
  }
  getServiceAccountByPrefix(
    tokenPrefix: string,
    _authToken?: string
  ): ReturnType<DbAdapter['getServiceAccountByPrefix']> {
    return this.serviceAccountStore.getServiceAccountByPrefix(tokenPrefix);
  }
  updateServiceAccount(
    id: string,
    userId: string,
    updates: Parameters<DbAdapter['updateServiceAccount']>[2],
    _authToken?: string
  ): Promise<boolean> {
    return this.serviceAccountStore.updateServiceAccount(id, userId, updates);
  }
  deleteServiceAccount(id: string, userId: string, _authToken?: string): Promise<boolean> {
    return this.serviceAccountStore.deleteServiceAccount(id, userId);
  }
  updateServiceAccountUsage(id: string, _authToken?: string): Promise<boolean> {
    return this.serviceAccountStore.updateServiceAccountUsage(id);
  }
  updateServiceAccountRateLimit(
    id: string,
    requestsCount: number,
    windowStart: Date,
    _authToken?: string
  ): Promise<boolean> {
    return this.serviceAccountStore.updateServiceAccountRateLimit(id, requestsCount, windowStart);
  }
  createServiceAccountAuditLog(
    log: Parameters<DbAdapter['createServiceAccountAuditLog']>[0],
    _authToken?: string
  ): Promise<boolean> {
    return this.serviceAccountStore.createServiceAccountAuditLog(log);
  }
  getServiceAccountAuditLogs(
    serviceAccountId: string,
    options?: Parameters<DbAdapter['getServiceAccountAuditLogs']>[1],
    _authToken?: string
  ): ReturnType<DbAdapter['getServiceAccountAuditLogs']> {
    return this.serviceAccountStore.getServiceAccountAuditLogs(serviceAccountId, options);
  }

  // ==========================================================================
  // PUSH SUBSCRIPTIONS (SQLite)
  // Multi-device push subscriptions persist to local SQLite under DATA_DIR.
  // Single-user scoping via the user_id filter in every query (see
  // SqlitePushStore). authToken ignored.
  // ==========================================================================

  savePushSubscription(
    userId: string,
    subscription: Parameters<DbAdapter['savePushSubscription']>[1],
    _authToken?: string
  ): Promise<boolean> {
    return this.pushStore.savePushSubscription(userId, subscription);
  }
  removePushSubscription(userId: string, endpoint: string, _authToken?: string): Promise<boolean> {
    return this.pushStore.removePushSubscription(userId, endpoint);
  }
  getUserPushSubscriptions(
    userId: string,
    _authToken?: string
  ): ReturnType<DbAdapter['getUserPushSubscriptions']> {
    return this.pushStore.getUserPushSubscriptions(userId);
  }
  getNotificationSettings(
    userId: string,
    _authToken?: string
  ): ReturnType<DbAdapter['getNotificationSettings']> {
    return this.pushStore.getNotificationSettings(userId);
  }
  updateNotificationSettings(
    userId: string,
    settings: Parameters<DbAdapter['updateNotificationSettings']>[1],
    _authToken?: string
  ): Promise<boolean> {
    return this.pushStore.updateNotificationSettings(userId, settings);
  }
}
