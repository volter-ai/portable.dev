/**
 * ClaudeProjectsChatIndex (rev9 Feature 3 / D29b) — discovers the CHAT LIST from the
 * SDK's `~/.claude/projects/<slug>/<session>.jsonl` transcripts, so a session run in the PC terminal
 * `claude` (which has a transcript but NO portable SQLite row) still appears in the app.
 *
 * Scope (Q-F3c LOCKED): keep ONLY transcripts whose `cwd` IS / is UNDER a repo
 * discovered in the workspace (F1's `getLocalRepositories`) — "all my chats ABOUT my
 * workspace repos". A `cwd` in a non-repo folder (workspace root, `data/`, `.chat-data`)
 * is excluded; a `cwd` in a repo SUBDIR maps to that repo (longest-prefix wins). This
 * reuses the F1 repo-set as the scope filter and is agnostic to how the workspace root
 * is defined (a configured `WORKSPACE_DIR` in rev9, the launch `cwd` in rev10).
 *
 * An mtime-indexed cache re-parses only transcripts whose file changed, so the list
 * stays fast over hundreds of project dirs.
 */
import { promises as fs } from 'fs';
import path from 'path';

import { listProjectTranscripts } from './projectsPaths.js';
import {
  parseTranscript,
  transcriptCwd,
  transcriptLastTimestamp,
  transcriptTitle,
  transcriptToMessages,
} from './transcriptReader.js';
import { pickPreviewRows } from '../previewRows.js';

export interface DiscoveredChat {
  /** session id == the transcript filename; used as the chat id when there is no row. */
  sessionId: string;
  /** The matched repo's REAL on-disk path (the chat's display repo_path). */
  repoPath: string;
  /**
   * The transcript's actual `cwd` (may be a SUBDIR of the matched repo). This is the
   * slug input that LOCATES the `.jsonl`, so it MUST be kept separate from `repoPath`
   * — a session run in `<repo>/packages/api` is filed under `slug(<repo>/packages/api)`,
   * not `slug(<repo>)`, and reading it by the repo root would 404 → empty chat.
   */
  cwd: string;
  /** The matched repo's GitHub full_name. */
  repoFullName: string;
  title: string;
  lastUpdated: number;
  messageCount: number;
  firstMessageData: unknown;
  lastMessageData: unknown;
}

interface CacheEntry {
  mtimeMs: number;
  cwd: string | null;
  title: string | null;
  lastUpdated: number;
  messageCount: number;
  firstMessageData: unknown;
  lastMessageData: unknown;
}

export interface WorkspaceRepo {
  full_name: string;
  localPath: string;
}

export class ClaudeProjectsChatIndex {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly configDir: string) {}

  /**
   * Discover all in-scope chats from the projects dir. `repos` is F1's
   * `getLocalRepositories` result over the workspace root (the scope filter).
   */
  async discoverChats(repos: WorkspaceRepo[]): Promise<DiscoveredChat[]> {
    if (repos.length === 0) return [];
    const transcripts = await listProjectTranscripts(this.configDir);
    // Pre-resolve each repo to ALL of its on-disk identities (raw-resolved + realpath)
    // so a junction/symlink repo (a Windows junction or a POSIX symlink in the workspace)
    // still matches a transcript whose `cwd` the CLI recorded as the RESOLVED target — the
    // SDK realpaths the cwd, so a junctioned repo's transcripts are filed under the target
    // path, never the junction path. Without this, junctioned repos show zero CC history.
    const repoRoots = await Promise.all(
      repos.map(async (repo) => ({ repo, roots: await repoRootCandidates(repo.localPath) }))
    );
    const out: DiscoveredChat[] = [];
    for (const t of transcripts) {
      const entry = await this.summarize(t.filePath, t.mtimeMs);
      if (!entry || !entry.cwd) continue;
      if (entry.messageCount === 0) continue; // empty / meta-only / clear-only — never a phantom chat
      const match = await matchRepoReal(entry.cwd, repoRoots);
      if (!match) continue; // out of workspace-repo scope (Q-F3c)
      out.push({
        sessionId: t.sessionId,
        repoPath: match.localPath,
        cwd: entry.cwd,
        repoFullName: match.full_name,
        title: entry.title ?? 'Untitled chat',
        lastUpdated: entry.lastUpdated,
        messageCount: entry.messageCount,
        firstMessageData: entry.firstMessageData,
        lastMessageData: entry.lastMessageData,
      });
    }
    return out;
  }

  private async summarize(filePath: string, mtimeMs: number): Promise<CacheEntry | null> {
    const cached = this.cache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      return null;
    }
    const lines = parseTranscript(raw);
    const rows = transcriptToMessages(lines);
    // Skip injected task-notification rows as preview candidates (public issue #11).
    const { firstUserMessage: firstUser, lastMessage: last } = pickPreviewRows(rows);
    const entry: CacheEntry = {
      mtimeMs,
      cwd: transcriptCwd(lines),
      title: transcriptTitle(lines),
      lastUpdated: transcriptLastTimestamp(lines) || mtimeMs,
      messageCount: rows.length,
      firstMessageData: firstUser?.data,
      lastMessageData: last?.data,
    };
    this.cache.set(filePath, entry);
    return entry;
  }
}

/** Match a transcript `cwd` to the workspace repo that contains it (longest prefix wins). */
export function matchRepo(cwd: string, repos: WorkspaceRepo[]): WorkspaceRepo | null {
  const c = path.resolve(cwd);
  let best: WorkspaceRepo | null = null;
  for (const r of repos) {
    const lp = path.resolve(r.localPath);
    if (c === lp || c.startsWith(lp + path.sep)) {
      if (!best || r.localPath.length > best.localPath.length) best = r;
    }
  }
  return best;
}

/**
 * Resolve a path to its real on-disk identity, falling back to a plain `path.resolve`
 * when the path doesn't exist or can't be realpath'd (e.g. a transcript `cwd` whose dir
 * was since removed). Used to unify a junction/symlink with its target.
 */
async function realpathOrResolve(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** The set of on-disk roots a repo can be addressed by: its raw-resolved path and its realpath. */
async function repoRootCandidates(localPath: string): Promise<string[]> {
  const resolved = path.resolve(localPath);
  const real = await realpathOrResolve(localPath);
  return real === resolved ? [resolved] : [resolved, real];
}

/**
 * Realpath-aware variant of {@link matchRepo}: a transcript `cwd` matches a repo when
 * EITHER side's real path is / is under the other's, so a junctioned/symlinked repo
 * (workspace junction path) unifies with the transcript's resolved-target `cwd`. The
 * matched repo's ORIGINAL `localPath` (the junction display path) is preserved — only the
 * comparison uses real paths. Longest matching root wins (subdir → nested repo).
 */
async function matchRepoReal(
  cwd: string,
  repoRoots: { repo: WorkspaceRepo; roots: string[] }[]
): Promise<WorkspaceRepo | null> {
  const resolved = path.resolve(cwd);
  const real = await realpathOrResolve(cwd);
  const cwds = real === resolved ? [resolved] : [resolved, real];
  let best: WorkspaceRepo | null = null;
  let bestLen = -1;
  for (const { repo, roots } of repoRoots) {
    for (const root of roots) {
      for (const c of cwds) {
        if (c === root || c.startsWith(root + path.sep)) {
          if (root.length > bestLen) {
            best = repo;
            bestLen = root.length;
          }
        }
      }
    }
  }
  return best;
}
