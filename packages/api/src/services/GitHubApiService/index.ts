import { promises as fs } from 'fs';
import path from 'path';

import { Octokit } from '@octokit/rest';
import { Request, Response } from 'express';

import { ConnectionsService } from '../ConnectionsService.js';
import { ReposCacheService } from '../ReposCacheService.js';
import { RepoViewTrackerService } from '../RepoViewTrackerService.js';
import { GitHubConnectionError } from './GitHubConnectionError.js';
import { ActionHandler } from './handlers/ActionHandler.js';
import { BranchHandler } from './handlers/BranchHandler.js';
import { ContentHandler } from './handlers/ContentHandler.js';
import { IssueHandler } from './handlers/IssueHandler.js';
import { PullRequestHandler } from './handlers/PullRequestHandler.js';
import { RepoHandler } from './handlers/RepoHandler.js';
import { UserHandler } from './handlers/UserHandler.js';
import { TokenCacheEntry, HandlerDependencies, CacheEntry } from './types.js';
import { handleGitHubApiError } from './utils/GitHubUtils.js';
import {
  getCurrentBranch,
  getRemoteBranch,
  getAheadBehind,
  getUnpushedCommits,
  getGitStatus,
} from './utils/GitLocalUtils.js';
import { LOCAL_PLACEHOLDER_OWNER, makeLocalRepoStub } from './utils/localRepoStub.js';
import { createUserOctokit } from './utils/octokitFactory.js';
import { resolveRepoLocalPath } from './utils/repoPathResolver.js';

import type { RescanReposResponse } from '@vgit2/shared/types';

// Import all handlers

/**
 * GitHubApiService handles all GitHub API endpoint operations
 *
 * Token Management (On-Demand Loading):
 * - GitHub tokens stored in the connections table (single source of truth)
 * - In-memory cache populated on-demand when API requests arrive
 * - Tokens loaded via explicit loadTokenForUser() calls
 */
export class GitHubApiService {
  private reposCache: ReposCacheService;
  private repoViewTracker: RepoViewTrackerService | null;
  private chatService: any | null;
  private connectionsService: ConnectionsService;

  // Git status cache (reduces I/O on remote volumes)
  private gitStatusCache: Map<string, CacheEntry<any>> = new Map();
  private GIT_STATUS_CACHE_TTL = 30 * 1000; // 30 seconds cache TTL

  // GitHub token cache (per-user, reactive)
  private tokenCache: Map<string, TokenCacheEntry> = new Map();

  // Handlers (using delegation pattern)
  private repoHandler: RepoHandler;
  private contentHandler: ContentHandler;
  private issueHandler: IssueHandler;
  private pullRequestHandler: PullRequestHandler;
  private actionHandler: ActionHandler;
  private branchHandler: BranchHandler;
  private userHandler: UserHandler;

  constructor(
    reposCache: ReposCacheService,
    connectionsService: ConnectionsService,
    repoViewTracker?: RepoViewTrackerService,
    chatService?: any
  ) {
    this.reposCache = reposCache;
    this.connectionsService = connectionsService;
    this.repoViewTracker = repoViewTracker || null;
    this.chatService = chatService || null;

    // Create shared dependencies object for handlers
    const handlerDeps: HandlerDependencies = {
      getUserOctokit: this.getUserOctokit.bind(this),
      getOctokitForUser: this.getOctokitForUser.bind(this),
      getCachedToken: this.getCachedToken.bind(this),
      getGitHubConnectionType: this.getGitHubConnectionType.bind(this),
      handleGitHubApiError: handleGitHubApiError,
    };

    // Initialize handlers with dependency injection
    this.repoHandler = new RepoHandler(
      this.reposCache,
      this.repoViewTracker,
      this.chatService,
      handlerDeps
    );
    this.contentHandler = new ContentHandler(handlerDeps);
    this.issueHandler = new IssueHandler(handlerDeps);
    this.pullRequestHandler = new PullRequestHandler(handlerDeps);
    this.actionHandler = new ActionHandler(handlerDeps);
    this.branchHandler = new BranchHandler(handlerDeps);
    this.userHandler = new UserHandler(handlerDeps, this.chatService);

    // Listen for connection updates to reload tokens reactively
    this.connectionsService.on('connection:updated', ({ userId, service }) => {
      if (service === 'github' || service === 'github-app') {
        console.log(`[GitHubApiService] Connection updated for ${userId}, reloading token...`);
        this.loadTokenForUser(userId).catch((err) => {
          console.error(`[GitHubApiService] Failed to reload token for ${userId}:`, err);
        });
      }
    });

    this.connectionsService.on('connection:deleted', ({ userId, service }) => {
      if (service === 'github' || service === 'github-app') {
        console.log(`[GitHubApiService] Connection deleted for ${userId}, clearing token cache...`);
        this.tokenCache.delete(userId);
      }
    });
  }

  /**
   * Initialize token cache - call this at server startup
   */
  async initialize(userIds: string[]): Promise<void> {
    for (const userId of userIds) {
      await this.loadTokenForUser(userId);
    }
  }

  /**
   * Load GitHub token for a specific user from ConnectionsService
   */
  async loadTokenForUser(userId: string, authToken?: string): Promise<void> {
    try {
      // console.log(
      //   `[GitHubApiService] Loading token for user ${userId}, authToken: ${authToken ? 'present' : 'missing'}`
      // );
      const connection = await this.connectionsService.getActiveGitHubConnection(userId, authToken);
      console.log(`[GitHubApiService] getActiveGitHubConnection result:`, {
        type: connection?.type,
        hasToken: !!connection?.token,
        connectionId: connection?.connection?.connectionId,
      });
      if (connection?.token && (connection.type === 'oauth' || connection.type === 'app')) {
        const expiresAtMs = connection.expiresAt
          ? new Date(connection.expiresAt).getTime()
          : undefined;
        this.tokenCache.set(userId, {
          token: connection.token,
          type: connection.type,
          expiresAt:
            expiresAtMs !== undefined && !Number.isNaN(expiresAtMs) ? expiresAtMs : undefined,
          // Shared instance: 401s invalidate both cache layers, refetch, and
          // replay once with the fresh token (see octokitFactory).
          octokit: createUserOctokit(connection.token, {
            refreshToken: () => this.refreshTokenAfter401(userId, authToken),
          }),
        });
        // console.log(`[GitHubApiService] ✓ Token cached for user ${userId}`);
      } else {
        console.log(
          `[GitHubApiService] ✗ No valid token found for user ${userId} (type: ${connection?.type})`
        );
        this.tokenCache.delete(userId);
      }
    } catch (error) {
      console.error(`[GitHubApiService] Failed to load token for user ${userId}:`, error);
      this.tokenCache.delete(userId);
    }
  }

  /**
   * refreshToken callback for the per-user Octokit: a 401 means the cached
   * token is stale/revoked, so invalidate both cache layers and refetch.
   */
  private async refreshTokenAfter401(
    userId: string,
    authToken?: string
  ): Promise<string | undefined> {
    this.clearTokenCache(userId);
    await this.loadTokenForUser(userId, authToken);
    return this.tokenCache.get(userId)?.token;
  }

  /**
   * Whether a cache entry can still be used (token present and not within
   * 60s of its expiry).
   */
  private isEntryValid(entry: TokenCacheEntry | undefined): entry is TokenCacheEntry {
    if (!entry?.token) {
      return false;
    }
    return entry.expiresAt === undefined || entry.expiresAt - Date.now() > 60 * 1000;
  }

  /**
   * Get cached GitHub token for a user (synchronous)
   */
  public getCachedToken(userId: string): string | undefined {
    const cached = this.tokenCache.get(userId);
    return this.isEntryValid(cached) ? cached.token : undefined;
  }

  /**
   * Clear cached GitHub token for a user (e.g., after detecting a 401).
   * Also drops the ConnectionsService memo so the next load is a real fetch.
   */
  public clearTokenCache(userId: string): void {
    this.tokenCache.delete(userId);
    this.connectionsService.invalidateActiveGitHubConnection(userId);
    console.log(`[GitHubApiService] Cleared token cache for user ${userId}`);
  }

  /**
   * Get user's Octokit instance - SYNCHRONOUS!
   */
  private getUserOctokit(userId: string): Octokit {
    const cached = this.tokenCache.get(userId);

    if (!this.isEntryValid(cached)) {
      throw new GitHubConnectionError(
        `GitHub token not found in cache for user "${userId}". Please link your GitHub account.`
      );
    }

    return cached.octokit;
  }

  /**
   * Get user's Octokit instance, cache-first: a valid cached entry is
   * returned without re-running the ConnectionsService lookup.
   */
  async getOctokitForUser(userId: string, authToken?: string): Promise<Octokit> {
    const cached = this.tokenCache.get(userId);
    if (this.isEntryValid(cached)) {
      return cached.octokit;
    }
    await this.loadTokenForUser(userId, authToken);
    return this.getUserOctokit(userId);
  }

  /**
   * Get the GitHub connection type for a user (app or oauth)
   */
  private getGitHubConnectionType(userId: string): 'app' | 'oauth' | undefined {
    const cached = this.tokenCache.get(userId);
    return cached?.type;
  }

  // ============================================================================
  // Repository Methods - Delegated to RepoHandler
  // ============================================================================

  async handleListRepos(req: Request, res: Response): Promise<void> {
    return this.repoHandler.handleListRepos(req, res);
  }

  async handleListReposCached(req: Request, res: Response): Promise<void> {
    const userId = req.session.userEmail!;
    const authToken = req.session.authToken;
    const page = parseInt((req.query?.page as string) || '1');
    const per_page = parseInt((req.query?.per_page as string) || '20');
    const search = req.query?.search as string;
    const language = req.query?.language as string;
    const sort = (req.query?.sort as string) || 'updated';
    const skipGitOperations = req.query?.skipGitOperations === 'true';
    // Workspace-only listing (Home + Repos tab) — no GitHub fetch.
    const localOnly = req.query?.localOnly === 'true';
    const blockedOrgs = req.query?.blockedOrgs
      ? (JSON.parse(req.query.blockedOrgs as string) as string[])
      : undefined;

    const cacheKey = {
      userId,
      page,
      per_page,
      search,
      language,
      sort,
      blockedOrgs: blockedOrgs?.sort().join(','),
      localOnly,
    };

    try {
      const cached = this.reposCache.get(cacheKey);
      if (cached && cached.data) {
        res.json({
          ...cached.data,
          cached: true,
          cacheTimestamp: Date.now() - 1000,
        });
        return;
      }

      // localOnly never touches GitHub, so it must NOT require a connected token.
      if (!localOnly && !this.getCachedToken(userId)) {
        await this.loadTokenForUser(userId, authToken);
      }
      const userOctokit = localOnly ? null : this.getUserOctokit(userId);
      const gitLocalService = (req as any).gitLocalService;

      const result = await this.repoHandler.fetchReposWithLocalStatus(
        userOctokit,
        userId,
        page,
        per_page,
        search,
        language,
        sort,
        gitLocalService,
        authToken,
        skipGitOperations,
        blockedOrgs,
        localOnly
      );

      this.reposCache.set(cacheKey, result);

      res.json({ ...result, cached: false, cacheTimestamp: Date.now() });
    } catch (error: any) {
      console.error('[GitHubApiService] Error in handleListReposCached:', error);
      res.status(500).json({
        error: error.message || 'Failed to fetch repositories',
        repos: [],
        hasMore: false,
        total_count: 0,
        cached: false,
      });
    }
  }

  async handleListReposRefresh(req: Request, res: Response): Promise<void> {
    const requestStartTime = Date.now();
    const userId = req.session.userEmail!;
    const authToken = req.session.authToken;
    const page = parseInt((req.query?.page as string) || '1');
    const per_page = parseInt((req.query?.per_page as string) || '20');
    const search = req.query?.search as string;
    const language = req.query?.language as string;
    const sort = (req.query?.sort as string) || 'updated';
    const skipGitOperations = req.query?.skipGitOperations === 'true';
    // Workspace-only listing (Home + Repos tab) — no GitHub fetch.
    const localOnly = req.query?.localOnly === 'true';
    const blockedOrgs = req.query?.blockedOrgs
      ? (JSON.parse(req.query.blockedOrgs as string) as string[])
      : undefined;

    const cacheKey = {
      userId,
      page,
      per_page,
      search,
      language,
      sort,
      blockedOrgs: blockedOrgs?.sort().join(','),
      localOnly,
    };

    try {
      // localOnly never touches GitHub, so it must NOT require a connected token.
      const userOctokit = localOnly ? null : await this.getOctokitForUser(userId, authToken);
      const gitLocalService = (req as any).gitLocalService;

      const result = await this.repoHandler.fetchReposWithLocalStatus(
        userOctokit,
        userId,
        page,
        per_page,
        search,
        language,
        sort,
        gitLocalService,
        authToken,
        skipGitOperations,
        blockedOrgs,
        localOnly
      );

      this.reposCache.set(cacheKey, result);

      const totalDuration = Date.now() - requestStartTime;

      res.json({ ...result, cached: false, cacheTimestamp: Date.now() });
    } catch (error: any) {
      const errorDuration = Date.now() - requestStartTime;
      console.error(`[GitHubApiService] /api/repos/refresh FAILED after ${errorDuration}ms:`, {
        status: error?.status,
        message: error?.message,
        responseMessage: error?.response?.data?.message,
        code: error?.code,
        name: error?.name,
      });

      if (handleGitHubApiError(error, req, res, req.session?.authToken)) {
        return;
      }

      res.status(500).json({
        error: error.message || 'Failed to refresh repositories',
        repos: [],
        hasMore: false,
        total_count: 0,
        cached: false,
      });
    }
  }

  async getSimpleReposList(req: Request): Promise<string[]> {
    return this.repoHandler.getSimpleReposList(req);
  }

  /**
   * POST /api/repos/rescan — drop this user's in-memory repo caches so a
   * freshly-linked/unlinked local project shows up on the NEXT repos fetch
   * without restarting `portable`.
   *
   * `portable link`/`unlink` only touch the filesystem (the workspace junction +
   * `repo-views.json`). The directory walk that discovers local repos
   * (`GitLocalService.getLocalRepositoriesIn`) is live per request, but two
   * in-memory caches hide the change from an already-running api: the
   * `ReposCacheService` repos-list cache (5-min TTL) and the
   * `RepoViewTrackerService` viewed-repos cache (loaded once, never re-read).
   * The launcher calls this loopback endpoint right after a link/unlink so the
   * change is reflected immediately. Self-scoped — only the caller's own caches
   * are dropped.
   */
  async handleRescanRepos(req: Request, res: Response): Promise<void> {
    const userId = req.session.userEmail;
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const invalidatedRepoCacheEntries = this.reposCache.invalidateUser(userId);
    const clearedRepoViewCache = this.repoViewTracker?.clearCache(userId) ?? false;

    console.log(
      `[GitHubApiService] /api/repos/rescan for ${userId}: dropped ${invalidatedRepoCacheEntries} repos-cache entries, repo-view cache cleared=${clearedRepoViewCache}`
    );

    const response: RescanReposResponse = {
      success: true,
      invalidatedRepoCacheEntries,
      clearedRepoViewCache,
    };
    res.json(response);
  }

  async handleGetRepo(req: Request, res: Response): Promise<void> {
    const { owner, repo } = req.params as { owner: string; repo: string };
    const userId = req.session.userEmail!;
    const skipGitOperations = req.query?.skipGitOperations === 'true';
    const gitLocalService = (req as any).gitLocalService;

    try {
      // Cache-first with on-demand load — the bare sync getUserOctokit threw
      // GitHubConnectionError whenever the token mirror was cold.
      const userOctokit = await this.getOctokitForUser(userId, req.session.authToken);

      if (this.repoViewTracker) {
        const repoFullName = `${owner}/${repo}`;
        await this.repoViewTracker.markAsViewed(userId, repoFullName);

        this.refreshReposCacheInBackground(req, userId, gitLocalService).catch((err) => {
          console.error(
            `[GitHubApiService] Failed to refresh repos cache after viewing ${repoFullName}:`,
            err
          );
        });
      }

      // Resolve the REAL on-disk path FIRST so a FLAT clone
      // (`<workspace>/<dir>`, dir name ≠ owner/repo) is detected as local — NOT only the
      // canonical two-level `<workspace>/<owner>/<repo>` layout. Falls back to the
      // two-level path when discovery is unavailable, so it is a no-op for the canonical
      // layout. We resolve it BEFORE the GitHub fetch because a `portable link`'d local
      // repo has no GitHub record (see below).
      const localPath = await resolveRepoLocalPath(gitLocalService, userId, owner, repo);
      const isLocal = await fs
        .access(path.join(localPath, '.git'))
        .then(() => true)
        .catch(() => false);

      // GitHub metadata: a `portable link`'d repo with no remote gets the synthetic
      // `local/<name>` full name (LOCAL_PLACEHOLDER_OWNER), which can NEVER resolve via
      // `repos.get` — so skip the guaranteed-404 entirely and synthesize a local stub.
      // For any other owner, fetch GitHub but fall back to a stub when it 404s/errors AND
      // the repo IS cloned (deleted/renamed remote); only surface the error when the repo
      // is neither on GitHub nor on disk. Mirrors the repos LIST (makeLocalRepoStub) so the
      // detail page no longer shows "COULDN'T LOAD THE REPOSITORY" for a linked local repo.
      let data: Record<string, unknown>;
      if (owner === LOCAL_PLACEHOLDER_OWNER) {
        data = makeLocalRepoStub(owner, repo);
      } else {
        try {
          const response = await userOctokit.repos.get({ owner, repo });
          data = response.data as unknown as Record<string, unknown>;
        } catch (error: any) {
          if (!isLocal) {
            console.error('GitHub API Error:', error);
            if (handleGitHubApiError(error, req, res, req.session?.authToken)) {
              return;
            }
            res
              .status(error.status || 500)
              .json({ error: error.message || 'GitHub API request failed' });
            return;
          }
          console.warn(
            `[GitHubApiService] ${owner}/${repo} not on GitHub (status ${error?.status}); serving local stub`
          );
          data = makeLocalRepoStub(owner, repo);
        }
      }

      let lastUpdated = null;
      let currentBranch = null;
      let changedFiles: Array<{ path: string; status: string }> = [];
      let hasChanges = false;
      let unpushedCommits: Array<{ sha: string; message: string; author: string; date: string }> =
        [];
      let aheadBehind: { ahead: number; behind: number } | null = null;
      let remoteBranch: string | null = null;
      let hasRemote = false;

      if (isLocal) {
        try {
          const stats = await fs.stat(localPath);
          lastUpdated = stats.mtime.toISOString();

          if (!skipGitOperations) {
            currentBranch = await getCurrentBranch(localPath);
            remoteBranch = await getRemoteBranch(localPath);
            hasRemote = !!remoteBranch;
            aheadBehind = await getAheadBehind(localPath);
            unpushedCommits = await getUnpushedCommits(localPath);
            changedFiles = await getGitStatus(localPath);
            hasChanges = changedFiles.length > 0;
          }
        } catch (err) {
          console.warn('[GitHubApiService] Failed to read local repo state:', localPath, err);
        }
      }

      const repoData = {
        ...data,
        isLocal,
        localPath: isLocal ? localPath : undefined,
        lastUpdated,
        currentBranch,
        remoteBranch,
        hasRemote,
        hasChanges,
        hasUnpulledChanges: aheadBehind && aheadBehind.behind > 0,
        hasUnpushedChanges: aheadBehind && aheadBehind.ahead > 0,
        changedFiles,
        unpushedCommits,
        aheadBehind,
      };
      res.json(repoData);
    } catch (error: any) {
      console.error(`[GitHubApiService] Error in handleGetRepo:`, error);

      if (handleGitHubApiError(error, req, res, req.session?.authToken)) {
        return;
      }

      res.status(500).json({ error: 'Failed to fetch repository details' });
    }
  }

  private async refreshReposCacheInBackground(
    req: Request,
    userId: string,
    gitLocalService: any
  ): Promise<void> {
    try {
      const authToken = req.session.authToken;
      const userOctokit = this.getUserOctokit(userId);

      const defaultCacheKey = {
        userId,
        page: 1,
        per_page: 20,
        search: undefined,
        language: undefined,
        sort: 'updated',
      };

      const result = await this.repoHandler.fetchReposWithLocalStatus(
        userOctokit,
        userId,
        1,
        20,
        undefined,
        undefined,
        'updated',
        gitLocalService,
        req.session.authToken
      );

      this.reposCache.set(defaultCacheKey, result);
    } catch (error: any) {
      console.error(`[GitHubApiService] Background repos refresh error:`, error);
    }
  }

  async handleGetTree(req: Request, res: Response): Promise<void> {
    return this.repoHandler.handleGetTree(req, res);
  }

  // ============================================================================
  // Content Methods - Delegated to ContentHandler
  // ============================================================================

  async handleGetContents(req: Request, res: Response): Promise<void> {
    return this.contentHandler.handleGetContents(req, res);
  }

  async handleGetRawContent(req: Request, res: Response): Promise<void> {
    return this.contentHandler.handleGetRawContent(req, res);
  }

  async handleUpdateContents(req: Request, res: Response): Promise<void> {
    return this.contentHandler.handleUpdateContents(req, res);
  }

  async handleUpdateGitHubContents(req: Request, res: Response): Promise<void> {
    return this.contentHandler.handleUpdateGitHubContents(req, res);
  }

  async handleServeVideo(req: Request, res: Response): Promise<void> {
    return this.contentHandler.handleServeVideo(req, res);
  }

  async handleServeImage(req: Request, res: Response): Promise<void> {
    return this.contentHandler.handleServeImage(req, res);
  }

  // ============================================================================
  // Issue Methods - Delegated to IssueHandler
  // ============================================================================

  async handleGetIssues(req: Request, res: Response): Promise<void> {
    return this.issueHandler.handleGetIssues(req, res);
  }

  async handleGetIssue(req: Request, res: Response): Promise<void> {
    return this.issueHandler.handleGetIssue(req, res);
  }

  async handleCreateComment(req: Request, res: Response): Promise<void> {
    return this.issueHandler.handleCreateComment(req, res);
  }

  async handleUpdateIssue(req: Request, res: Response): Promise<void> {
    return this.issueHandler.handleUpdateIssue(req, res);
  }

  async handleAddAssignees(req: Request, res: Response): Promise<void> {
    return this.issueHandler.handleAddAssignees(req, res);
  }

  async handleRemoveAssignees(req: Request, res: Response): Promise<void> {
    return this.issueHandler.handleRemoveAssignees(req, res);
  }

  async handleGetLabels(req: Request, res: Response): Promise<void> {
    return this.issueHandler.handleGetLabels(req, res);
  }

  // ============================================================================
  // Pull Request Methods - Delegated to PullRequestHandler
  // ============================================================================

  async handleGetPulls(req: Request, res: Response): Promise<void> {
    return this.pullRequestHandler.handleGetPulls(req, res);
  }

  async handleGetPull(req: Request, res: Response): Promise<void> {
    return this.pullRequestHandler.handleGetPull(req, res);
  }

  async handleRequestReviewers(req: Request, res: Response): Promise<void> {
    return this.pullRequestHandler.handleRequestReviewers(req, res);
  }

  async handleRemoveRequestedReviewers(req: Request, res: Response): Promise<void> {
    return this.pullRequestHandler.handleRemoveRequestedReviewers(req, res);
  }

  // ============================================================================
  // Actions/Workflow Methods - Delegated to ActionHandler
  // ============================================================================

  async handleGetActionsRuns(req: Request, res: Response): Promise<void> {
    return this.actionHandler.handleGetActionsRuns(req, res);
  }

  async handleGetWorkflowRun(req: Request, res: Response): Promise<void> {
    return this.actionHandler.handleGetWorkflowRun(req, res);
  }

  async listWorkflows(req: Request, res: Response): Promise<void> {
    return this.actionHandler.listWorkflows(req, res);
  }

  async getWorkflowFile(req: Request, res: Response): Promise<void> {
    return this.actionHandler.getWorkflowFile(req, res);
  }

  async createWorkflowFile(req: Request, res: Response): Promise<void> {
    return this.actionHandler.createWorkflowFile(req, res);
  }

  async updateWorkflowFile(req: Request, res: Response): Promise<void> {
    return this.actionHandler.updateWorkflowFile(req, res);
  }

  async deleteWorkflowFile(req: Request, res: Response): Promise<void> {
    return this.actionHandler.deleteWorkflowFile(req, res);
  }

  async triggerWorkflowDispatch(req: Request, res: Response): Promise<void> {
    return this.actionHandler.triggerWorkflowDispatch(req, res);
  }

  async listWorkflowRuns(req: Request, res: Response): Promise<void> {
    return this.actionHandler.listWorkflowRuns(req, res);
  }

  async createOrUpdateRepoSecret(req: Request, res: Response): Promise<void> {
    return this.actionHandler.createOrUpdateRepoSecret(req, res);
  }

  // ============================================================================
  // Branch Methods - Delegated to BranchHandler
  // ============================================================================

  async handleGetBranches(req: Request, res: Response): Promise<void> {
    return this.branchHandler.handleGetBranches(req, res);
  }

  async handleGetCommits(req: Request, res: Response): Promise<void> {
    return this.branchHandler.handleGetCommits(req, res);
  }

  // ============================================================================
  // User Methods - Delegated to UserHandler
  // ============================================================================

  async handleGetUserProfile(req: Request, res: Response): Promise<void> {
    return this.userHandler.handleGetUserProfile(req, res);
  }

  async handleGetUserOrganizations(req: Request, res: Response): Promise<void> {
    return this.userHandler.handleGetUserOrganizations(req, res);
  }

  async handleGetCollaborators(req: Request, res: Response): Promise<void> {
    return this.userHandler.handleGetCollaborators(req, res);
  }

  async handleGetRecentBranches(req: Request, res: Response): Promise<void> {
    return this.userHandler.handleGetRecentBranches(req, res);
  }

  async handleGetUserTasks(req: Request, res: Response): Promise<void> {
    return this.userHandler.handleGetUserTasks(req, res);
  }

  async handleGetUserTasksCached(req: Request, res: Response): Promise<void> {
    return this.userHandler.handleGetUserTasksCached(req, res);
  }

  async handleGetUserTasksRefresh(req: Request, res: Response): Promise<void> {
    return this.userHandler.handleGetUserTasksRefresh(req, res);
  }

  async handleGetUserTaskStats(req: Request, res: Response): Promise<void> {
    return this.userHandler.handleGetUserTaskStats(req, res);
  }

  // ============================================================================
  // Git Status Methods
  // ============================================================================

  async handleGetGitStatus(req: Request, res: Response): Promise<void> {
    if (!req.session.userEmail) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { repoPaths } = req.body;
    if (!Array.isArray(repoPaths)) {
      res.status(400).json({ error: 'repoPaths must be an array' });
      return;
    }

    const gitLocalService = (req as any).gitLocalService;
    if (!gitLocalService) {
      res.status(500).json({ error: 'Git service not available' });
      return;
    }

    const results: Record<string, any> = {};
    const now = Date.now();

    for (const repoPath of repoPaths) {
      const cached = this.gitStatusCache.get(repoPath);
      if (cached && now - cached.timestamp < this.GIT_STATUS_CACHE_TTL) {
        results[repoPath] = cached.data;
        continue;
      }

      try {
        // getRepoStatusSafe bounds the git work (hard timeout + SIGKILL) and
        // degrades gracefully — no orphaned git left churning, unlike the old
        // Promise.race which abandoned the subprocess without killing it.
        const gitStatus = await gitLocalService.getRepoStatusSafe(repoPath);

        // Unpushed count via `rev-list --count` (single integer, hard-timeout
        // bounded). Returns 0 on any failure.
        const unpushedCount = await gitLocalService.getUnpushedCount(repoPath);

        const result = {
          success: true,
          gitStatus,
          unpushedCount,
        };

        results[repoPath] = result;

        this.gitStatusCache.set(repoPath, { data: result, timestamp: now });
      } catch (error: any) {
        const result = {
          success: false,
          error: error.message,
        };
        results[repoPath] = result;
      }
    }

    res.json({ gitStatusByPath: results });
  }
}

// Export the error class for external use
export { GitHubConnectionError };
