import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { Octokit } from '@octokit/rest';
import { WORKSPACE_TMP_DIR } from '@vgit2/shared/browserConstants';
import { WORKSPACE_DIR, getUserWorkspaceDir, debugLog } from '@vgit2/shared/constants';
import * as constants from '@vgit2/shared/constants';
import { Request, Response } from 'express';

import { runGit, GitResourceLimitError } from './git/runGit.js';

import type { AuthService } from './AuthService.js';
import type { ConnectionsService } from './ConnectionsService.js';
import type { RunGitOptions } from './git/runGit.js';
import type { ReposCacheService } from './ReposCacheService.js';

const execFileAsync = promisify(execFile);

/**
 * Hard upper bound for a single `git clone`. Generous enough for large repos
 * over a slow link, but finite so a stalled transfer can never wedge the
 * in-flight clone guard. On timeout the child is SIGKILLed and
 * the promise rejects, which clears the in-flight entry and surfaces the error.
 */
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

// The hardened spawn-based git runner (timeout-SIGKILL, maxOutputBytes ceiling)
// lives in ./git/runGit.ts so SourceControlService (portable.dev#17) can share
// it. Re-exported here so existing consumers keep their import path.
export { GitResourceLimitError };
export type { RunGitOptions };

export interface RepositoryInfo {
  path: string;
  name: string;
  owner?: string;
  repo?: string;
}

/** Complete working-tree status for a repo: branch/ahead/behind + change counts. */
export interface CompleteRepoStatus {
  clean: boolean;
  branch: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  insertions: number;
  deletions: number;
  /**
   * Set only when the status could not be computed within its resource budget
   * (git timeout / output cap / breaker cooldown) and a stale or zeroed payload
   * was served instead. Absent on every successful compute. See
   * {@link GitLocalService.getRepoStatusSafe}.
   */
  degraded?: boolean;
}

/**
 * Owner placeholder for a locally-present repo with no resolvable GitHub remote
 * Mirrors `UserHandler.LOCAL_PLACEHOLDER_OWNER` so such repos are
 * dropped from the GitHub Tasks GraphQL query (which can't resolve a non-github slug)
 * while still surfacing as a local-only repo in the repos list.
 */
const LOCAL_PLACEHOLDER_OWNER = 'local';

/**
 * Extract the `[remote "origin"]` `url` from a git config file's TEXT.
 * Tolerant of section ordering / indentation. Returns the raw url or null. Pure +
 * exported so it can be unit-tested without touching the filesystem.
 */
export function extractOriginUrl(gitConfig: string): string | null {
  let inOrigin = false;
  for (const raw of gitConfig.split(/\r?\n/)) {
    const line = raw.trim();
    const section = line.match(/^\[(.+?)\]$/);
    if (section) {
      const name = section[1].trim().toLowerCase();
      inOrigin = name === 'remote "origin"' || name === 'remote origin';
      continue;
    }
    if (inOrigin) {
      const m = line.match(/^url\s*=\s*(.+)$/i);
      if (m) return m[1].trim();
    }
  }
  return null;
}

/**
 * Parse a GitHub `owner/repo` slug from a remote URL — github.com ONLY.
 * Non-github hosts return null on purpose: the repo then becomes a `local/<dir>`
 * entry (kept out of GitHub Tasks GraphQL, which can't resolve a non-github slug).
 * Handles https, ssh, and scp-like (`git@github.com:o/r.git`) forms, with/without a
 * trailing `.git`/slash. Pure + exported for unit testing.
 */
export function parseGitHubSlug(remoteUrl: string): { owner: string; repo: string } | null {
  const s = remoteUrl.trim();
  if (!/github\.com/i.test(s)) return null;
  const m = s.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  return owner && repo ? { owner, repo } : null;
}

/**
 * GitLocalService handles local git repository operations
 */
export class GitLocalService {
  private reposCache?: ReposCacheService;
  private authService?: AuthService;
  private connectionsService?: ConnectionsService;

  /**
   * Tracks in-progress clones keyed by destination repo path.
   *
   * Prevents a race condition where the manual "Clone to Local"
   * request, the auto-clone path, and rapid re-clicks all passed the
   * "is it cloned?" check before any `git clone` finished, each spawning its
   * own clone of the same repo until the server crashed. Concurrent callers
   * for the same path now await the single in-flight clone instead.
   */
  private inFlightClones = new Map<string, Promise<string>>();

  /**
   * Short-TTL cache + in-flight guard for git status.
   *
   * The chat UI used to fire GET /git-status on every streamed block; on
   * first-login sandbox provisioning the setup agent streamed hundreds of
   * blocks, and each request spawned 3 git subprocesses with no caching, which
   * flooded the backend until the sandbox crashed. This coalesces concurrent
   * requests for the same repo into one compute and serves repeats within the
   * TTL from memory. Keyed by absolute repoPath, which embeds the per-user
   * workspace dir (getUserWorkspaceDir), so entries are inherently per-user.
   */
  private statusCache = new Map<string, { data: CompleteRepoStatus; timestamp: number }>();
  private inFlightStatus = new Map<string, Promise<CompleteRepoStatus>>();
  /** Instance field (not a const) so tests can shrink/override the TTL. */
  private statusCacheTtlMs = 30_000;

  /**
   * Resource bounds for git-status work on LARGE repos.
   *
   * On a large repo inside a resource-constrained sandbox (gVisor, few vCPUs),
   * an unbounded `git status`/`git diff` could run for minutes and starve the
   * event loop, freezing every other route. These bounds guarantee a status
   * probe is cheap and finite:
   *   - statusGitTimeoutMs: SIGKILL a single status/diff subprocess past this.
   *   - statusOutputLimitBytes: SIGKILL if `git status` stdout balloons.
   *   - statusMaxConcurrent: process-wide cap on concurrent status computes, so
   *     the bulk / repos-list fan-out can't spawn N×3 git scans at once.
   *   - statusFailureCooldownMs: after a timeout for a repo, serve stale/degraded
   *     WITHOUT spawning git for this long — kills retry storms.
   * All are instance fields (not consts) so tests can shrink/override them.
   */
  private statusGitTimeoutMs = 15_000;
  private fetchTimeoutMs = 30_000;
  private statusOutputLimitBytes = 10 * 1024 * 1024;
  private statusMaxConcurrent = 2;
  private statusFailureCooldownMs = 60_000;
  /** repoPath -> epoch ms of the last resource-limit failure (circuit breaker). */
  private statusFailures = new Map<string, number>();
  /** Live count + waiter queue backing the {@link withStatusSlot} semaphore. */
  private statusActive = 0;
  private statusQueue: Array<() => void> = [];
  /**
   * Indirection seam for the git subprocess runner so tests can stub it without
   * spawning real git. Status/diff/fetch/unpushed-count go through `this.gitRunner`;
   * clone keeps calling the module `runGit` directly so its tests are unaffected.
   */
  private gitRunner: typeof runGit = runGit;

  constructor(
    _containerService?: any,
    reposCache?: ReposCacheService,
    authService?: AuthService,
    connectionsService?: ConnectionsService
  ) {
    this.reposCache = reposCache;
    this.authService = authService;
    this.connectionsService = connectionsService;
    debugLog(
      '[GitLocalService] Initialized with cache invalidation:',
      reposCache ? 'ENABLED' : 'DISABLED'
    );
  }

  /**
   * Clone a repository for a specific user using their stored GitHub credentials.
   * Resolves the GitHub token directly from ConnectionsService (no Express Request
   * required), so this can be called from socket-driven flows like chat creation.
   *
   * Invalidates the repos cache for the user after a successful clone.
   */
  async cloneRepositoryForUser(
    owner: string,
    repo: string,
    userId: string,
    authToken?: string,
    branch?: string
  ): Promise<string> {
    if (!this.connectionsService) {
      throw new Error(
        '[GitLocalService] ConnectionsService not available — cannot resolve GitHub token for auto-clone'
      );
    }

    const activeConnection = await this.connectionsService.getActiveGitHubConnection(
      userId,
      authToken
    );

    const token = activeConnection.token;
    if (!token) {
      const err = new Error('GitHub connection required. Please connect your GitHub account.');
      (err as any).code = 'INSUFFICIENT_GITHUB_PERMISSIONS';
      throw err;
    }

    const repoPath = await this.cloneRepository(owner, repo, userId, token, branch);

    if (this.reposCache) {
      const invalidated = this.reposCache.invalidateUser(userId);
      console.log(
        `[GitLocalService] Invalidated ${invalidated} cache entries after auto-clone for user ${userId}`
      );
    }

    return repoPath;
  }
  /**
   * Get list of locally cloned repositories (checks user-specific workspace)
   *
   * Scans the filesystem directly instead of calling GitHub API.
   * This is faster, more reliable, and doesn't require authentication.
   *
   * @param userId - User identifier for workspace isolation
   */
  async getLocalRepositories(
    userId: string
  ): Promise<Array<{ full_name: string; localPath: string }>> {
    return this.getLocalRepositoriesIn(getUserWorkspaceDir(userId));
  }

  /**
   * Scan a SPECIFIC workspace root for local repos. Split out from
   * {@link getLocalRepositories} so the directory-walk can be unit-tested against a
   * temp dir without redirecting the module-level `WORKSPACE_DIR`. Discovers BOTH a
   * FLAT clone (`<root>/<repo>/.git`, owner derived from the git remote) and the
   * legacy two-level (`<root>/<owner>/<repo>/.git`, owner from the dir name) layout.
   */
  async getLocalRepositoriesIn(
    userWorkspace: string
  ): Promise<Array<{ full_name: string; localPath: string }>> {
    const localRepos: Array<{ full_name: string; localPath: string }> = [];
    const seen = new Set<string>();

    const push = (full_name: string, localPath: string) => {
      if (seen.has(localPath)) return;
      seen.add(localPath);
      localRepos.push({ full_name, localPath });
    };

    try {
      // Check if workspace directory exists
      await fs.access(userWorkspace);

      // Read the top-level entries directly under the workspace root.
      const entries = await fs.readdir(userWorkspace, { withFileTypes: true });

      for (const entry of entries) {
        const entryName = entry.name;
        // node_modules is never a repo container — skip it (a custom WORKSPACE_DIR
        // could be a dir that has one, and readdir'ing it would be slow + useless).
        // `tmp` is the workspace SCRATCH folder (one-off / "Workspace" chats) — it is
        // deliberately NOT a Portable project, so skip it even if a stray `.git` appears.
        if (entryName === 'node_modules' || entryName === WORKSPACE_TMP_DIR) continue;

        const entryPath = path.join(userWorkspace, entryName);
        // Accept real directories AND junctions/symlinks that resolve to a
        // directory — an external repo surfaced into the workspace via a link.
        // Node reports a Windows JUNCTION as a symlink (isDirectory() === false),
        // so a bare isDirectory() check would silently skip it.
        if (!(await this.isDirectoryLike(entry, entryPath))) continue;

        // a FLAT clone — `<workspace>/<repo>/.git` sitting DIRECTLY under
        // the workspace root (the user's own `git clone`). Derive owner/full_name
        // from the git remote, because the dir name is NOT necessarily the GitHub
        // slug — so isLocal matching + Tasks GraphQL still line up with GitHub.
        if (await this.pathExists(path.join(entryPath, '.git'))) {
          const slug = await this.deriveFlatRepoSlug(entryPath);
          const fullName = slug
            ? `${slug.owner}/${slug.repo}`
            : `${LOCAL_PLACEHOLDER_OWNER}/${entryName}`;
          push(fullName, entryPath);
          continue;
        }

        // Two-level (portable-cloned) layout: `<workspace>/<owner>/<repo>/.git`. Here
        // the dir names ARE the GitHub owner/repo (portable cloned them that way).
        let repos: import('fs').Dirent[];
        try {
          repos = await fs.readdir(entryPath, { withFileTypes: true });
        } catch {
          continue; // unreadable owner dir — skip
        }
        for (const repoEntry of repos) {
          const repoName = repoEntry.name;
          const repoPath = path.join(entryPath, repoName);
          if (!(await this.isDirectoryLike(repoEntry, repoPath))) continue;
          if (await this.pathExists(path.join(repoPath, '.git'))) {
            push(`${entryName}/${repoName}`, repoPath);
          }
        }
      }
    } catch (error) {
      // Workspace doesn't exist or can't be read
      debugLog('[GitLocalService] Could not read workspace:', error);
    }

    return localRepos;
  }

  /**
   * Resolve the on-disk path of a locally-present repo for a GitHub `owner`/`repo`
   * Consults {@link getLocalRepositories} so BOTH a FLAT clone
   * (`<workspace>/<dir>` whose remote is `owner/repo`, dir name irrelevant) and a
   * two-level (`<workspace>/<owner>/<repo>`) clone resolve to their REAL path. Falls
   * back to the canonical two-level path when the repo isn't present yet — the caller
   * (`createChat` / `ensureRepoCloned`) then auto-clones into that path. This is what
   * makes portable USE the user's pre-existing flat checkout instead of cloning a
   * duplicate two-level copy of it.
   */
  async resolveLocalRepoPath(userId: string, owner: string, repo: string): Promise<string> {
    const userWorkspace = getUserWorkspaceDir(userId);
    const target = `${owner}/${repo}`.toLowerCase();
    try {
      const repos = await this.getLocalRepositoriesIn(userWorkspace);
      const match = repos.find((r) => r.full_name.toLowerCase() === target);
      if (match) return match.localPath;
    } catch {
      // fall through to the canonical path
    }
    return path.join(userWorkspace, owner, repo);
  }

  /** True if `p` exists (any type). Thin wrapper over fs.access. */
  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Derive {owner, repo} for a FLAT clone from its `origin` remote. Reads
   * `<repo>/.git/config` DIRECTLY (no subprocess — getLocalRepositories runs on the
   * repos-list hot path). Returns null when there is no readable github.com origin
   * remote → the caller represents the repo as `local/<dir>`.
   */
  private async deriveFlatRepoSlug(
    repoPath: string
  ): Promise<{ owner: string; repo: string } | null> {
    const url = await this.readOriginUrl(repoPath);
    return url ? parseGitHubSlug(url) : null;
  }

  /**
   * Read the `origin` remote URL from a repo's `.git/config`. Handles the common
   * `.git` DIRECTORY layout and the `.git` FILE pointer (`gitdir: …`, worktrees /
   * submodules). Returns null on any read failure or missing origin.
   */
  private async readOriginUrl(repoPath: string): Promise<string | null> {
    const gitPath = path.join(repoPath, '.git');
    let configPath = path.join(gitPath, 'config');
    try {
      const st = await fs.stat(gitPath);
      if (st.isFile()) {
        const pointer = (await fs.readFile(gitPath, 'utf8')).trim();
        const m = pointer.match(/^gitdir:\s*(.+)$/m);
        if (!m) return null;
        const gitDir = path.isAbsolute(m[1]) ? m[1] : path.resolve(repoPath, m[1]);
        configPath = path.join(gitDir, 'config');
      }
    } catch {
      return null;
    }
    try {
      return extractOriginUrl(await fs.readFile(configPath, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * True if a directory entry is a real directory OR a junction/symlink that
   * resolves to a directory. Windows junctions report `isDirectory() === false`
   * + `isSymbolicLink() === true`, so the bare Dirent check skips them; this
   * follows the link (fs.stat) to recognize a linked-in external repo. Returns
   * false for a broken/dangling link (stat throws).
   */
  private async isDirectoryLike(
    entry: { isDirectory(): boolean; isSymbolicLink(): boolean },
    fullPath: string
  ): Promise<boolean> {
    if (entry.isDirectory()) return true;
    if (entry.isSymbolicLink()) {
      try {
        return (await fs.stat(fullPath)).isDirectory();
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Clone a repository to the user-specific workspace directory
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param userId - User identifier for workspace isolation
   * @param token - Optional GitHub OAuth token for private repos
   * @param branch - Optional branch to clone
   */
  async cloneRepository(
    owner: string,
    repo: string,
    userId: string,
    token?: string,
    branch?: string
  ): Promise<string> {
    const userWorkspace = getUserWorkspaceDir(userId);
    const repoPath = path.join(userWorkspace, owner, repo);

    // Concurrency guard: if a clone for this exact destination is already
    // running, await it instead of starting a second `git clone`.
    const existing = this.inFlightClones.get(repoPath);
    if (existing) {
      console.log(
        `[GitLocalService] [${userId}] Clone already in progress for ${repoPath}, awaiting existing operation`
      );
      return existing;
    }

    const clonePromise = this.performClone(owner, repo, userId, repoPath, token, branch);
    this.inFlightClones.set(repoPath, clonePromise);

    try {
      return await clonePromise;
    } finally {
      this.inFlightClones.delete(repoPath);
    }
  }

  /**
   * Performs the actual clone work (directory creation, existence check, and
   * `git clone`). Always invoked through {@link cloneRepository}, which guards
   * against concurrent clones of the same destination.
   */
  private async performClone(
    owner: string,
    repo: string,
    userId: string,
    repoPath: string,
    token?: string,
    branch?: string
  ): Promise<string> {
    const userWorkspace = getUserWorkspaceDir(userId);

    console.log(`[GitLocalService] [${userId}] Checking if ${repoPath} exists...`);

    // Create user-specific workspace directory if it doesn't exist
    const ownerDir = path.join(userWorkspace, owner);
    await fs.mkdir(ownerDir, { recursive: true });

    // Check if already cloned
    try {
      await fs.access(path.join(repoPath, '.git'));
      console.log(
        `[GitLocalService] [${userId}] Repository already exists at ${repoPath}, skipping clone`
      );
      return repoPath; // Already exists
    } catch {
      console.log(`[GitLocalService] [${userId}] Repository not found, cloning...`);
    }

    // Build git clone URL WITHOUT token embedding (tokens should be handled via credential helper)
    const cloneUrl = `https://github.com/${owner}/${repo}.git`;

    // --progress forces git to emit progress on stderr even when not attached
    // to a TTY, so we can surface clone progress to the logs.
    const args = ['clone', '--progress'];
    if (branch) {
      args.push('-b', branch);
    }
    args.push(cloneUrl, repoPath);

    // Log command without exposing token
    const safeArgs = token
      ? [
          'clone',
          ...(branch ? ['-b', branch] : []),
          `https://***@github.com/${owner}/${repo}.git`,
          repoPath,
        ]
      : args;
    console.log(`[GitLocalService] [${userId}] Executing: git ${safeArgs.join(' ')}`);

    // SAFETY: capture whether the destination already had content BEFORE the
    // clone. git refuses to clone into a non-empty dir (it writes nothing in
    // that case), so any pre-existing content is the USER's OWN files — never our
    // partial clone. On a clone failure we must only remove a directory THIS
    // attempt created, never delete pre-existing user work.
    let hadPreExistingContent = false;
    try {
      const existing = await fs.readdir(repoPath);
      hadPreExistingContent = existing.length > 0;
    } catch {
      // Destination does not exist yet — git will create it; safe to clean up.
    }

    // Execute git clone.
    //
    // GIT_TERMINAL_PROMPT=0 (+ GIT_ASKPASS/GCM_INTERACTIVE) is the critical
    // guard: when the stored credential is stale/invalid (common after a
    // sandbox snapshot/restore, or for a private repo whose token momentarily
    // mismatches) git would otherwise RE-PROMPT for a username/password on the
    // (non-interactive) terminal and block forever. A wedged clone is far worse
    // than a failed one here — the in-flight guard in cloneRepository() hands
    // that same never-resolving promise to every subsequent caller for this
    // repo, so one stuck clone freezes all clone/auto-clone attempts until the
    // sandbox is restarted. Forcing non-interactive auth turns an infinite hang
    // into a fast, surfaced failure; the timeout is a backstop for a stalled
    // network transfer.
    try {
      // Stream via spawn (no maxBuffer ceiling) and surface progress.
      await runGit(args, {
        timeoutMs: CLONE_TIMEOUT_MS,
        env: {
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: 'true',
          GCM_INTERACTIVE: 'never',
        },
        onProgress: (chunk) => {
          const trimmed = chunk.trim();
          if (trimmed) {
            console.log(`[GitLocalService] [${userId}] clone: ${trimmed}`);
          }
        },
      });
    } catch (error) {
      // A failed or timed-out clone (SIGKILL leaves no cleanup) can leave a
      // partial destination directory behind. git refuses to clone into a
      // non-empty dir, so the leftover would make every retry fail too —
      // remove it before surfacing the error so the next attempt starts clean.
      // SAFETY: only remove a directory THIS clone created. If the destination
      // already had content before we started, that content is the user's OWN
      // work (git wrote nothing into a non-empty dir) — NEVER delete it.
      if (!hadPreExistingContent) {
        await fs.rm(repoPath, { recursive: true, force: true }).catch(() => {});
      } else {
        console.warn(
          `[GitLocalService] [${userId}] Clone failed for ${repoPath}; leaving the pre-existing directory untouched (NOT deleting user files)`
        );
      }
      console.error(`[GitLocalService] [${userId}] Clone failed for ${repoPath}:`, error);
      throw error;
    }

    console.log(`[GitLocalService] [${userId}] Successfully cloned to ${repoPath}`);
    return repoPath;
  }

  /**
   * Clone a repository in user's container
   * Delegates the clone operation to the user's container so files are isolated
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param userId - User identifier for workspace isolation
   * @param token - GitHub OAuth token for authentication
   * @param branch - Optional branch to clone
   * @returns Path to repository in user's container workspace
   */
  /**
   * Find all local git repositories in common directories (user-specific)
   * @param userId - User identifier for workspace isolation
   */
  async findLocalRepos(userId: string): Promise<RepositoryInfo[]> {
    const repos: RepositoryInfo[] = [];
    const homedir = os.homedir();
    const userWorkspace = getUserWorkspaceDir(userId);

    // Common directories where developers keep repos
    const searchDirs = [
      userWorkspace, // Include user-specific workspace
      path.join(homedir, 'code'),
      path.join(homedir, 'projects'),
      path.join(homedir, 'dev'),
      path.join(homedir, 'workspace'),
      path.join(homedir, 'Documents', 'code'),
      path.join(homedir, 'Documents', 'projects'),
    ];

    for (const searchDir of searchDirs) {
      try {
        const entries = await fs.readdir(searchDir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const fullPath = path.join(searchDir, entry.name);
            const gitPath = path.join(fullPath, '.git');

            try {
              await fs.access(gitPath);
              repos.push({ path: fullPath, name: entry.name });
            } catch {
              // Not a git repo at this level, check if it's an owner directory (one level deeper)
              // This handles our ~/workspace/{owner}/{repo} structure
              try {
                const subEntries = await fs.readdir(fullPath, { withFileTypes: true });
                for (const subEntry of subEntries) {
                  if (subEntry.isDirectory()) {
                    const subPath = path.join(fullPath, subEntry.name);
                    const subGitPath = path.join(subPath, '.git');

                    try {
                      await fs.access(subGitPath);
                      repos.push({
                        path: subPath,
                        name: `${entry.name}/${subEntry.name}`,
                      });
                    } catch {
                      // Not a git repo, skip
                    }
                  }
                }
              } catch {
                // Can't read subdirectory, skip
              }
            }
          }
        }
      } catch {
        // Directory doesn't exist, skip
      }
    }

    return repos;
  }

  /**
   * Get repository status using git status command
   */
  async getRepositoryStatus(repoPath: string): Promise<{
    clean: boolean;
    branch: string;
    ahead: number;
    behind: number;
    staged: number;
    modified: number;
    untracked: number;
  }> {
    try {
      // `--no-optional-locks` (global flag, must precede `status`) stops git from
      // taking the index lock to write a refreshed index — avoids contention with
      // the agent's concurrent git usage in the same repo. Bounded by a hard
      // timeout (SIGKILL) and an output cap so a huge repo can't run unbounded.
      const stdout = await this.gitRunner(
        ['--no-optional-locks', 'status', '--porcelain', '--branch'],
        {
          cwd: repoPath,
          timeoutMs: this.statusGitTimeoutMs,
          maxOutputBytes: this.statusOutputLimitBytes,
        }
      );

      const lines = stdout.trim().split('\n');
      const branchLine = lines[0];
      const fileLines = lines.slice(1);

      // Parse branch info
      const branchMatch = branchLine.match(/## ([^.]+)(...([^ ]+))?( \[(.+)\])?/);
      const branch = branchMatch ? branchMatch[1] : 'unknown';

      let ahead = 0;
      let behind = 0;
      if (branchMatch && branchMatch[5]) {
        const aheadMatch = branchMatch[5].match(/ahead (\d+)/);
        const behindMatch = branchMatch[5].match(/behind (\d+)/);
        ahead = aheadMatch ? parseInt(aheadMatch[1]) : 0;
        behind = behindMatch ? parseInt(behindMatch[1]) : 0;
      }

      // Count file statuses
      let staged = 0;
      let modified = 0;
      let untracked = 0;

      for (const line of fileLines) {
        if (!line) continue;
        const status = line.substring(0, 2);
        if (status[0] !== ' ' && status[0] !== '?') staged++;
        if (status[1] !== ' ' && status[1] !== '?') modified++;
        if (status === '??') untracked++;
      }

      return {
        clean: fileLines.length === 0 || (fileLines.length === 1 && !fileLines[0]),
        branch,
        ahead,
        behind,
        staged,
        modified,
        untracked,
      };
    } catch (error) {
      if (error instanceof GitResourceLimitError) {
        console.warn(`[GitLocalService] Status degraded for ${repoPath}: ${error.message}`);
        throw error;
      }

      console.error(`[GitLocalService] Error getting status for ${repoPath}:`, error);
      throw error;
    }
  }

  /**
   * Get diff stats (insertions/deletions).
   *
   * Uses `--shortstat` (a single summary line) instead of `--numstat` (one line
   * per changed file): on a large repo with thousands of changed files, numstat
   * could blow the 1 MB execFile buffer and force a multi-MB synchronous parse.
   * shortstat is O(1) output. Each call is hard-timeout bounded (SIGKILL).
   *
   * A resource-limit failure (timeout) is rethrown so the breaker can open; any
   * other error (e.g. not-a-repo / no diff) degrades to zero counts as before.
   */
  async getDiffStats(repoPath: string): Promise<{
    insertions: number;
    deletions: number;
  }> {
    try {
      let insertions = 0;
      let deletions = 0;

      // Unstaged changes (working directory vs index)
      const unstaged = this.parseShortstat(
        await this.gitRunner(['diff', '--shortstat'], {
          cwd: repoPath,
          timeoutMs: this.statusGitTimeoutMs,
        })
      );
      insertions += unstaged.insertions;
      deletions += unstaged.deletions;

      // Staged changes (index vs HEAD)
      const staged = this.parseShortstat(
        await this.gitRunner(['diff', '--cached', '--shortstat'], {
          cwd: repoPath,
          timeoutMs: this.statusGitTimeoutMs,
        })
      );
      insertions += staged.insertions;
      deletions += staged.deletions;

      return { insertions, deletions };
    } catch (error) {
      // A timeout/output-cap must propagate so the breaker opens. Everything
      // else (no diff, transient error) degrades to zero counts as before.
      if (error instanceof GitResourceLimitError) throw error;
      return { insertions: 0, deletions: 0 };
    }
  }

  /**
   * Parse a `git diff --shortstat` summary line, e.g.
   *   ` 3 files changed, 12 insertions(+), 4 deletions(-)`
   * Handles singular forms (`1 insertion(+)`), insertions-only, deletions-only,
   * binary-only (`1 file changed` with neither group), and empty output (no
   * changes) — all missing groups count as 0.
   */
  private parseShortstat(out: string): { insertions: number; deletions: number } {
    const insMatch = out.match(/(\d+) insertions?\(\+\)/);
    const delMatch = out.match(/(\d+) deletions?\(-\)/);
    return {
      insertions: insMatch ? parseInt(insMatch[1], 10) : 0,
      deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
    };
  }

  /**
   * Get complete repository status with diff stats.
   *
   * Backed by a 30s TTL cache + in-flight dedup: concurrent
   * callers for the same repoPath share one compute, and repeats within the TTL
   * return the cached result. Pass { bypassCache: true } to force a fresh
   * compute (still deduped, still written through) — used by the fetch variant
   * and the post-run "?fresh=1" refetch so counts are accurate right after the
   * agent changes files.
   */
  async getCompleteRepoStatus(
    repoPath: string,
    opts?: { bypassCache?: boolean }
  ): Promise<CompleteRepoStatus> {
    if (!opts?.bypassCache) {
      const cached = this.statusCache.get(repoPath);
      if (cached && Date.now() - cached.timestamp < this.statusCacheTtlMs) {
        return cached.data;
      }
    }

    // Circuit breaker (checked even for bypassCache/fresh=1): a repo whose status
    // just timed out would time out again if re-probed, so during the cooldown we
    // refuse to spawn git and throw — getRepoStatusSafe turns that into a stale /
    // degraded payload. This is what stops a retry storm from re-pegging the CPU.
    this.assertNotCoolingDown(repoPath);

    // Join an in-flight compute for the same repo instead of spawning another.
    const existing = this.inFlightStatus.get(repoPath);
    if (existing) return existing;

    // Run the compute under the process-wide concurrency cap so the bulk /
    // repos-list fan-out can't launch N×3 git scans at once on a big sandbox.
    const promise = this.withStatusSlot(() => this.computeCompleteRepoStatus(repoPath));
    this.inFlightStatus.set(repoPath, promise);

    try {
      const data = await promise;
      // Cache successes only. A rejected compute is never cached and clears the
      // lock in `finally`, so a retry recomputes (mirrors the clone guard).
      this.statusCache.set(repoPath, { data, timestamp: Date.now() });
      this.statusFailures.delete(repoPath); // success closes the breaker
      return data;
    } catch (err) {
      // Only resource-limit failures (timeout / output cap) open the breaker. A
      // genuine git error (bad repo, no commits) must NOT — it should keep
      // surfacing so it's retryable and visible (preserves the contract).
      if (
        err instanceof GitResourceLimitError &&
        (err.kind === 'timeout' || err.kind === 'output')
      ) {
        this.statusFailures.set(repoPath, Date.now());
      }
      throw err;
    } finally {
      this.inFlightStatus.delete(repoPath);
    }
  }

  /**
   * Throws a {@link GitResourceLimitError} of kind `cooldown` when `repoPath` is
   * within the post-timeout cooldown window, so callers skip spawning git.
   */
  private assertNotCoolingDown(repoPath: string): void {
    const failedAt = this.statusFailures.get(repoPath);
    if (failedAt !== undefined && Date.now() - failedAt < this.statusFailureCooldownMs) {
      throw new GitResourceLimitError(
        `git status for ${repoPath} is cooling down after a recent timeout`,
        'cooldown'
      );
    }
  }

  /**
   * Runs `fn` under a process-wide semaphore (`statusMaxConcurrent`). When full,
   * callers wait FIFO; a freed slot is handed directly to the next waiter (the
   * active count never dips between release and re-acquire, so the cap is hard).
   */
  private async withStatusSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.statusActive >= this.statusMaxConcurrent) {
      await new Promise<void>((resolve) => this.statusQueue.push(resolve));
      // A slot was handed to us; statusActive already accounts for it.
    } else {
      this.statusActive++;
    }

    try {
      return await fn();
    } finally {
      const next = this.statusQueue.shift();
      if (next) {
        next(); // hand our slot straight to the next waiter (do NOT decrement)
      } else {
        this.statusActive--;
      }
    }
  }

  /**
   * Resilient entry point for routes/handlers: returns a valid {@link CompleteRepoStatus}
   * even when git is too slow/big to compute within budget. The ONLY method the
   * API layer should call.
   *
   * On a resource-limit failure (timeout / output cap / breaker cooldown) it
   * serves the last cached value (any age) marked `degraded: true`, or a zeroed
   * `branch: 'unknown'` payload if nothing is cached — so the client never
   * hangs and never retry-storms. A genuine git error still rejects so the route
   * can return 500.
   */
  async getRepoStatusSafe(
    repoPath: string,
    opts?: { bypassCache?: boolean; fetchFirst?: boolean }
  ): Promise<CompleteRepoStatus> {
    try {
      if (opts?.fetchFirst) {
        return await this.fetchAndGetCompleteRepoStatus(repoPath);
      }
      return await this.getCompleteRepoStatus(repoPath, { bypassCache: opts?.bypassCache });
    } catch (err) {
      if (err instanceof GitResourceLimitError) {
        const cached = this.statusCache.get(repoPath);
        if (cached) {
          return { ...cached.data, degraded: true };
        }
        return {
          clean: true,
          branch: 'unknown',
          ahead: 0,
          behind: 0,
          staged: 0,
          modified: 0,
          untracked: 0,
          insertions: 0,
          deletions: 0,
          degraded: true,
        };
      }
      throw err;
    }
  }

  /**
   * Count commits present on local branches but not on any remote (unpushed).
   * `rev-list --count` emits a single integer (no maxBuffer concern) and is
   * hard-timeout bounded. Returns 0 on any failure — best-effort metadata.
   */
  async getUnpushedCount(repoPath: string): Promise<number> {
    try {
      const stdout = await this.gitRunner(
        ['rev-list', '--count', '--branches', '--not', '--remotes'],
        { cwd: repoPath, timeoutMs: 10_000 }
      );
      return parseInt(stdout.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Performs the actual status + diff computation. Always invoked through
   * {@link getCompleteRepoStatus}, which guards against concurrent computes of
   * the same repo and caches the result.
   */
  private async computeCompleteRepoStatus(repoPath: string): Promise<CompleteRepoStatus> {
    const [status, diffStats] = await Promise.all([
      this.getRepositoryStatus(repoPath),
      this.getDiffStats(repoPath),
    ]);

    return {
      ...status,
      ...diffStats,
    };
  }

  /**
   * Fetch from remote and then get complete repository status, ensuring
   * ahead/behind counts are accurate relative to the remote.
   *
   * Deduped against itself (key `fetch:<repoPath>`) and writes through the
   * shared status cache so a following /git-status hits warm data. Always runs a
   * real `git fetch` + fresh compute (bypassCache) — it must NOT short-circuit on
   * a warm plain-cache entry, whose ahead/behind could be up to a TTL stale.
   */
  async fetchAndGetCompleteRepoStatus(repoPath: string): Promise<CompleteRepoStatus> {
    // Honor the breaker before spawning anything (incl. the `git fetch`): a repo
    // cooling down after a status timeout should not even attempt a fetch.
    this.assertNotCoolingDown(repoPath);

    const key = `fetch:${repoPath}`;
    const existing = this.inFlightStatus.get(key);
    if (existing) return existing;

    const promise = (async () => {
      await this.performFetch(repoPath);
      // bypassCache: re-read after fetch so ahead/behind are accurate. The inner
      // call writes through the shared cache, warming it for plain /git-status.
      return this.getCompleteRepoStatus(repoPath, { bypassCache: true });
    })();
    this.inFlightStatus.set(key, promise);

    try {
      return await promise;
    } finally {
      this.inFlightStatus.delete(key);
    }
  }

  /**
   * Runs `git fetch` to update remote-tracking refs. Failures (no remote,
   * offline) are logged and swallowed so status can still be returned. Extracted
   * so the fetch-and-status flow can be tested without spawning git.
   */
  private async performFetch(repoPath: string): Promise<void> {
    try {
      // Hard-timeout bounded: a stalled fetch (offline, slow remote) must never
      // wedge the fetch-and-status flow. Failures are swallowed so status can
      // still be returned (ahead/behind may just be stale).
      await this.gitRunner(['fetch'], { cwd: repoPath, timeoutMs: this.fetchTimeoutMs });
      debugLog(`[GitLocalService] Fetched remote refs for ${repoPath}`);
    } catch (error) {
      // If fetch fails (no remote, network issue, timeout), log but continue
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[GitLocalService] Failed to fetch for ${repoPath}: ${message}`);
    }
  }

  /**
   * Get unified diff output for all changes (staged + unstaged)
   * Returns standard git diff format compatible with diff libraries
   */
  async getUnifiedDiff(repoPath: string): Promise<string> {
    try {
      // Get both staged and unstaged changes in unified diff format.
      // Use the spawn-based gitRunner (no maxBuffer ceiling) so large diffs don't
      // fail, but bound each subprocess with statusGitTimeoutMs — on a large repo
      // (or one being scanned while GitHub is offline) an unbounded `git diff`
      // could run for minutes and never resolve, wedging this route.
      const stagedDiff = await this.gitRunner(['diff', '--cached'], {
        cwd: repoPath,
        timeoutMs: this.statusGitTimeoutMs,
      });
      const unstagedDiff = await this.gitRunner(['diff'], {
        cwd: repoPath,
        timeoutMs: this.statusGitTimeoutMs,
      });

      // Combine both diffs
      return stagedDiff + unstagedDiff;
    } catch (error) {
      console.error(`[GitLocalService] Error getting unified diff:`, error);
      throw error;
    }
  }

  /**
   * Get list of changed files with their status
   */
  async getChangedFiles(repoPath: string): Promise<
    Array<{
      path: string;
      status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
      insertions: number;
      deletions: number;
    }>
  > {
    try {
      // Get file list with numstat. Use the spawn-based gitRunner with a hard
      // timeout: the old execFileAsync had no timeout (could hang on a large repo)
      // and a 1 MB maxBuffer that throws on big change sets. gitRunner bounds the
      // time and streams without a buffer ceiling.
      const stdout = await this.gitRunner(['diff', '--numstat', 'HEAD'], {
        cwd: repoPath,
        timeoutMs: this.statusGitTimeoutMs,
      });

      const files: Array<{
        path: string;
        status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
        insertions: number;
        deletions: number;
      }> = [];

      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        const [added, removed, filePath] = line.split('\t');

        files.push({
          path: filePath,
          status: 'modified', // TODO: detect added/deleted/renamed from git status
          insertions: parseInt(added) || 0,
          deletions: parseInt(removed) || 0,
        });
      }

      return files;
    } catch (error) {
      return [];
    }
  }

  /**
   * Execute arbitrary git command in repository
   */
  async executeGitCommand(repoPath: string, command: string[]): Promise<string> {
    try {
      // Bound via the spawn-based gitRunner (hard timeout, no maxBuffer ceiling)
      // so an arbitrary git command can't hang indefinitely or fail on >1 MB
      // output on a large repo.
      const stdout = await this.gitRunner(command, {
        cwd: repoPath,
        timeoutMs: this.statusGitTimeoutMs,
      });
      return stdout;
    } catch (error) {
      console.error(`[GitLocalService] Error executing git ${command.join(' ')}:`, error);
      throw error;
    }
  }

  /**
   * List all local repositories for a user with their git status.
   *
   * Reuse the FLAT-AWARE discovery
   * ({@link getLocalRepositoriesIn}) instead of the old hard-coded two-level
   * `<owner>/<repo>/.git` walk — so a FLAT clone (`<WORKSPACE_DIR>/<repo>/.git`, owner
   * derived from the git remote) is listed too, matching every other repo read surface.
   * The previous walk silently missed flat repos.
   */
  async listLocalReposWithStatus(userEmail: string): Promise<
    Array<{
      owner: string;
      repo: string;
      path: string;
      branch: string;
      ahead: number;
      behind: number;
      insertions: number;
      deletions: number;
      hasChanges: boolean;
    }>
  > {
    const userWorkspace = getUserWorkspaceDir(userEmail);

    try {
      // Flat-aware discovery: each entry is `{ full_name: 'owner/repo', localPath }`,
      // covering BOTH a flat `<root>/<repo>/.git` (owner from the git remote) and the
      // two-level `<root>/<owner>/<repo>/.git` layout.
      const localRepos = await this.getLocalRepositoriesIn(userWorkspace);

      const repos: Array<{
        owner: string;
        repo: string;
        path: string;
        branch: string;
        ahead: number;
        behind: number;
        insertions: number;
        deletions: number;
        hasChanges: boolean;
      }> = [];

      for (const lr of localRepos) {
        const slash = lr.full_name.indexOf('/');
        const owner = slash > 0 ? lr.full_name.slice(0, slash) : lr.full_name;
        const repo = slash > 0 ? lr.full_name.slice(slash + 1) : lr.full_name;

        try {
          // Resilient: serves stale/degraded counts instead of dropping a repo when a
          // large repo's status times out.
          const status = await this.getRepoStatusSafe(lr.localPath);

          repos.push({
            owner,
            repo,
            path: lr.localPath,
            branch: status.branch,
            ahead: status.ahead,
            behind: status.behind,
            insertions: status.insertions,
            deletions: status.deletions,
            hasChanges: !status.clean,
          });
        } catch {
          // Status failed for this repo — skip it, keep the rest.
          continue;
        }
      }

      return repos;
    } catch (error) {
      console.error('[GitLocalService] Error listing local repos:', error);
      return [];
    }
  }

  /**
   * Handle clone repository API endpoint
   */
  async handleCloneRequest(req: Request, res: Response): Promise<void> {
    // Check authentication
    if (!req.session.userEmail) {
      res.status(401).json({ error: 'Unauthorized: Please log in' });
      return;
    }

    const { owner, repo } = req.params as { owner: string; repo: string };
    const { branch } = req.body;
    const userId = req.session.userEmail;

    // Get GitHub token via AuthService (supports GitHub App connections)
    if (!this.authService) {
      res.status(500).json({ error: 'AuthService not initialized' });
      return;
    }

    let token: string;
    try {
      token = await this.authService.getGitHubToken(req);
    } catch (error: any) {
      console.error(`[GitLocalService] Failed to get GitHub token:`, error);
      if (error.code === 'INSUFFICIENT_GITHUB_PERMISSIONS') {
        res
          .status(401)
          .json({ error: 'GitHub connection required. Please connect your GitHub account.' });
      } else {
        res.status(500).json({ error: 'Failed to get GitHub token' });
      }
      return;
    }

    try {
      // ALWAYS clone in host (main container or local dev)
      // The workspace is mounted to user containers via Docker volume
      // So user containers will see the cloned repo automatically
      console.log(`[GitLocalService] [${userId}] Cloning ${owner}/${repo} in host`);
      console.log(
        `[GitLocalService] [${userId}] User containers will see this repo via workspace mount`
      );

      const repoPath = await this.cloneRepository(
        owner,
        repo,
        userId,
        token,
        branch as string | undefined
      );

      // Invalidate repos cache for this user so next request fetches fresh data with updated local status
      if (this.reposCache && userId) {
        const invalidated = this.reposCache.invalidateUser(userId);
        console.log(
          `[GitLocalService] Invalidated ${invalidated} cache entries after clone for user ${userId}`
        );
      }

      res.json({
        success: true,
        path: repoPath,
        message: `Repository cloned to ${repoPath}`,
      });
    } catch (error: any) {
      console.error(`[GitLocalService] [${userId}] Clone API Error:`, error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to clone repository',
      });
    }
  }

  /**
   * List environment files in a local repository
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param userId - User identifier for workspace isolation
   * @returns Array of environment file info
   */
  async listEnvFiles(
    owner: string,
    repo: string,
    userId: string
  ): Promise<
    Array<{
      filename: string;
      path: string;
      relativePath: string;
      size: number;
      lastModified: number;
      exists: boolean;
    }>
  > {
    const userWorkspace = getUserWorkspaceDir(userId);
    const repoPath = path.join(userWorkspace, owner, repo);

    // Check if repository is cloned locally
    try {
      await fs.access(path.join(repoPath, '.git'));
    } catch {
      console.log(`[GitLocalService] [${userId}] Repository not cloned locally: ${owner}/${repo}`);
      return [];
    }

    const envFiles: Array<{
      filename: string;
      path: string;
      relativePath: string;
      size: number;
      lastModified: number;
      exists: boolean;
    }> = [];

    // Recursively find all .env.* files in the repository
    const findEnvFiles = async (dir: string) => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relativePath = path.relative(repoPath, fullPath);

          // Skip node_modules, .git, and other common directories
          if (entry.isDirectory()) {
            const skipDirs = [
              'node_modules',
              '.git',
              'dist',
              'build',
              '.next',
              'coverage',
              'vendor',
            ];
            if (
              (!skipDirs.includes(entry.name) && !entry.name.startsWith('.')) ||
              entry.name === '.github'
            ) {
              await findEnvFiles(fullPath);
            }
          } else if (entry.isFile() && entry.name.startsWith('.env')) {
            try {
              const stats = await fs.stat(fullPath);
              envFiles.push({
                filename: entry.name,
                path: fullPath,
                relativePath: relativePath,
                size: stats.size,
                lastModified: stats.mtimeMs,
                exists: true,
              });
            } catch (err) {
              console.error(`[GitLocalService] Error reading file ${fullPath}:`, err);
            }
          }
        }
      } catch (err) {
        console.error(`[GitLocalService] Error reading directory ${dir}:`, err);
      }
    };

    await findEnvFiles(repoPath);

    // Sort by relative path for consistent ordering
    envFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    return envFiles;
  }

  /**
   * Read the contents of an environment file
   * @param filePath - Absolute path to the env file
   * @param userId - User identifier for validation
   * @returns Object with key-value pairs from the env file
   */
  async readEnvFile(filePath: string, userId: string): Promise<Record<string, string>> {
    const userWorkspace = getUserWorkspaceDir(userId);

    // Security check: ensure file is within user's workspace
    if (!filePath.startsWith(userWorkspace)) {
      throw new Error('Access denied: file is outside user workspace');
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const envVars: Record<string, string> = {};

      // Parse .env file format (KEY=VALUE)
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }

        const equalIndex = trimmed.indexOf('=');
        if (equalIndex > 0) {
          const key = trimmed.substring(0, equalIndex).trim();
          let value = trimmed.substring(equalIndex + 1).trim();

          // Remove quotes if present
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          ) {
            value = value.slice(1, -1);
          }

          envVars[key] = value;
        }
      }

      return envVars;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error('File not found');
      }
      throw new Error(`Failed to read env file: ${error.message}`);
    }
  }

  /**
   * Write contents to an environment file
   * @param filePath - Absolute path to the env file
   * @param envVars - Object with key-value pairs to write
   * @param userId - User identifier for validation
   */
  async writeEnvFile(
    filePath: string,
    envVars: Record<string, string>,
    userId: string
  ): Promise<void> {
    const userWorkspace = getUserWorkspaceDir(userId);

    // Security check: ensure file is within user's workspace
    if (!filePath.startsWith(userWorkspace)) {
      throw new Error('Access denied: file is outside user workspace');
    }

    try {
      // Read existing file to preserve comments and formatting where possible
      let existingContent = '';
      const existingKeys = new Set<string>();

      try {
        existingContent = await fs.readFile(filePath, 'utf-8');
        const lines = existingContent.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            const equalIndex = trimmed.indexOf('=');
            if (equalIndex > 0) {
              const key = trimmed.substring(0, equalIndex).trim();
              existingKeys.add(key);
            }
          }
        }
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          console.error(`[GitLocalService] Error reading existing file:`, error);
        }
      }

      // Build new content
      const lines: string[] = [];

      // If file existed, update existing keys and preserve structure
      if (existingContent) {
        const existingLines = existingContent.split('\n');
        for (const line of existingLines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) {
            lines.push(line);
            continue;
          }

          const equalIndex = trimmed.indexOf('=');
          if (equalIndex > 0) {
            const key = trimmed.substring(0, equalIndex).trim();
            if (key in envVars) {
              // Update the value
              const value = envVars[key];
              const needsQuotes =
                value.includes(' ') || value.includes('#') || value.includes('\n');
              lines.push(`${key}=${needsQuotes ? `"${value}"` : value}`);
            }
            // else: Skip this line (key was deleted)
          } else {
            lines.push(line);
          }
        }
      }

      // Add new keys that weren't in the original file
      for (const [key, value] of Object.entries(envVars)) {
        if (!existingKeys.has(key)) {
          const needsQuotes = value.includes(' ') || value.includes('#') || value.includes('\n');
          lines.push(`${key}=${needsQuotes ? `"${value}"` : value}`);
        }
      }

      // Write the file
      const content = lines.join('\n');
      await fs.writeFile(filePath, content, 'utf-8');

      console.log(`[GitLocalService] [${userId}] Updated env file: ${filePath}`);
    } catch (error: any) {
      throw new Error(`Failed to write env file: ${error.message}`);
    }
  }

  /**
   * Inject user-level secrets into a project's .env file
   * This merges user secrets with existing .env without overwriting existing keys
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param userId - User identifier
   * @param userSecrets - User-level secrets to inject
   * @param envFileName - Name of the env file (default: .env)
   * @returns Object with stats about injected secrets
   */
  async injectUserSecrets(
    owner: string,
    repo: string,
    userId: string,
    userSecrets: Record<string, string>,
    envFileName: string = '.env'
  ): Promise<{ added: number; skipped: number; total: number }> {
    const userWorkspace = getUserWorkspaceDir(userId);
    const repoPath = path.join(userWorkspace, owner, repo);
    const envFilePath = path.join(repoPath, envFileName);

    console.log(
      `[GitLocalService] [${userId}] Injecting ${Object.keys(userSecrets).length} user secrets into ${owner}/${repo}/${envFileName}`
    );

    let added = 0;
    let skipped = 0;

    try {
      // Read existing .env file
      const existingEnvVars: Record<string, string> = {};
      try {
        const content = await fs.readFile(envFilePath, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            const equalIndex = trimmed.indexOf('=');
            if (equalIndex > 0) {
              const key = trimmed.substring(0, equalIndex).trim();
              const value = trimmed.substring(equalIndex + 1).trim();
              existingEnvVars[key] = value;
            }
          }
        }
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          console.log(
            `[GitLocalService] [${userId}] ${envFileName} does not exist, will create it`
          );
        }
      }

      // Merge user secrets (only add keys that don't already exist)
      const mergedEnvVars = { ...existingEnvVars };
      for (const [key, value] of Object.entries(userSecrets)) {
        if (key in existingEnvVars) {
          console.log(
            `[GitLocalService] [${userId}] Skipping "${key}" (already exists in ${envFileName})`
          );
          skipped++;
        } else {
          mergedEnvVars[key] = value;
          added++;
          console.log(
            `[GitLocalService] [${userId}] Adding user secret "${key}" to ${envFileName}`
          );
        }
      }

      // Write the merged .env file
      await this.writeEnvFile(envFilePath, mergedEnvVars, userId);

      console.log(
        `[GitLocalService] [${userId}] ✓ Injected user secrets: ${added} added, ${skipped} skipped, ${Object.keys(userSecrets).length} total`
      );

      return {
        added,
        skipped,
        total: Object.keys(userSecrets).length,
      };
    } catch (error: any) {
      console.error(`[GitLocalService] [${userId}] Error injecting user secrets:`, error);
      throw new Error(`Failed to inject user secrets: ${error.message}`);
    }
  }

  /**
   * Create a new project with GitHub repo and optional boilerplate
   * @param folderName - Base name for the project folder
   * @param framework - Framework type (bun, empty, or null for custom)
   * @param userId - User identifier for workspace isolation
   * @param token - GitHub OAuth token
   * @returns Project details (owner, repoName, repoPath)
   */
  async createProject(
    folderName: string,
    framework: string | null,
    userId: string,
    token: string
  ): Promise<{ owner: string; repoName: string; repoPath: string }> {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const workspaceRoot = getUserWorkspaceDir(userId);
    // 30s request timeout so project creation can't hang on a GitHub outage.
    const userOctokit = new Octokit({ auth: token, request: { timeout: 30000 } });

    console.log(
      `[GitLocalService] [${userId}] Creating project: ${folderName} (framework: ${framework || 'none'})`
    );

    // Get GitHub username (owner)
    const { data: githubUser } = await userOctokit.rest.users.getAuthenticated();
    const repoOwner = githubUser.login;

    // Handle name collisions by incrementing number suffix
    const baseRepoName = folderName;
    let attemptNumber = 0;
    let finalRepoName = baseRepoName;
    let collisionFound = true;

    // Keep trying until we find an available name
    while (collisionFound && attemptNumber < 100) {
      // Check GitHub repo collision first (most important)
      try {
        await userOctokit.rest.repos.get({
          owner: repoOwner,
          repo: finalRepoName,
        });
        // Repo exists, try next number
        attemptNumber++;
        finalRepoName = `${baseRepoName}-${attemptNumber}`;
        console.log(
          `[GitLocalService] [${userId}] Repository ${repoOwner}/${baseRepoName} exists, trying ${finalRepoName}...`
        );
      } catch (error: any) {
        if (error.status === 404) {
          // Repo doesn't exist - check local folder
          const testPath = path.join(workspaceRoot, repoOwner, finalRepoName);
          try {
            await fs.access(testPath);
            // Local folder exists, try next number
            attemptNumber++;
            finalRepoName = `${baseRepoName}-${attemptNumber}`;
            console.log(
              `[GitLocalService] [${userId}] Local folder exists, trying ${finalRepoName}...`
            );
          } catch {
            // Neither repo nor folder exists - we found a unique name!
            collisionFound = false;
          }
        } else {
          // API error, break loop
          console.error(`[GitLocalService] [${userId}] Error checking repo:`, error.message);
          collisionFound = false;
        }
      }
    }

    if (attemptNumber >= 100) {
      throw new Error(`Could not find available name after 100 attempts for ${baseRepoName}`);
    }

    const repoName = finalRepoName;
    const repoPath = path.join(workspaceRoot, repoOwner, repoName);

    if (attemptNumber > 0) {
      console.log(`[GitLocalService] [${userId}] ✓ Found available name: ${repoName}`);
    }

    console.log(`[GitLocalService] [${userId}] New project: ${repoOwner}/${repoName}`);
    console.log(`[GitLocalService] [${userId}] Creating project folder: ${repoPath}`);

    // Create GitHub repository (always create empty private repo)
    const isBun = framework === 'bun';

    console.log(
      `[GitLocalService] [${userId}] Creating private GitHub repository: ${repoOwner}/${repoName}`
    );
    try {
      // Create the repo (we already checked it doesn't exist)
      await userOctokit.rest.repos.createForAuthenticatedUser({
        name: repoName,
        private: true,
        auto_init: false,
        description: `Project created by Portable`,
      });
      console.log(
        `[GitLocalService] [${userId}] ✓ Created private repository: https://github.com/${repoOwner}/${repoName}`
      );
    } catch (repoError: any) {
      console.error(
        `[GitLocalService] [${userId}] ✗ Failed to create GitHub repository:`,
        repoError.message
      );
      // Continue anyway - agent can still work locally
    }

    // For Bun, clone boilerplate to temp folder and copy files
    if (isBun) {
      const boilerplateName = 'Bun';
      const boilerplateRepo = 'https://github.com/yueranyuan/bun-boilerplate';

      console.log(`[GitLocalService] [${userId}] Setting up ${boilerplateName} boilerplate...`);
      try {
        // Create temp directory for cloning boilerplate
        const tempDir = path.join(workspaceRoot, '.temp', `boilerplate-${Date.now()}`);
        await fs.mkdir(tempDir, { recursive: true });

        console.log(
          `[GitLocalService] [${userId}] Cloning ${boilerplateName} boilerplate to temp: ${tempDir}`
        );

        // Clone boilerplate to temp directory (shallow clone)
        await execAsync(`git clone --depth 1 ${boilerplateRepo} "${tempDir}"`);

        console.log(`[GitLocalService] [${userId}] Copying boilerplate files to: ${repoPath}`);

        // Create project directory
        await fs.mkdir(repoPath, { recursive: true });

        // Copy all files except .git directory
        await execAsync(`cp -r "${tempDir}/." "${repoPath}/" && rm -rf "${repoPath}/.git"`);

        // Initialize fresh git in project directory
        await execAsync(`cd "${repoPath}" && git init`);
        await execAsync(
          `cd "${repoPath}" && git remote add origin https://github.com/${repoOwner}/${repoName}.git`
        );

        // Configure git credential helper to use runtime GITHUB_TOKEN environment variable
        await execFileAsync('git', [
          '-C',
          repoPath,
          'config',
          '--local',
          'credential.helper',
          '!f() { echo username=git; echo "password=$GITHUB_TOKEN"; }; f',
        ]);

        // Configure git author for commits
        const { data: user } = await userOctokit.users.getAuthenticated();
        await execFileAsync('git', ['-C', repoPath, 'config', '--local', 'user.name', user.login]);
        await execFileAsync('git', ['-C', repoPath, 'config', '--local', 'user.email', userId]);

        console.log(
          `[GitLocalService] [${userId}] ✓ ${boilerplateName} boilerplate set up with fresh git pointing to new repo`
        );

        // Clean up temp directory
        await fs.rm(tempDir, { recursive: true, force: true });

        // Install dependencies
        console.log(`[GitLocalService] [${userId}] Installing dependencies with bun install...`);
        await execAsync(`cd "${repoPath}" && bun install`);
        console.log(`[GitLocalService] [${userId}] ✓ Dependencies installed`);

        // Initial commit and push (with GITHUB_TOKEN in environment)
        console.log(`[GitLocalService] [${userId}] Creating initial commit...`);
        await execAsync(`cd "${repoPath}" && git add .`);
        await execAsync(
          `cd "${repoPath}" && git commit -m "Initial commit: ${boilerplateName} boilerplate"`
        );

        console.log(`[GitLocalService] [${userId}] Pushing to GitHub...`);
        // Push with GITHUB_TOKEN in environment (credential helper will use it)
        await execAsync(
          `cd "${repoPath}" && GITHUB_TOKEN=${token} git push -u origin main || GITHUB_TOKEN=${token} git push -u origin master`
        );

        console.log(
          `[GitLocalService] [${userId}] ✓ Boilerplate fully set up and pushed to GitHub`
        );
      } catch (boilerplateError: any) {
        console.error(
          `[GitLocalService] [${userId}] ✗ Failed to set up ${boilerplateName} boilerplate:`,
          boilerplateError.message
        );
        // Fall back to empty folder
        await fs.mkdir(repoPath, { recursive: true });
      }
    } else {
      // For other frameworks, create folder with basic setup
      await fs.mkdir(repoPath, { recursive: true });

      // For "empty" or "none" framework, set up basic project structure
      const isEmptyProject = framework === 'empty' || framework === 'none';
      if (isEmptyProject) {
        console.log(`[GitLocalService] [${userId}] Setting up empty project with static server...`);

        // Create public directory
        await fs.mkdir(path.join(repoPath, 'public'), { recursive: true });

        // Create package.json with serve script
        const packageJson = {
          name: repoName,
          version: '1.0.0',
          description: 'Empty project created by Portable',
          scripts: {
            serve: 'npx serve public',
          },
          private: true,
        };

        await fs.writeFile(
          path.join(repoPath, 'package.json'),
          JSON.stringify(packageJson, null, 2)
        );

        // Create README.md
        const readme = `# ${repoName}

Empty project with static file server.

## Development

Run \`npm run serve\` to start a local server on http://localhost:3000

Add your files to the \`public/\` directory.
`;

        await fs.writeFile(path.join(repoPath, 'README.md'), readme);

        // Create .gitignore
        const gitignore = `# Environment variables
.env*
!.env.example

# Dependencies
node_modules/

# OS files
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp
*.swo
`;

        await fs.writeFile(path.join(repoPath, '.gitignore'), gitignore);

        // Initialize git
        await execAsync(`cd "${repoPath}" && git init`);
        await execAsync(
          `cd "${repoPath}" && git remote add origin https://github.com/${repoOwner}/${repoName}.git`
        );

        // Configure git credential helper to use runtime GITHUB_TOKEN environment variable
        await execFileAsync('git', [
          '-C',
          repoPath,
          'config',
          '--local',
          'credential.helper',
          '!f() { echo username=git; echo "password=$GITHUB_TOKEN"; }; f',
        ]);

        // Configure git author
        const { data: user } = await userOctokit.users.getAuthenticated();
        await execFileAsync('git', ['-C', repoPath, 'config', '--local', 'user.name', user.login]);
        await execFileAsync('git', ['-C', repoPath, 'config', '--local', 'user.email', userId]);

        // Initial commit and push
        console.log(`[GitLocalService] [${userId}] Creating initial commit for empty project...`);
        await execAsync(`cd "${repoPath}" && git add .`);
        await execAsync(
          `cd "${repoPath}" && git commit -m "Initial commit: Empty project with static server"`
        );

        console.log(`[GitLocalService] [${userId}] Pushing to GitHub...`);
        await execAsync(
          `cd "${repoPath}" && GITHUB_TOKEN=${token} git push -u origin main || GITHUB_TOKEN=${token} git push -u origin master`
        );

        console.log(
          `[GitLocalService] [${userId}] ✓ Empty project fully set up and pushed to GitHub`
        );
      } else {
        // For non-empty frameworks, still need to initialize git
        console.log(`[GitLocalService] [${userId}] Setting up git for custom framework project...`);

        // Initialize git
        await execAsync(`cd "${repoPath}" && git init`);
        await execAsync(
          `cd "${repoPath}" && git remote add origin https://github.com/${repoOwner}/${repoName}.git`
        );

        // Configure git credential helper to use runtime GITHUB_TOKEN environment variable
        await execFileAsync('git', [
          '-C',
          repoPath,
          'config',
          '--local',
          'credential.helper',
          '!f() { echo username=git; echo "password=$GITHUB_TOKEN"; }; f',
        ]);

        // Configure git author
        const { data: user } = await userOctokit.users.getAuthenticated();
        await execFileAsync('git', ['-C', repoPath, 'config', '--local', 'user.name', user.login]);
        await execFileAsync('git', ['-C', repoPath, 'config', '--local', 'user.email', userId]);

        console.log(`[GitLocalService] [${userId}] ✓ Git initialized for custom framework project`);
      }
    }

    // Invalidate repos cache
    if (this.reposCache) {
      console.log(`[GitLocalService] [${userId}] Invalidating repos cache after project creation`);
      this.reposCache.invalidateUser(userId);
    }

    console.log(
      `[GitLocalService] [${userId}] ✓ Project creation complete: ${repoOwner}/${repoName}`
    );

    return {
      owner: repoOwner,
      repoName,
      repoPath, // Return the actual path constructed on line 921
    };
  }

  /**
   * Check if a file existed in git history and get deletion info
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param filePath - Path to the file relative to repo root
   * @param userId - User identifier for workspace isolation
   * @returns File history information or null if never existed
   */
  async getFileHistory(
    owner: string,
    repo: string,
    filePath: string,
    userId: string
  ): Promise<{
    existed: boolean;
    lastCommit?: {
      sha: string;
      message: string;
      author: string;
      date: string;
      content?: string; // Content from last commit
    };
    deletedInCurrentChangeset?: boolean;
  } | null> {
    const userWorkspace = getUserWorkspaceDir(userId);
    const repoPath = path.join(userWorkspace, owner, repo);

    try {
      // Check if repository is cloned locally
      await fs.access(path.join(repoPath, '.git'));
    } catch {
      console.log(`[GitLocalService] [${userId}] Repository not cloned locally: ${owner}/${repo}`);
      return null;
    }

    try {
      // First check if file exists in working directory or staging area
      let deletedInCurrentChangeset = false;
      try {
        const { stdout: statusOutput } = await execFileAsync(
          'git',
          ['status', '--porcelain', filePath],
          {
            cwd: repoPath,
          }
        );
        // Check if file was deleted in current changes (status starts with 'D ')
        if (statusOutput.trim().startsWith('D ')) {
          deletedInCurrentChangeset = true;
        }
      } catch {
        // Ignore errors from git status
      }

      // Get the last commit where this file existed
      const { stdout: logOutput } = await execFileAsync(
        'git',
        [
          'log',
          '-1', // Only last commit
          '--format=%H|%s|%an|%aI', // SHA|Subject|Author|Date
          '--', // Separator for paths
          filePath,
        ],
        { cwd: repoPath }
      );

      if (!logOutput.trim()) {
        // File never existed in git history
        return { existed: false };
      }

      // Parse the log output
      const [sha, message, author, date] = logOutput.trim().split('|');

      // Try to get the file content from the last commit where it existed
      let content: string | undefined;
      try {
        const { stdout: fileContent } = await execFileAsync('git', ['show', `${sha}:${filePath}`], {
          cwd: repoPath,
        });
        content = fileContent;
      } catch (err) {
        console.warn(
          `[GitLocalService] [${userId}] Could not retrieve file content from commit ${sha}`
        );
      }

      return {
        existed: true,
        lastCommit: {
          sha: sha.substring(0, 7), // Short SHA
          message,
          author,
          date,
          content,
        },
        deletedInCurrentChangeset,
      };
    } catch (error: any) {
      console.error(
        `[GitLocalService] [${userId}] Error getting file history for ${filePath}:`,
        error
      );
      return null;
    }
  }

  /**
   * Create a local folder with git init (no GitHub repo) for simple tasks
   * @param folderName - Name for the folder
   * @param userId - User identifier for workspace isolation
   * @returns Folder details (folderPath, owner, repoName)
   */
  async createLocalFolder(
    folderName: string,
    userId: string
  ): Promise<{ folderPath: string; owner: string; repoName: string; repoPath: string }> {
    const { promises: fs } = await import('fs');
    const path = await import('path');
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // Use user workspace directory with "local" subdirectory for consistency
    const workspaceRoot = getUserWorkspaceDir(userId);
    const localRoot = path.join(workspaceRoot, 'local');

    console.log(`[GitLocalService] [${userId}] Creating local folder with git: ${folderName}`);

    // Ensure local directory exists
    await fs.mkdir(localRoot, { recursive: true });

    // Create unique folder name to avoid collisions
    const baseFolderName = folderName;
    let attemptNumber = 0;
    let finalFolderName = baseFolderName;
    let folderPath = path.join(localRoot, finalFolderName);

    // Find available folder name
    while (
      await fs
        .access(folderPath)
        .then(() => true)
        .catch(() => false)
    ) {
      attemptNumber++;
      finalFolderName = `${baseFolderName}-${attemptNumber}`;
      folderPath = path.join(localRoot, finalFolderName);
    }

    // Create the folder
    await fs.mkdir(folderPath, { recursive: true });

    // Initialize git repository
    await execAsync(`cd "${folderPath}" && git init`);
    console.log(`[GitLocalService] [${userId}] ✓ Git initialized`);

    // Configure git author for commits (extract username from email)
    const username = userId.split('@')[0] || 'local-user';
    await execAsync(`cd "${folderPath}" && git config user.name "${username}"`);
    await execAsync(`cd "${folderPath}" && git config user.email "${userId}"`);
    console.log(`[GitLocalService] [${userId}] ✓ Git user configured: ${username} <${userId}>`);

    // Create a simple README
    const readme = `# ${finalFolderName}

This folder was created for: ${folderName}

Created: ${new Date().toISOString()}
`;

    await fs.writeFile(path.join(folderPath, 'README.md'), readme);

    // Create initial commit
    await execAsync(`cd "${folderPath}" && git add .`);
    await execAsync(`cd "${folderPath}" && git commit -m "Initial commit"`);
    console.log(`[GitLocalService] [${userId}] ✓ Initial commit created`);

    console.log(`[GitLocalService] [${userId}] ✓ Local folder created with git: ${folderPath}`);

    return {
      folderPath,
      owner: 'local', // Use 'local' as owner for local repos to avoid path duplication
      repoName: finalFolderName,
      repoPath: folderPath, // Explicitly return the full path
    };
  }

  /**
   * Update git credentials file with GitHub token
   * This allows git operations to use the updated token from JWT
   * Only works in remote sandboxes (production mode)
   *
   * @param githubToken - GitHub OAuth token from JWT
   * @returns Success status
   */
  async updateGitCredentials(githubToken: string): Promise<{ success: boolean; message: string }> {
    // Validate GitHub token is provided
    if (!githubToken || githubToken.trim() === '') {
      // console.log('[GitLocalService] updateGitCredentials: No GitHub token provided');
      return {
        success: false,
        message: 'No GitHub token provided',
      };
    }

    // Local-first: git auth is the user's OWN on-device token
    // (LocalGitHubAuthService), consumed by gh CLI / Octokit — there is no
    // remote ~/.git-credentials / shell-profile writer to run. (The body
    // here only ever executed in sandbox mode, which no longer exists.)
    return {
      success: false,
      message: 'Not applicable in local-first mode (git auth via LocalGitHubAuthService)',
    };
  }
}
