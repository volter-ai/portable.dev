/**
 * Test Chat Fixtures
 * Factory functions for creating test chat data
 */

import type { StoredChat, Chat, ChatListItem } from '@vgit2/shared/types';

/**
 * Create a complete StoredChat with sensible defaults
 */
export function createStoredChat(overrides: Partial<StoredChat> = {}): StoredChat {
  const now = Date.now();

  return {
    id: 'test-chat-001',
    user_id: 'test@example.com',
    type: 'claude_code',
    title: 'Test Chat',
    summary: 'A test chat for automated testing',
    status: 'idle',
    hidden: 0,
    archived: 0,
    last_updated: now,
    repo_path: 'owner/repo',
    session_id: null,
    system_prompt: null,
    playwright_device: 'desktop',
    model: 'claude-sonnet-4.5',
    permissions: 'default',
    last_read_message_id: null,
    linked_issue: null,
    agent_setup_id: null,
    routine_id: null,
    created_at: now,
    ...overrides,
  };
}

/**
 * Create a frontend Chat object with sensible defaults
 */
export function createChat(overrides: Partial<Chat> = {}): Chat {
  const now = Date.now();

  return {
    id: 'test-chat-001',
    type: 'claude_code',
    title: 'Test Chat',
    summary: 'A test chat for automated testing',
    messages: [],
    status: 'idle',
    hidden: false,
    archived: false,
    lastUpdated: now,
    repo_path: 'owner/repo',
    hasMore: false,
    totalCount: 0,
    isJoined: false,
    playwrightDevice: 'desktop',
    model: 'claude-sonnet-4.5',
    permissions: 'default',
    lastReadMessageId: undefined,
    ...overrides,
  };
}

/**
 * Create a ChatListItem with sensible defaults
 */
export function createChatListItem(overrides: Partial<ChatListItem> = {}): ChatListItem {
  const now = Date.now();

  return {
    id: 'test-chat-001',
    type: 'claude_code',
    title: 'Test Chat',
    summary: 'A test chat for automated testing',
    status: 'idle',
    hidden: false,
    archived: false,
    lastUpdated: now,
    repo_path: 'owner/repo',
    lastReadMessageId: undefined,
    ...overrides,
  };
}

// Predefined test chats for common scenarios

export const testChats = {
  /**
   * Active chat with default settings
   */
  activeChat: (): StoredChat =>
    createStoredChat({
      id: 'chat-active-001',
      title: 'Active Chat',
      status: 'idle',
      archived: 0,
      hidden: 0,
    }),

  /**
   * Chat with repository context
   */
  repoChat: (owner: string, repo: string): StoredChat =>
    createStoredChat({
      id: `chat-repo-${owner}-${repo}`,
      title: `Working on ${owner}/${repo}`,
      repo_path: `${owner}/${repo}`,
    }),

  /**
   * Archived chat
   */
  archivedChat: (): StoredChat =>
    createStoredChat({
      id: 'chat-archived-001',
      title: 'Archived Chat',
      status: 'completed',
      archived: 1,
    }),

  /**
   * Hidden chat
   */
  hiddenChat: (): StoredChat =>
    createStoredChat({
      id: 'chat-hidden-001',
      title: 'Hidden Chat',
      hidden: 1,
    }),

  /**
   * Chat with linked GitHub issue
   */
  chatWithIssue: (owner: string, repo: string, issueNumber: number): StoredChat =>
    createStoredChat({
      id: 'chat-with-issue-001',
      title: `Fix issue #${issueNumber}`,
      repo_path: `${owner}/${repo}`,
      linked_issue: JSON.stringify({ owner, repo, number: issueNumber }),
    }),

  /**
   * Chat created by routine
   */
  routineChat: (routineId: string): StoredChat =>
    createStoredChat({
      id: `chat-routine-${routineId}`,
      title: 'Routine Execution',
      routine_id: routineId,
    }),

  /**
   * Chat with different model
   */
  haikuChat: (): StoredChat =>
    createStoredChat({
      id: 'chat-haiku-001',
      title: 'Haiku Chat',
      model: 'claude-haiku-3.5',
    }),

  /**
   * Chat with bypass permissions
   */
  bypassPermissionsChat: (): StoredChat =>
    createStoredChat({
      id: 'chat-bypass-001',
      title: 'Bypass Permissions Chat',
      permissions: 'bypass_permissions',
    }),

  /**
   * Multiple chats for the same user
   */
  multipleChats: (userId: string, count: number): StoredChat[] => {
    return Array.from({ length: count }, (_, i) =>
      createStoredChat({
        id: `chat-${userId}-${i + 1}`,
        user_id: userId,
        title: `Chat ${i + 1}`,
        last_updated: Date.now() + i * 1000, // Stagger timestamps
      })
    );
  },
};
