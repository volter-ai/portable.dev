import fs from 'fs';

import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';
import { resolveRepoLocalPath } from '../../services/GitHubApiService/utils/repoPathResolver.js';
import {
  EmptyCommitMessageError,
  EmptyPathsError,
  InvalidBranchError,
  InvalidShaError,
  MergeConflictsError,
  NotAGitRepoError,
  NothingStagedError,
  PathTraversalError,
} from '../../services/SourceControlService.js';
import { getAuthToken } from '../utils/route-helpers.js';

import type { AuthService } from '../../services/AuthService.js';
import type { GitLocalService } from '../../services/GitLocalService.js';
import type { SourceControlService } from '../../services/SourceControlService.js';
import type {
  CommitResponse,
  GetCommitDetailResponse,
  GetCommitGraphResponse,
  GetFileDiffResponse,
  GetWorkingTreeChangesResponse,
  GetWorktreesResponse,
  PullResponse,
  PushResponse,
  StageResponse,
} from '@vgit2/shared/types';
import type { Request, Response } from 'express';

/**
 * Parse + validate a stage/unstage request body's `paths` (US-013): a non-empty
 * array of non-empty strings. Returns `null` for any other shape so the route
 * can answer a deterministic 400.
 */
function parsePaths(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null;
  const { paths } = body as { paths?: unknown };
  if (!Array.isArray(paths) || paths.length === 0) return null;
  if (!paths.every((p) => typeof p === 'string' && p.length > 0)) return null;
  return paths as string[];
}

/**
 * Source Control routes (portable.dev#17) — isolated factory mounted at
 * /api/source-control. Provides the mobile Source Control + Worktrees tabs with
 * git read/write parity against the repo's local clone under the workspace dir.
 *
 * Intentionally a sibling of the existing api.routes.ts mount (NOT wired into
 * it) so the existing git service/routes stay untouched. Endpoint handlers are
 * filled in incrementally across US-004..US-016; the requireAuth +
 * repoPath-resolution + typed-response conventions mirror repository.routes.ts.
 */
export function createSourceControlRoutes(
  sourceControlService: SourceControlService,
  authService?: AuthService,
  gitLocalService?: GitLocalService
): Router {
  const router = Router();

  /**
   * Resolve the local clone path for an owner/repo from the authenticated user's
   * workspace (flat-clone aware via resolveRepoLocalPath — a `portable link`'d
   * dir whose remote is owner/repo resolves too, not only the canonical
   * `<workspace>/<owner>/<repo>` layout), returning 404 when the repo has not
   * been cloned locally (the resolver still returns the canonical fallback path
   * for an uncloned repo, so the existsSync guard is load-bearing).
   *
   * Returns `null` (after sending the response) when the repo is missing so the
   * caller can early-return. requireAuth guarantees `req.session.userEmail`.
   */
  async function resolveRepoPath(req: Request, res: Response): Promise<string | null> {
    const userEmail = req.session.userEmail!;
    const { owner, repo } = req.params;
    const repoPath = await resolveRepoLocalPath(
      gitLocalService,
      userEmail,
      owner as string,
      repo as string
    );

    if (!fs.existsSync(repoPath)) {
      res.status(404).json({ error: 'Repository not cloned locally' });
      return null;
    }
    return repoPath;
  }

  /**
   * GET /:owner/:repo/graph?all=1&limit=200&cursor=<offset>
   * The commit DAG for the graph view (US-004). `all` defaults to 1 (every ref);
   * pass `all=0` for HEAD's history only. Returns GetCommitGraphResponse with an
   * offset-based `nextCursor` when more history exists. A resource-limit
   * degradation surfaces as `{ nodes: [], degraded: true }` (still 200);
   * a genuine git failure → 500.
   */
  router.get('/:owner/:repo/graph', requireAuth, async (req, res) => {
    const repoPath = await resolveRepoPath(req, res);
    if (!repoPath) return;

    const all = req.query.all !== '0' && req.query.all !== 'false';
    const limitRaw = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

    try {
      const response: GetCommitGraphResponse = await sourceControlService.getCommitGraph(repoPath, {
        all,
        limit,
        cursor,
      });
      res.json(response);
    } catch (error) {
      console.error('[SourceControl] getCommitGraph failed:', error);
      res.status(500).json({ error: 'Failed to read commit graph' });
    }
  });

  /**
   * GET /:owner/:repo/status?worktree=<absPath>
   * The working-tree changes (US-005) grouped into Conflicts / Staged /
   * Unstaged / Untracked, plus the branch name and ahead/behind counters.
   * The optional `worktree` param (US-007) scopes the read to a linked git
   * worktree (a path inside the main checkout); omitted = the main checkout.
   * Returns GetWorkingTreeChangesResponse; a worktree escaping the repo → 400;
   * a genuine git failure → 500.
   */
  router.get('/:owner/:repo/status', requireAuth, async (req, res) => {
    const repoPath = await resolveRepoPath(req, res);
    if (!repoPath) return;

    const worktree = typeof req.query.worktree === 'string' ? req.query.worktree : undefined;

    try {
      const response: GetWorkingTreeChangesResponse =
        await sourceControlService.getWorkingTreeChanges(repoPath, { worktree });
      res.json(response);
    } catch (error) {
      if (error instanceof PathTraversalError) {
        res.status(400).json({ error: 'Invalid worktree path' });
        return;
      }
      console.error('[SourceControl] getWorkingTreeChanges failed:', error);
      res.status(500).json({ error: 'Failed to read working tree changes' });
    }
  });

  /**
   * GET /:owner/:repo/file-diff?path=<p>&staged=0|1&worktree=<absPath>
   * The unified diff for a single file (US-006). `staged=1` diffs the index
   * against HEAD; otherwise the worktree against the index. The optional
   * `worktree` param (US-007) scopes the diff to a linked git worktree (a path
   * inside the main checkout); `path` is then relative to that worktree. A path
   * (or worktree) escaping the repo → 400; a genuine git failure → 500.
   */
  router.get('/:owner/:repo/file-diff', requireAuth, async (req, res) => {
    const repoPath = await resolveRepoPath(req, res);
    if (!repoPath) return;

    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!filePath) {
      res.status(400).json({ error: 'Missing required query param: path' });
      return;
    }
    const staged = req.query.staged === '1' || req.query.staged === 'true';
    const worktree = typeof req.query.worktree === 'string' ? req.query.worktree : undefined;

    try {
      const response: GetFileDiffResponse = await sourceControlService.getFileDiff(
        repoPath,
        filePath,
        { staged, worktree }
      );
      res.json(response);
    } catch (error) {
      if (error instanceof PathTraversalError) {
        res.status(400).json({ error: 'Invalid path' });
        return;
      }
      console.error('[SourceControl] getFileDiff failed:', error);
      res.status(500).json({ error: 'Failed to read file diff' });
    }
  });

  /**
   * GET /:owner/:repo/commit/:sha
   * The changed files, unified diff, and stats for a single commit (US-006).
   * A non-hex sha → 400; a genuine git failure → 500.
   */
  router.get('/:owner/:repo/commit/:sha', requireAuth, async (req, res) => {
    const repoPath = await resolveRepoPath(req, res);
    if (!repoPath) return;

    const sha = req.params.sha as string;

    try {
      const response: GetCommitDetailResponse = await sourceControlService.getCommitDetail(
        repoPath,
        sha
      );
      res.json(response);
    } catch (error) {
      if (error instanceof InvalidShaError) {
        res.status(400).json({ error: 'Invalid commit sha' });
        return;
      }
      console.error('[SourceControl] getCommitDetail failed:', error);
      res.status(500).json({ error: 'Failed to read commit detail' });
    }
  });

  /**
   * GET /:owner/:repo/worktrees
   * The repo's git worktrees (US-007, READ-ONLY). Returns GetWorktreesResponse;
   * a normal single-clone repo returns exactly one (main) worktree. A genuine
   * git failure → 500.
   */
  router.get('/:owner/:repo/worktrees', requireAuth, async (req, res) => {
    const repoPath = await resolveRepoPath(req, res);
    if (!repoPath) return;

    try {
      const response: GetWorktreesResponse = await sourceControlService.listWorktrees(repoPath);
      res.json(response);
    } catch (error) {
      console.error('[SourceControl] listWorktrees failed:', error);
      res.status(500).json({ error: 'Failed to read worktrees' });
    }
  });

  /**
   * POST /:owner/:repo/stage   body { paths: string[], worktree?: string }
   * Stage the given repo-relative paths (US-013) — `git add`. The optional
   * `worktree` scopes the op to a linked git worktree (a path inside the main
   * checkout). Returns StageResponse. An empty/invalid `paths` or a path/worktree
   * escaping the repo → 400; a genuine git failure → 500.
   */
  router.post('/:owner/:repo/stage', requireAuth, async (req, res) => {
    await handleStageMutation(req, res, (repoPath, paths, worktree) =>
      sourceControlService.stage(repoPath, paths, { worktree })
    );
  });

  /**
   * POST /:owner/:repo/unstage   body { paths: string[], worktree?: string }
   * Unstage the given repo-relative paths (US-013) — `git restore --staged`.
   * Same body + error contract as /stage.
   */
  router.post('/:owner/:repo/unstage', requireAuth, async (req, res) => {
    await handleStageMutation(req, res, (repoPath, paths, worktree) =>
      sourceControlService.unstage(repoPath, paths, { worktree })
    );
  });

  /**
   * POST /:owner/:repo/discard   body { paths: string[], worktree?: string }
   * Discard the given repo-relative paths (US-014, DESTRUCTIVE) — `git restore`
   * for tracked files, `git clean -fd` for untracked ones. Same body + error
   * contract as /stage. The confirmation guard lives in the mobile client.
   */
  router.post('/:owner/:repo/discard', requireAuth, async (req, res) => {
    await handleStageMutation(req, res, (repoPath, paths, worktree) =>
      sourceControlService.discard(repoPath, paths, { worktree })
    );
  });

  /**
   * POST /:owner/:repo/commit   body { message: string }
   * Commit the staged changes (US-015), authored as the user's GitHub login
   * (resolved server-side via the connections service; fallback = JWT username).
   * Returns CommitResponse { sha, branch?, author? }. An empty message or nothing
   * staged → 400; a non-git repo → 400; a genuine git failure → 500.
   */
  router.post('/:owner/:repo/commit', requireAuth, async (req, res) => {
    const repoPath = await resolveRepoPath(req, res);
    if (!repoPath) return;

    const message =
      typeof (req.body as { message?: unknown }).message === 'string'
        ? (req.body as { message: string }).message
        : '';

    try {
      const response: CommitResponse = await sourceControlService.commit(repoPath, message, {
        userId: req.session.userEmail!,
        authToken: getAuthToken(req),
        // The PC-minted JWT carries the username; session.username is the
        // OAuth-session fallback (mirrors health.routes.ts).
        jwtUsername: req.jwtUser?.username ?? req.session?.username,
      });
      res.json(response);
    } catch (error) {
      if (
        error instanceof EmptyCommitMessageError ||
        error instanceof NothingStagedError ||
        error instanceof NotAGitRepoError
      ) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error('[SourceControl] commit failed:', error);
      res.status(500).json({ error: 'Failed to commit' });
    }
  });

  /**
   * POST /:owner/:repo/push   body { branch?: string, setUpstream?: boolean, worktree?: string }
   * Push the local branch to its remote (US-016), authenticating as the user's
   * GitHub identity. Resolves the GitHub token via authService (no connection →
   * 401 'connect GitHub'), then pushes — the token is passed to git via env only
   * (read by the service's one-shot inline credential helper), never logged or
   * embedded in the URL. The optional `worktree` scopes the push to a linked git
   * worktree. A tree with unresolved merge conflicts → 409; an invalid
   * branch/worktree → 400. Returns PushResponse with the updated ahead/behind.
   */
  router.post('/:owner/:repo/push', requireAuth, async (req, res) => {
    const repoPath = await resolveRepoPath(req, res);
    if (!repoPath) return;

    const token = await resolveGitHubToken(req, res);
    if (!token) return;

    const body = req.body as { branch?: unknown; setUpstream?: unknown; worktree?: unknown };
    const branch = typeof body.branch === 'string' && body.branch ? body.branch : undefined;
    const setUpstream = body.setUpstream === true;
    const worktree = typeof body.worktree === 'string' && body.worktree ? body.worktree : undefined;

    try {
      const response: PushResponse = await sourceControlService.push(
        repoPath,
        { branch, setUpstream, worktree },
        token
      );
      res.json(response);
    } catch (error) {
      if (error instanceof InvalidBranchError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof PathTraversalError) {
        res.status(400).json({ error: 'Invalid worktree path' });
        return;
      }
      if (error instanceof MergeConflictsError) {
        res.status(409).json({ error: error.message });
        return;
      }
      console.error('[SourceControl] push failed:', error);
      res.status(500).json({ error: 'Failed to push' });
    }
  });

  /**
   * POST /:owner/:repo/pull   body { worktree?: string }
   * Pull (fetch + merge) the current branch from its remote (US-016),
   * authenticating as the user's GitHub identity. Same token resolution + 401
   * contract as /push; the optional `worktree` scopes the pull to a linked git
   * worktree (invalid → 400). A pull stopped by merge conflicts is a NORMAL 200
   * with `{ pulled: false, conflicts: true }` — the client blocks Push until the
   * tree is resolved. Returns PullResponse with the updated ahead/behind.
   */
  router.post('/:owner/:repo/pull', requireAuth, async (req, res) => {
    const repoPath = await resolveRepoPath(req, res);
    if (!repoPath) return;

    const token = await resolveGitHubToken(req, res);
    if (!token) return;

    const body = req.body as { worktree?: unknown };
    const worktree = typeof body.worktree === 'string' && body.worktree ? body.worktree : undefined;

    try {
      const response: PullResponse = await sourceControlService.pull(repoPath, token, {
        worktree,
      });
      res.json(response);
    } catch (error) {
      if (error instanceof PathTraversalError) {
        res.status(400).json({ error: 'Invalid worktree path' });
        return;
      }
      console.error('[SourceControl] pull failed:', error);
      res.status(500).json({ error: 'Failed to pull' });
    }
  });

  /**
   * Resolve the user's GitHub token for a push/pull (US-016). Returns the token,
   * or `null` after sending a deterministic response: 401 when no GitHub
   * connection exists (INSUFFICIENT_GITHUB_PERMISSIONS), 500 when the auth
   * service is unavailable or the lookup fails for another reason. The token is
   * handed to the service, which passes it to git via env + a one-shot inline
   * credential helper — no ambient credential store is ever written.
   */
  async function resolveGitHubToken(req: Request, res: Response): Promise<string | null> {
    if (!authService) {
      res.status(500).json({ error: 'Auth service unavailable' });
      return null;
    }

    let token: string;
    try {
      token = await authService.getGitHubToken(req);
    } catch (error) {
      if ((error as { code?: string }).code === 'INSUFFICIENT_GITHUB_PERMISSIONS') {
        res
          .status(401)
          .json({ error: 'GitHub connection required. Please connect your GitHub account.' });
        return null;
      }
      console.error('[SourceControl] Failed to get GitHub token:', error);
      res.status(500).json({ error: 'Failed to get GitHub token' });
      return null;
    }

    return token;
  }

  /**
   * Shared stage/unstage/discard handler: resolve the repo path, validate the
   * body, thread the optional worktree scope, and map service errors to
   * deterministic statuses (empty/invalid paths or path-traversal → 400; git
   * failure → 500).
   */
  async function handleStageMutation(
    req: Request,
    res: Response,
    run: (repoPath: string, paths: string[], worktree?: string) => Promise<StageResponse>
  ): Promise<void> {
    const repoPath = await resolveRepoPath(req, res);
    if (!repoPath) return;

    const paths = parsePaths(req.body);
    if (!paths) {
      res.status(400).json({ error: 'Missing or invalid required body field: paths' });
      return;
    }
    const worktree =
      typeof (req.body as { worktree?: unknown }).worktree === 'string'
        ? (req.body as { worktree: string }).worktree
        : undefined;

    try {
      const response: StageResponse = await run(repoPath, paths, worktree);
      res.json(response);
    } catch (error) {
      if (error instanceof EmptyPathsError) {
        res.status(400).json({ error: 'No paths supplied' });
        return;
      }
      if (error instanceof PathTraversalError) {
        res.status(400).json({ error: 'Invalid path' });
        return;
      }
      console.error('[SourceControl] stage/unstage failed:', error);
      res.status(500).json({ error: 'Failed to update staging area' });
    }
  }

  return router;
}
