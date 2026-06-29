/**
 * groupChatsByProject — pure helper that buckets the chat directory by the
 * Portable project (GitHub repo) each chat belongs to, for the "By project" view
 * of {@link ChatDirectoryScreen}.
 *
 * The project of a chat is derived EXACTLY as the chat card derives its repo tag
 * ({@link ChatCardBody}) so the two never disagree: the backend-resolved GitHub
 * `repoFullName` (owner/repo) wins, then the legacy `claude-workspace/owner/repo`
 * path parse, then the flat-clone disk basename (repo name only, no owner), and
 * finally a "Workspace" catch-all for chats with no resolvable repo.
 *
 * Ordering matches the spec: the most-recently-touched PROJECT appears first
 * (a group's rank = its newest chat's `lastUpdated`), and within a project the
 * most-recently-updated chat is first. Both `Array.prototype.sort` calls are
 * stable, so equal-timestamp items keep their input order; the project sort
 * tie-breaks on the label for fully-deterministic output (and deterministic tests).
 */

import type { ChatListItem } from '@vgit2/shared/types';

import { getRepoBasename, getRepoFromPath } from '../home/homeHelpers';

/** Sentinel key for chats with no resolvable repo (rendered as "Workspace"). */
export const WORKSPACE_PROJECT_KEY = '__workspace__';

export interface ChatProjectSection {
  /** Stable grouping key (lowercased full name / `name:<basename>` / workspace sentinel). */
  key: string;
  /** Display label — the repo NAME (last path segment), or "Workspace". */
  label: string;
  /** GitHub owner login when known (drives the section avatar); null for local/workspace. */
  owner: string | null;
  /** The project's chats, most-recently-updated first. */
  chats: ChatListItem[];
  /** Newest activity in the group (ms) — the group's sort rank. */
  lastUpdated: number;
}

/** Resolve the project key/label/owner for a single chat (the ChatCardBody order). */
function projectOf(chat: ChatListItem): Pick<ChatProjectSection, 'key' | 'label' | 'owner'> {
  const fullName = chat.repoFullName || getRepoFromPath(chat.repo_path) || undefined;
  if (fullName) {
    const owner = fullName.split('/')[0] || null;
    const label = fullName.split('/').pop() || fullName;
    // Local repos have no GitHub remote — show the name but suppress the owner avatar.
    return { key: fullName.toLowerCase(), label, owner: owner && owner !== 'local' ? owner : null };
  }
  const basename = getRepoBasename(chat.repo_path);
  if (basename) return { key: `name:${basename.toLowerCase()}`, label: basename, owner: null };
  return { key: WORKSPACE_PROJECT_KEY, label: 'Workspace', owner: null };
}

/**
 * Group `chats` by project. Returns sections ordered most-recently-touched first,
 * each with its chats ordered most-recently-updated first.
 */
export function groupChatsByProject(chats: ChatListItem[]): ChatProjectSection[] {
  const byKey = new Map<string, ChatProjectSection>();
  for (const chat of chats) {
    const { key, label, owner } = projectOf(chat);
    let section = byKey.get(key);
    if (!section) {
      section = { key, label, owner, chats: [], lastUpdated: 0 };
      byKey.set(key, section);
    }
    section.chats.push(chat);
    section.lastUpdated = Math.max(section.lastUpdated, chat.lastUpdated ?? 0);
  }

  const sections = Array.from(byKey.values());
  for (const section of sections) {
    // Pinned chats float to the top of their project group, then most-recent-first.
    section.chats.sort(
      (a, b) =>
        (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastUpdated ?? 0) - (a.lastUpdated ?? 0)
    );
  }
  sections.sort((a, b) => b.lastUpdated - a.lastUpdated || a.label.localeCompare(b.label));
  return sections;
}
