/**
 * Pure unit tests for {@link groupChatsByProject} — the "By project" grouping that
 * powers the chat-directory project view. No RN / native modules: the helper only
 * pulls the pure `homeHelpers` repo-path utilities, so this runs as a plain test.
 */

import type { ChatListItem } from '@vgit2/shared/types';

import {
  groupChatsByProject,
  WORKSPACE_PROJECT_KEY,
} from '../src/features/chat/groupChatsByProject';

/** Minimal chat factory — only the fields grouping reads. */
function chat(partial: Partial<ChatListItem> & { id: string }): ChatListItem {
  return { type: 'chat' as ChatListItem['type'], title: partial.id, ...partial };
}

describe('groupChatsByProject', () => {
  it('orders projects by most-recent activity and chats within a project by recency', () => {
    const sections = groupChatsByProject([
      chat({ id: 'a-old', repoFullName: 'acme/widget', lastUpdated: 100 }),
      chat({ id: 'b-new', repoFullName: 'globex/gadget', lastUpdated: 300 }),
      chat({ id: 'a-new', repoFullName: 'acme/widget', lastUpdated: 500 }),
    ]);

    // acme/widget's newest chat (500) beats globex/gadget's (300) → acme first.
    expect(sections.map((s) => s.key)).toEqual(['acme/widget', 'globex/gadget']);
    expect(sections[0].lastUpdated).toBe(500);
    // Within acme/widget the newer chat is first.
    expect(sections[0].chats.map((c) => c.id)).toEqual(['a-new', 'a-old']);
    // The owner + label are derived from the full name.
    expect(sections[0]).toMatchObject({ owner: 'acme', label: 'widget' });
  });

  it('derives the project from repoFullName, the workspace path, the disk basename, then Workspace', () => {
    const sections = groupChatsByProject([
      chat({ id: 'full', repoFullName: 'acme/widget', lastUpdated: 40 }),
      chat({ id: 'path', repo_path: '~/claude-workspace/me/octo/repo', lastUpdated: 30 }),
      chat({ id: 'disk', repo_path: '/home/me/projects/flatclone', lastUpdated: 20 }),
      chat({ id: 'none', lastUpdated: 10 }),
    ]);

    const byKey = Object.fromEntries(sections.map((s) => [s.key, s]));
    expect(byKey['acme/widget'].chats.map((c) => c.id)).toEqual(['full']);
    expect(byKey['octo/repo']).toMatchObject({ owner: 'octo', label: 'repo' });
    expect(byKey['name:flatclone']).toMatchObject({ owner: null, label: 'flatclone' });
    expect(byKey[WORKSPACE_PROJECT_KEY]).toMatchObject({ owner: null, label: 'Workspace' });
  });

  it('groups full names case-insensitively and suppresses the local owner avatar', () => {
    const sections = groupChatsByProject([
      chat({ id: 'x', repoFullName: 'Acme/Widget', lastUpdated: 1 }),
      chat({ id: 'y', repoFullName: 'acme/widget', lastUpdated: 2 }),
      chat({ id: 'z', repoFullName: 'local/scratch', lastUpdated: 3 }),
    ]);

    const widget = sections.find((s) => s.key === 'acme/widget');
    expect(widget?.chats.map((c) => c.id)).toEqual(['y', 'x']); // one merged group
    const local = sections.find((s) => s.key === 'local/scratch');
    expect(local?.owner).toBeNull(); // local repos have no GitHub remote → no avatar
  });

  it('returns an empty array for no chats', () => {
    expect(groupChatsByProject([])).toEqual([]);
  });
});
