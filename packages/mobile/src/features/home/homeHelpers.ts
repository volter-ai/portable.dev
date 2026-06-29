/**
 * Pure presentation helpers for the home screen sections — the formatting logic
 * for the native home (relative time, repo-name parsing, font sizing).
 */

/** Relative time label. */
export function getRelativeTime(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

/**
 * Resolve `owner/repo` from a Claude-workspace repo path.
 * Path format: `~/claude-workspace/{email}/{owner}/{repo}`.
 */
export function getRepoFromPath(path: string | undefined): string | null {
  if (!path) return null;
  const segments = path.split('/').filter((s) => s && s !== '~');
  const idx = segments.indexOf('claude-workspace');
  if (idx === -1) return null;
  const owner = segments[idx + 2];
  const repo = segments[idx + 3];
  if (!owner || !repo) return null;
  if (['workspace', 'claude-workspace', 'vgit'].includes(owner)) return null;
  return `${owner}/${repo}`;
}

/** Just the repo segment of a workspace path (shows repo-only). */
export function getRepoNameFromPath(path: string | undefined): string | null {
  return getRepoFromPath(path)?.split('/').pop() ?? null;
}

/** The repo owner (login) of a workspace path, or null. */
export function getRepoOwnerFromPath(path: string | undefined): string | null {
  return getRepoFromPath(path)?.split('/')[0] ?? null;
}

/**
 * Repo NAME = the last segment of a raw disk path (handles `/` and `\`). The
 * flat-clone `repo_path` is an absolute disk path with no `claude-workspace/owner/repo`
 * structure, so {@link getRepoFromPath} returns null for it; this is the last-resort
 * fallback to at least show the repo's directory name instead of a generic "Workspace".
 * Owner is NOT recoverable from a flat path (it comes from the git remote, server-side).
 */
export function getRepoBasename(path: string | undefined): string | null {
  if (!path) return null;
  const seg = path
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .pop();
  return seg && seg !== '~' ? seg : null;
}

/** Font size for a repo-card name, shrinking as the name grows (px). */
export function repoNameFontSize(length: number): number {
  if (length <= 8) return 12.8;
  if (length <= 12) return 12;
  if (length <= 16) return 11.2;
  if (length <= 20) return 10.4;
  if (length <= 24) return 9.6;
  return 8.8;
}

/** Strip the autopilot stop-word the agent emits. */
export function pruneAutopilotStopWord(text: string): string {
  return text.replace(/<promise>complete<\/promise>/gi, '').trim();
}
