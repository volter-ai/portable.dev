import { exec } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';

import { Octokit } from '@octokit/rest';
import { getUserWorkspaceDir } from '@vgit2/shared/constants';
import { Request, Response } from 'express';

import { ReposCacheService } from '../../ReposCacheService.js';
import { RepoViewTrackerService } from '../../RepoViewTrackerService.js';
import { HandlerDependencies } from '../types.js';
import {
  determineRepoReasonAndScore,
  sortReposByScore,
  buildLinkHeader,
  withGitHubRetry,
  withGitHubTimeout,
} from '../utils/GitHubUtils.js';
import { loadGitignore } from '../utils/GitLocalUtils.js';
import { makeLocalRepoStub } from '../utils/localRepoStub.js';
import { applyRepoOwnerFilter, loadRepoOwnerFilter } from '../utils/repoOwnerFilter.js';

const execAsync = promisify(exec);

export class RepoHandler {
  private reposCache: ReposCacheService;
  private repoViewTracker: RepoViewTrackerService | null;
  private chatService: any | null;
  private deps: HandlerDependencies;
  private DEFAULT_REPOS_PER_PAGE = 20;

  // GraphQL repos cache (for GitHub App - avoids fetching all repos repeatedly)
  private graphqlReposCache: Map<string, { data: any[]; timestamp: number }> = new Map();
  private GRAPHQL_REPOS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache TTL

  constructor(
    reposCache: ReposCacheService,
    repoViewTracker: RepoViewTrackerService | null,
    chatService: any | null,
    deps: HandlerDependencies
  ) {
    this.reposCache = reposCache;
    this.repoViewTracker = repoViewTracker;
    this.chatService = chatService;
    this.deps = deps;
  }

  /**
   * Fetch repos page using GraphQL (for GitHub App)
   */
  private async fetchReposPageViaGraphQL(
    userId: string,
    sort: string = 'updated',
    perPage: number = 20,
    page: number = 1
  ): Promise<{ data: any[]; totalCount: number; hasNextPage: boolean }> {
    const cached = this.deps.getCachedToken(userId);
    if (!cached) {
      throw new Error('GitHub token not found');
    }

    // 30s request timeout so a GitHub outage can't hang the repos-list GraphQL
    // fetch forever (matches GitHubApiService's canonical Octokit config).
    const octokit = new Octokit({ auth: cached, request: { timeout: 30000 } });

    // Map sort parameter to GraphQL orderBy field
    const orderByField =
      sort === 'name' || sort === 'full_name'
        ? 'NAME'
        : sort === 'created'
          ? 'CREATED_AT'
          : sort === 'pushed'
            ? 'PUSHED_AT'
            : sort === 'stars'
              ? 'STARGAZERS'
              : 'UPDATED_AT';

    const itemsToFetch = page * perPage;

    const query = `
      query {
        viewer {
          repositories(first: ${itemsToFetch}, orderBy: {field: ${orderByField}, direction: DESC}) {
            totalCount
            pageInfo {
              hasNextPage
            }
            nodes {
              id
              name
              nameWithOwner
              isPrivate
              description
              owner {
                login
                avatarUrl
              }
              url
              stargazerCount
              watchers {
                totalCount
              }
              forkCount
              issues(states: OPEN) {
                totalCount
              }
              primaryLanguage {
                name
              }
              createdAt
              updatedAt
              pushedAt
              diskUsage
              defaultBranchRef {
                name
              }
              hasIssuesEnabled
              hasProjectsEnabled
              hasWikiEnabled
              isArchived
              isDisabled
              visibility
            }
          }
        }
      }
    `;

    const response: any = await octokit.graphql(query);

    const allNodes = response.viewer.repositories.nodes;
    const totalCount = response.viewer.repositories.totalCount;

    const startIndex = (page - 1) * perPage;
    const pageNodes = allNodes.slice(startIndex, startIndex + perPage);

    const repos = pageNodes.map((node: any) => ({
      id: node.id,
      name: node.name,
      full_name: node.nameWithOwner,
      private: node.isPrivate,
      description: node.description,
      owner: {
        login: node.owner.login,
        avatar_url: node.owner.avatarUrl,
      },
      url: node.url,
      html_url: node.url,
      stargazers_count: node.stargazerCount,
      watchers_count: node.watchers?.totalCount || 0,
      forks_count: node.forkCount,
      open_issues_count: node.issues?.totalCount || 0,
      language: node.primaryLanguage?.name || null,
      created_at: node.createdAt,
      updated_at: node.updatedAt,
      pushed_at: node.pushedAt,
      size: node.diskUsage || 0,
      default_branch: node.defaultBranchRef?.name || 'main',
      has_issues: node.hasIssuesEnabled,
      has_projects: node.hasProjectsEnabled,
      has_wiki: node.hasWikiEnabled,
      archived: node.isArchived,
      disabled: node.isDisabled,
      visibility: node.visibility,
    }));

    return {
      data: repos,
      totalCount,
      hasNextPage: startIndex + perPage < totalCount,
    };
  }

  /**
   * Fetch repos from GitHub and enrich with local status
   */
  async fetchReposWithLocalStatus(
    userOctokit: Octokit | null,
    userId: string,
    page: number,
    per_page: number,
    search?: string,
    language?: string,
    sort?: string,
    gitLocalService?: any,
    authToken?: string,
    skipGitOperations?: boolean,
    blockedOrgs?: string[],
    localOnly?: boolean
  ) {
    const startTime = Date.now();

    let data: any[], headers: any, totalCount: number | undefined;

    const githubApiStartTime = Date.now();
    if (localOnly) {
      // rev9 D27a (rev9.1 correction): WORKSPACE-ONLY listing — no GitHub fetch at all
      // (independent of whether GitHub is connected). `data` starts empty; the page-1
      // local-repo injection below populates it from `getLocalRepositories` (F1's
      // flat-aware discovery) and the enrichment loop sets isLocal/gitStatus. The full
      // discovered set is returned on page 1 (hasMore=false); `language` has no meaning
      // for a local stub (no remote metadata) so it is ignored, while `search` IS
      // honored as a name filter at injection time below.
      data = [];
      headers = {};
      totalCount = undefined;
    } else if (search) {
      if (!userOctokit) throw new Error('GitHub not connected');
      // Get authenticated user and their organizations
      const { data: user } = await withGitHubRetry(() => userOctokit.users.getAuthenticated(), {
        label: 'repos.search.getAuthenticated',
      });
      const { data: orgs } = await withGitHubRetry(
        () => userOctokit.orgs.listForAuthenticatedUser(),
        { label: 'repos.search.listOrgs' }
      );

      const ownerFilters = [`user:${user.login}`, ...orgs.map((org) => `org:${org.login}`)];
      const ownerQuery = ownerFilters.join(' ');

      let searchQuery = `${search} in:name ${ownerQuery}`;

      if (language) {
        searchQuery += ` language:${language}`;
      }

      const searchSort = sort === 'name' ? undefined : sort === 'stars' ? 'stars' : 'updated';

      const response = await withGitHubRetry(
        () =>
          userOctokit.search.repos({
            q: searchQuery,
            sort: searchSort as 'stars' | 'updated' | undefined,
            order: 'desc',
            per_page,
            page,
          }),
        { label: 'repos.search.repos' }
      );

      const searchDuration = Date.now() - githubApiStartTime;

      data = response.data.items;
      totalCount = response.data.total_count;
      headers = response.headers;

      if (sort === 'name') {
        data = data.sort((a, b) => a.name.localeCompare(b.name));
      }
    } else {
      const connectionType = this.deps.getGitHubConnectionType(userId);

      if (connectionType === 'app') {
        const result = await this.fetchReposPageViaGraphQL(userId, sort, per_page, page);

        data = result.data;
        totalCount = result.totalCount;

        headers = {
          link: buildLinkHeader(page, per_page, totalCount),
        };

        console.log(
          `[RepoHandler] ✓ GitHub App GraphQL responded with ${data.length} repos (page ${page} of ${Math.ceil(totalCount / per_page)})`
        );
      } else {
        if (!userOctokit) throw new Error('GitHub not connected');
        const listSort = sort === 'stars' ? 'updated' : sort;

        let response;
        try {
          response = await withGitHubTimeout(
            () =>
              userOctokit.repos.listForAuthenticatedUser({
                affiliation: 'owner,collaborator,organization_member',
                sort: listSort as 'updated' | 'full_name' | 'created' | 'pushed',
                per_page,
                page,
              }),
            { label: 'repos.listForAuthenticatedUser' }
          );
        } catch (error: any) {
          console.error('[RepoHandler] GitHub OAuth repos.listForAuthenticatedUser failed', {
            userId,
            status: error?.status,
            message: error?.message,
            responseMessage: error?.response?.data?.message,
          });
          throw error;
        }

        data = response.data;
        headers = response.headers;
      }

      if (language) {
        data = data.filter(
          (repo) => repo.language && repo.language.toLowerCase() === language.toLowerCase()
        );
      }

      if (sort === 'stars') {
        data = data.sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0));
      }
    }

    // Filter out blocked organizations if specified
    if (blockedOrgs && blockedOrgs.length > 0) {
      data = data.filter((repo) => !blockedOrgs.includes(repo.owner.login));
    }

    // Local-first: GitHub's paginated list can BURY a repo the user has locally
    // (junctioned/cloned) when its remote `updated_at` is old and the user belongs
    // to many org repos — so it never lands in the fetched page and `isLocal` can't
    // be enriched onto it. On PAGE 1 we inject a stub for any locally-present repo
    // the page didn't return; the enrichment loop below sets isLocal/gitStatus on it
    // like any other repo. (Later pages DROP local repos — see below — so a buried
    // local repo that also surfaces deep in GitHub's list isn't shown twice.)
    // rev9 D27: discover local repos ONCE and build maps so a FLAT clone
    // (`<workspace>/<dir>` whose git remote is `owner/repo`, dir name irrelevant) is
    // matched as `isLocal` too — not only the canonical two-level
    // `<workspace>/<owner>/<repo>` layout. The map's `localPath` is the REAL on-disk
    // path (flat or two-level); the reverse map attributes a chat's `repo_path` back
    // to its `owner/repo` for the activity map below.
    const localRepoMap = new Map<string, string>(); // full_name(lowercased) -> localPath
    const localPathToFullName = new Map<string, string>(); // resolved localPath -> full_name
    if (gitLocalService?.getLocalRepositories) {
      try {
        const localRepos: Array<{ full_name: string; localPath: string }> =
          await gitLocalService.getLocalRepositories(userId);
        for (const lr of localRepos) {
          if (!lr?.full_name || !lr?.localPath) continue;
          localRepoMap.set(lr.full_name.toLowerCase(), lr.localPath);
          localPathToFullName.set(path.resolve(lr.localPath), lr.full_name);
        }
        // PAGE 1: inject a stub for any locally-present repo the GitHub page did not
        // return, so a buried local repo still appears and flows through enrichment.
        // In localOnly mode `data` is empty, so this injects the WHOLE discovered set
        // (the only source), honoring the `search` name filter.
        if (page === 1) {
          const searchLower = localOnly && search ? search.toLowerCase() : null;
          const present = new Set((data as Array<{ full_name: string }>).map((r) => r.full_name));
          for (const lr of localRepos) {
            if (present.has(lr.full_name)) continue;
            if (searchLower && !lr.full_name.toLowerCase().includes(searchLower)) continue;
            const slash = lr.full_name.indexOf('/');
            if (slash <= 0 || slash === lr.full_name.length - 1) continue;
            const stub = makeLocalRepoStub(
              lr.full_name.slice(0, slash),
              lr.full_name.slice(slash + 1)
            );
            (data as unknown[]).push(stub);
          }
        }
      } catch (err) {
        console.warn('[RepoHandler] local-repo discovery/injection failed (continuing):', err);
      }
    }

    const githubApiDuration = Date.now() - githubApiStartTime;

    const userWorkspace = getUserWorkspaceDir(userId);

    const dbQueryStartTime = Date.now();

    const repoFullNames = data.map((repo) => repo.full_name);
    const viewedMap = this.repoViewTracker
      ? await this.repoViewTracker.checkMultiple(userId, repoFullNames)
      : new Map<string, boolean>();

    const rawChatActivityMap = this.chatService?.dbAdapter
      ? await this.chatService.dbAdapter.getLastChatActivityByRepo(userId, authToken)
      : new Map<string, string>();

    const dbQueryDuration = Date.now() - dbQueryStartTime;

    const chatActivityMap = new Map<string, string>();
    for (const [fullPath, timestamp] of rawChatActivityMap.entries()) {
      // rev9: prefer the discovered repo_path -> full_name mapping, which handles a
      // FLAT clone correctly (its last two path segments are NOT owner/repo). Fall
      // back to the last-two-segments heuristic for paths not in the discovery map
      // (e.g. an orphaned repo_path from a moved workspace).
      const mapped = localPathToFullName.get(path.resolve(fullPath));
      if (mapped) {
        chatActivityMap.set(mapped, timestamp);
        continue;
      }
      const pathParts = fullPath.split(path.sep).filter((p: string) => p);
      if (pathParts.length >= 2) {
        const owner = pathParts[pathParts.length - 2];
        const repo = pathParts[pathParts.length - 1];
        const repoFullName = `${owner}/${repo}`;
        chatActivityMap.set(repoFullName, timestamp);
      }
    }

    const BATCH_SIZE = 10;
    const reposWithLocalStatus: any[] = [];

    for (let i = 0; i < data.length; i += BATCH_SIZE) {
      const batch = data.slice(i, i + BATCH_SIZE);
      const batchStartTime = Date.now();

      const batchResults = await Promise.all(
        batch.map(async (repo) => {
          // rev9 D27: use the discovered on-disk path (handles flat clones) and only
          // fall back to the canonical two-level reconstruction when the repo wasn't
          // in the discovery map (e.g. cloned mid-request).
          const localPath =
            localRepoMap.get(repo.full_name.toLowerCase()) ??
            path.join(userWorkspace, repo.owner.login, repo.name);
          let isLocal = false;
          let lastUpdated = null;
          let gitStatus = null;
          let unpushedCount = 0;
          let reason = '';

          try {
            await fs.access(path.join(localPath, '.git'));
            isLocal = true;

            const stats = await fs.stat(localPath);
            lastUpdated = stats.mtime.toISOString();

            if (!skipGitOperations && gitLocalService) {
              try {
                // Resilient + hard-timeout bounded: never hangs the repos list on
                // a large repo, serving stale/degraded counts instead of throwing.
                gitStatus = await gitLocalService.getRepoStatusSafe(localPath);
              } catch (err) {
                console.warn('[RepoHandler] Failed to get git status for', localPath, err);
              }

              try {
                unpushedCount = await gitLocalService.getUnpushedCount(localPath);
              } catch (err) {
                console.warn('[RepoHandler] Failed to get unpushed commits for', localPath, err);
              }
            }
          } catch (err) {
            // console.debug('[RepoHandler] Repo not cloned locally:', localPath);
          }

          const lastChatActivity = chatActivityMap.get(repo.full_name) || null;

          const result = determineRepoReasonAndScore(
            repo,
            isLocal,
            lastUpdated,
            gitStatus,
            lastChatActivity
          );
          reason = result.reason;
          const sortScore = result.sortScore;
          const activityType = result.activityType;

          if (!isLocal && !lastChatActivity && repo.updated_at) {
            reason = `Updated ${new Date(repo.updated_at).toLocaleString()}`;
          }

          const isNew = !isLocal && !viewedMap.get(repo.full_name);

          return {
            ...repo,
            isLocal,
            localPath: isLocal ? localPath : undefined,
            lastUpdated,
            lastChatActivity,
            gitStatus: gitStatus
              ? {
                  branch: gitStatus.branch,
                  ahead: gitStatus.ahead,
                  behind: gitStatus.behind,
                  insertions: gitStatus.insertions,
                  deletions: gitStatus.deletions,
                  staged: gitStatus.staged,
                  modified: gitStatus.modified,
                  untracked: gitStatus.untracked,
                }
              : undefined,
            hasUnpulledChanges: gitStatus && gitStatus.behind > 0,
            hasUnpushedChanges: gitStatus && gitStatus.ahead > 0,
            unpushedCount: isLocal && unpushedCount > 0 ? unpushedCount : undefined,
            reason,
            sortScore,
            activityType,
            isNew,
          };
        })
      );

      reposWithLocalStatus.push(...batchResults);

      const batchDuration = Date.now() - batchStartTime;
    }

    // Server-side owner filter (local-first decluttering, ~/.portable/repo-filter.json).
    // Applied AFTER local enrichment so a local repo is never hidden; covers every
    // list endpoint (this is the shared core for /repos, /repos/cached, refresh,
    // simple-list). The client never needs to send anything — the PC owns the filter.
    const ownerFilter = await loadRepoOwnerFilter();
    const filteredRepos = applyRepoOwnerFilter(reposWithLocalStatus, ownerFilter);

    // Local repos are injected on page 1 (above); drop them from later pages so a
    // buried local repo that also surfaces deep in GitHub's list isn't listed twice.
    const pagedRepos = page === 1 ? filteredRepos : filteredRepos.filter((r) => !r.isLocal);

    const smartSorted = sortReposByScore(pagedRepos);

    const linkHeader = headers.link || '';
    const hasMore = localOnly
      ? false // the whole discovered workspace set is returned on page 1
      : search
        ? page * per_page < (totalCount || 0)
        : linkHeader.includes('rel="next"');

    const totalDuration = Date.now() - startTime;

    return {
      repos: smartSorted,
      page,
      per_page,
      hasMore,
      total_count: totalCount,
    };
  }

  /**
   * GET /api/repos/:owner/:repo/tree/*
   */
  async handleGetTree(req: Request, res: Response): Promise<void> {
    if (!req.session.userEmail) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { owner, repo } = req.params as { owner: string; repo: string };
    const dirPath = req.params[0] || '';

    const userId = req.session.userEmail!;
    const gitLocalService = (req as any).gitLocalService;

    try {
      // rev9 D27: resolve the REAL on-disk path (a flat clone lives at
      // `<workspace>/<dir>`, not `<workspace>/<owner>/<repo>`), falling back to the
      // canonical two-level path when discovery is unavailable.
      const repoPath =
        gitLocalService && typeof gitLocalService.resolveLocalRepoPath === 'function'
          ? await gitLocalService.resolveLocalRepoPath(userId, owner, repo)
          : path.join(getUserWorkspaceDir(userId), owner, repo);
      const isLocal = await fs
        .access(repoPath)
        .then(() => true)
        .catch(() => false);

      if (!isLocal) {
        res.status(404).json({ error: 'Repository not found locally' });
        return;
      }

      const fullPath = path.join(repoPath, dirPath);

      if (!fullPath.startsWith(repoPath)) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      const exists = await fs
        .access(fullPath)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        res.status(404).json({ error: 'Directory not found' });
        return;
      }

      const stats = await fs.stat(fullPath);
      if (!stats.isDirectory()) {
        res.status(400).json({ error: 'Path is not a directory' });
        return;
      }

      const ig = await loadGitignore(repoPath);

      const items = await fs.readdir(fullPath);
      const contents = [];

      for (const item of items) {
        const itemPath = path.join(fullPath, item);
        const itemStats = await fs.stat(itemPath);

        let hasChildren = false;
        if (itemStats.isDirectory()) {
          try {
            const dirContents = await fs.readdir(itemPath);
            hasChildren = dirContents.length > 0;
          } catch (err) {
            console.warn('[RepoHandler] Cannot read directory:', itemPath, err);
            hasChildren = false;
          }
        }

        const relativePath = path.join(dirPath, item).replace(/\\/g, '/');

        const isGitignored = ig.ignores(relativePath);

        contents.push({
          name: item,
          path: relativePath,
          type: itemStats.isDirectory() ? 'directory' : 'file',
          size: itemStats.isFile() ? itemStats.size : undefined,
          lastModified: itemStats.mtime.getTime(),
          hasChildren,
          isHidden: isGitignored,
        });
      }

      contents.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      res.json({ contents });
    } catch (error) {
      console.error('[RepoHandler] Error reading directory:', error);
      res.status(500).json({ error: 'Failed to read directory' });
    }
  }

  /**
   * GET /api/repos
   */
  async handleListRepos(req: Request, res: Response): Promise<void> {
    const requestStartTime = Date.now();
    const userId = req.session.userEmail!;
    const authToken = req.session.authToken;
    const page = parseInt((req.query?.page as string) || '1');
    const per_page = parseInt(
      (req.query?.per_page as string) || String(this.DEFAULT_REPOS_PER_PAGE)
    );
    const search = req.query?.search as string;
    const language = req.query?.language as string;
    const sort = (req.query?.sort as string) || 'updated';
    const bustCache = req.query?.bustCache === 'true';
    const skipGitOperations = req.query?.skipGitOperations === 'true';
    // rev9 D27a: WORKSPACE-ONLY listing — show only the repos discovered under
    // WORKSPACE_DIR, never the GitHub account list (Home + Repos tab).
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

    const cached = !bustCache && this.reposCache.get(cacheKey);

    if (cached) {
      const cacheDuration = Date.now() - requestStartTime;
      const ageMinutes = Math.round(cached.ageMs / 60000);

      if (cached.needsRefresh) {
        this.reposCache.recordRefresh(cacheKey);
        this.refreshCacheInBackground(req, cacheKey).catch((err) => {
          console.error(`[RepoHandler] Background refresh failed:`, err);
        });
      }

      const response = cached.data;
      res.json(response);
      return;
    }

    try {
      // localOnly never touches GitHub, so it must NOT require a connected token.
      if (!localOnly && !this.deps.getCachedToken(userId)) {
        await this.deps.getOctokitForUser(userId, authToken);
      }

      const userOctokit = localOnly ? null : this.deps.getUserOctokit(userId);
      const gitLocalService = (req as any).gitLocalService;

      const fetchStartTime = Date.now();
      const result = await this.fetchReposWithLocalStatus(
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
      const fetchDuration = Date.now() - fetchStartTime;

      this.reposCache.set(cacheKey, result);

      const totalDuration = Date.now() - requestStartTime;
      res.json(result);
    } catch (error: any) {
      const errorDuration = Date.now() - requestStartTime;
      console.error(`[RepoHandler] Error fetching repos after ${errorDuration}ms:`, error.message);

      if (this.deps.handleGitHubApiError(error, req, res, req.session?.authToken)) {
        return;
      }

      res.status(500).json({ error: 'Failed to fetch repositories' });
    }
  }

  /**
   * Background refresh for stale cache entries
   */
  private async refreshCacheInBackground(req: Request, cacheKey: any): Promise<void> {
    try {
      const userId = req.session.userEmail!;
      const authToken = req.session.authToken;
      const userOctokit = cacheKey.localOnly ? null : this.deps.getUserOctokit(userId);
      const gitLocalService = (req as any).gitLocalService;

      const result = await this.fetchReposWithLocalStatus(
        userOctokit,
        cacheKey.userId,
        cacheKey.page,
        cacheKey.per_page,
        cacheKey.search,
        cacheKey.language,
        cacheKey.sort,
        gitLocalService,
        authToken,
        true,
        cacheKey.blockedOrgs ? cacheKey.blockedOrgs.split(',') : undefined,
        cacheKey.localOnly
      );

      this.reposCache.set(cacheKey, result);
    } catch (error: any) {
      console.error(`[RepoHandler] Background refresh error:`, error);
    }
  }

  /**
   * GET /api/repos/simple-list
   */
  async getSimpleReposList(req: Request): Promise<string[]> {
    try {
      const userId = req.session.userEmail;
      const authToken = req.session.authToken;
      if (!userId) {
        return [];
      }

      const cacheKey = {
        userId,
        page: 1,
        per_page: this.DEFAULT_REPOS_PER_PAGE,
        search: undefined,
        language: undefined,
        sort: 'updated',
      };

      const cached = this.reposCache.get(cacheKey);

      if (cached && cached.data && (cached.data as any).repos) {
        const repoNames = (cached.data as any).repos.map(
          (repo: any) => `${repo.owner.login}/${repo.name}`
        );
        return repoNames;
      }

      const userOctokit = this.deps.getUserOctokit(userId);
      const gitLocalService = (req as any).gitLocalService;

      const result = await this.fetchReposWithLocalStatus(
        userOctokit,
        userId,
        1,
        this.DEFAULT_REPOS_PER_PAGE,
        undefined,
        undefined,
        'updated',
        gitLocalService,
        authToken
      );

      this.reposCache.set(cacheKey, result);

      const repoNames = result.repos.map((repo: any) => `${repo.owner.login}/${repo.name}`);
      return repoNames;
    } catch (error: any) {
      console.warn('[RepoHandler] getSimpleReposList failed, returning empty array:', error);
      return [];
    }
  }
}
