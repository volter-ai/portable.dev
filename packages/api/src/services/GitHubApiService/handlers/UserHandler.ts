import { Request, Response } from 'express';

import { HandlerDependencies } from '../types.js';
import {
  extractLinkedIssues,
  fetchUserDisplayNames,
  withGitHubRetry,
  withGitHubTimeout,
} from '../utils/GitHubUtils.js';

// ---------------------------------------------------------------------------
// Tasks are scoped to the repositories the user has CLONED into their sandbox
// workspace — a fast filesystem scan via GitLocalService, NOT a
// full-GitHub-account GraphQL scan (the old `viewer.issues`/`viewer.pullRequests`
// query was the Task-tab spinner bottleneck, especially on mobile). When nothing
// is cloned the handler returns `noLocalRepos: true` so the client can guide the
// user to clone a repository instead of querying their whole account.
// ---------------------------------------------------------------------------

/** Cap on how many cloned repos a single tasks GraphQL query fans out over. */
const MAX_LOCAL_REPOS = 50;
/**
 * Placeholder owner for locally-CREATED projects (`GitLocalService.createLocalFolder`
 * → `~/workspace/local/<name>`, a `git init` with NO GitHub remote). These are NOT
 * real GitHub repositories, so they must be excluded from the per-repo GitHub GraphQL
 * tasks query: otherwise GitHub answers "Could not resolve to a Repository with the
 * name 'local/<name>'" and that ONE unresolvable alias fails the WHOLE multi-repo
 * query, blanking the Tasks page for every genuinely-cloned repo.
 */
const LOCAL_PLACEHOLDER_OWNER = 'local';
/** Per-repo `first:` for each issues/PRs/closed connection. */
const PER_REPO_TASK_LIMIT = 20;
/** Cap on the aggregated, cross-repo issue/PR lists returned to the client. */
const MAX_TASK_ITEMS = 50;

/** The Issue node shape `mapIssueNode` consumes (open + closed issues). */
const ISSUE_FIELDS_FRAGMENT = `
  fragment TaskIssueFields on Issue {
    number
    title
    state
    createdAt
    updatedAt
    closedAt
    body
    url
    comments {
      totalCount
    }
    labels(first: 10) {
      nodes {
        name
        color
      }
    }
    assignees(first: 5) {
      nodes {
        login
        avatarUrl
      }
    }
    author {
      login
      avatarUrl
    }
    milestone {
      title
      dueOn
    }
    repository {
      nameWithOwner
      owner {
        login
        avatarUrl
      }
      name
    }
  }
`;

/** The PullRequest node shape `mapPrNode` consumes. */
const PR_FIELDS_FRAGMENT = `
  fragment TaskPrFields on PullRequest {
    number
    title
    state
    isDraft
    createdAt
    updatedAt
    closedAt
    mergedAt
    body
    url
    additions
    deletions
    comments {
      totalCount
    }
    reviews {
      totalCount
    }
    reviewRequests(first: 10) {
      nodes {
        requestedReviewer {
          __typename
          ... on User {
            login
            avatarUrl
          }
          ... on Team {
            name
          }
        }
      }
    }
    latestReviews(first: 10) {
      nodes {
        author {
          login
          avatarUrl
        }
      }
    }
    commits {
      totalCount
    }
    labels(first: 10) {
      nodes {
        name
        color
      }
    }
    author {
      login
      avatarUrl
    }
    assignees(first: 5) {
      nodes {
        login
        avatarUrl
      }
    }
    headRefName
    baseRefName
    repository {
      nameWithOwner
      owner {
        login
        avatarUrl
      }
      name
    }
  }
`;

/**
 * Build the per-repo tasks GraphQL query, scoped to the user's locally cloned
 * repositories. Each repo gets a `repo<index>` alias with its OPEN issues, OPEN
 * pull requests, and CLOSED (assignee-filtered, for "Done Today") issues.
 *
 * For the `my` view the OPEN issues are filtered to the viewer's assigned ones
 * (`filterBy: {assignee}`); the `all` view returns every open issue. PRs are
 * always fetched whole and filtered to the author client-side for the `my` view
 * (the GraphQL PR connection has no author argument).
 */
function buildLocalTasksQuery(localRepos: string[], isMyView: boolean): string {
  const assigneeFilter = isMyView ? ', filterBy: {assignee: $login}' : '';

  const repoQueries = localRepos
    .map((fullName, index) => {
      const [owner, name] = fullName.split('/');
      // JSON.stringify safely quotes/escapes the owner+name as GraphQL strings.
      return `
        repo${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
          nameWithOwner
          issues(first: ${PER_REPO_TASK_LIMIT}, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}${assigneeFilter}) {
            nodes {
              ...TaskIssueFields
            }
          }
          pullRequests(first: ${PER_REPO_TASK_LIMIT}, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes {
              ...TaskPrFields
            }
          }
          closedIssues: issues(first: ${PER_REPO_TASK_LIMIT}, states: CLOSED, filterBy: {assignee: $login}, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes {
              ...TaskIssueFields
            }
          }
        }`;
    })
    .join('\n');

  return `
    ${ISSUE_FIELDS_FRAGMENT}
    ${PR_FIELDS_FRAGMENT}
    query($login: String!) {
      viewer {
        login
        avatarUrl
      }
      ${repoQueries}
    }
  `;
}

/** Map a GraphQL Issue node into the REST-ish task shape the clients expect. */
function mapIssueNode(issue: any) {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    state: issue.state.toLowerCase(),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    body: issue.body,
    html_url: issue.url,
    comments: issue.comments.totalCount,
    labels: issue.labels.nodes.map((label: any) => ({
      name: label.name,
      color: label.color,
    })),
    assignee:
      issue.assignees.nodes.length > 0
        ? {
            login: issue.assignees.nodes[0].login,
            avatar_url: issue.assignees.nodes[0].avatarUrl,
          }
        : null,
    assignees: issue.assignees.nodes.map((a: any) => ({
      login: a.login,
      avatar_url: a.avatarUrl,
    })),
    user: issue.author
      ? {
          login: issue.author.login,
          avatar_url: issue.author.avatarUrl,
        }
      : null,
    milestone: issue.milestone
      ? {
          title: issue.milestone.title,
          due_on: issue.milestone.dueOn,
        }
      : null,
    repository: issue.repository
      ? {
          full_name: issue.repository.nameWithOwner,
          owner: issue.repository.owner,
          name: issue.repository.name,
        }
      : undefined,
    repository_url: issue.repository
      ? `https://api.github.com/repos/${issue.repository.nameWithOwner}`
      : undefined,
  };
}

/** Map a GraphQL PullRequest node into the REST-ish task shape (+ reviewers). */
function mapPrNode(pr: any) {
  const linkedIssues = extractLinkedIssues(pr.body || '');

  const reviewers: Array<{ login: string; avatar_url?: string }> = [];
  const seenReviewers = new Set<string>();

  if (pr.reviewRequests?.nodes) {
    pr.reviewRequests.nodes.forEach((req: any) => {
      if (req.requestedReviewer?.__typename === 'User') {
        const login = req.requestedReviewer.login;
        if (!seenReviewers.has(login)) {
          seenReviewers.add(login);
          reviewers.push({
            login,
            avatar_url: req.requestedReviewer.avatarUrl,
          });
        }
      }
    });
  }

  if (pr.latestReviews?.nodes) {
    pr.latestReviews.nodes.forEach((review: any) => {
      if (review.author) {
        const login = review.author.login;
        if (!seenReviewers.has(login)) {
          seenReviewers.add(login);
          reviewers.push({
            login,
            avatar_url: review.author.avatarUrl,
          });
        }
      }
    });
  }

  return {
    id: pr.number,
    number: pr.number,
    title: pr.title,
    state: pr.state.toLowerCase(),
    draft: pr.isDraft,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    merged_at: pr.mergedAt,
    body: pr.body,
    html_url: pr.url,
    additions: pr.additions,
    deletions: pr.deletions,
    comments: pr.comments.totalCount,
    review_comments: pr.reviews.totalCount,
    commits: pr.commits.totalCount,
    labels: pr.labels.nodes.map((label: any) => ({
      name: label.name,
      color: label.color,
    })),
    user: pr.author
      ? {
          login: pr.author.login,
          avatar_url: pr.author.avatarUrl,
        }
      : null,
    assignee:
      pr.assignees.nodes.length > 0
        ? {
            login: pr.assignees.nodes[0].login,
            avatar_url: pr.assignees.nodes[0].avatarUrl,
          }
        : null,
    assignees: pr.assignees.nodes.map((a: any) => ({
      login: a.login,
      avatar_url: a.avatarUrl,
    })),
    reviewers: reviewers,
    head: { ref: pr.headRefName },
    base: { ref: pr.baseRefName, repo: pr.repository },
    repository_url: pr.repository
      ? `https://api.github.com/repos/${pr.repository.nameWithOwner}`
      : undefined,
    linked_issue_numbers: linkedIssues,
  };
}

export class UserHandler {
  private deps: HandlerDependencies;
  private chatService: any | null;
  private tasksCache: Map<string, { data: any; timestamp: number }> = new Map();
  private TASKS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

  constructor(deps: HandlerDependencies, chatService: any | null) {
    this.deps = deps;
    this.chatService = chatService;
  }

  /**
   * GET /api/user/profile
   */
  async handleGetUserProfile(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.session.userEmail!;
      const userOctokit = this.deps.getUserOctokit(userId);

      const { data: profile } = await userOctokit.users.getAuthenticated();

      res.json({ profile });
    } catch (error: any) {
      console.error('Error fetching user profile:', error);
      if (error.status === 401) {
        req.session?.destroy?.((err) => {
          if (err) console.error('Error destroying session:', err);
        });
        res.status(401).json({ error: 'GitHub token expired. Please log in again.' });
        return;
      }
      res
        .status(error.status || 500)
        .json({ error: error.message || 'Failed to fetch user profile' });
    }
  }

  /**
   * GET /api/user/organizations
   */
  async handleGetUserOrganizations(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.session.userEmail!;
      const userOctokit = this.deps.getUserOctokit(userId);

      const { data: orgs } = await userOctokit.orgs.listForAuthenticatedUser();

      const organizations = orgs.map((org) => ({
        login: org.login,
        id: org.id,
        avatar_url: org.avatar_url,
        description: org.description || null,
      }));

      res.json({ organizations });
    } catch (error: any) {
      console.error('Error fetching user organizations:', error);
      if (error.status === 401) {
        req.session?.destroy?.((err) => {
          if (err) console.error('Error destroying session:', err);
        });
        res.status(401).json({ error: 'GitHub token expired. Please log in again.' });
        return;
      }
      res
        .status(error.status || 500)
        .json({ error: error.message || 'Failed to fetch organizations' });
    }
  }

  /**
   * GET /api/repos/:owner/:repo/collaborators
   */
  async handleGetCollaborators(req: Request, res: Response): Promise<void> {
    const { owner, repo } = req.params as { owner: string; repo: string };

    try {
      const userId = req.session.userEmail!;
      const userOctokit = this.deps.getUserOctokit(userId);

      try {
        const { data: collaborators } = await userOctokit.repos.listCollaborators({
          owner,
          repo,
          per_page: 100,
        });

        const logins = collaborators.map((c: any) => c.login);
        const teamMembers = await fetchUserDisplayNames(userOctokit, logins);

        res.json({ team_members: teamMembers });
      } catch (collabError: any) {
        if (collabError.status === 403 || collabError.status === 404) {
          const { data: assignees } = await userOctokit.issues.listAssignees({
            owner,
            repo,
            per_page: 100,
          });

          const logins = assignees.map((a: any) => a.login);
          const teamMembers = await fetchUserDisplayNames(userOctokit, logins);

          res.json({ team_members: teamMembers });
        } else {
          throw collabError;
        }
      }
    } catch (error: any) {
      console.error('[UserHandler] Error fetching collaborators:', error);

      if (this.deps.handleGitHubApiError(error, req, res, req.session?.authToken)) {
        return;
      }

      res.status(500).json({
        error: 'Failed to fetch collaborators',
        team_members: [],
      });
    }
  }

  /**
   * GET /api/user/recent-branches
   */
  async handleGetRecentBranches(req: Request, res: Response): Promise<void> {
    const userId = req.session.userEmail!;

    try {
      const userOctokit = this.deps.getUserOctokit(userId);

      const query = `
        query {
          viewer {
            repositories(first: 10, orderBy: {field: PUSHED_AT, direction: DESC}, ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) {
              nodes {
                nameWithOwner
                refs(refPrefix: "refs/heads/", first: 5, orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) {
                  nodes {
                    name
                    target {
                      ... on Commit {
                        committedDate
                        author {
                          user {
                            login
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const response: any = await userOctokit.graphql(query);
      const recentBranches: any[] = [];

      response.viewer.repositories.nodes.forEach((repo: any) => {
        repo.refs.nodes.forEach((ref: any) => {
          if (ref.target?.committedDate) {
            recentBranches.push({
              repo: repo.nameWithOwner,
              branch: ref.name,
              lastPushDate: ref.target.committedDate,
            });
          }
        });
      });

      recentBranches.sort(
        (a, b) => new Date(b.lastPushDate).getTime() - new Date(a.lastPushDate).getTime()
      );

      res.json(recentBranches.slice(0, 10));
    } catch (error: any) {
      console.error('Error fetching recent branches:', error);
      if (error.status === 401) {
        res.status(401).json({ error: 'GitHub token expired. Please log in again.' });
        return;
      }
      res
        .status(error.status || 500)
        .json({ error: error.message || 'Failed to fetch recent branches' });
    }
  }

  /**
   * GET /api/user/tasks
   */
  async handleGetUserTasks(req: Request, res: Response): Promise<void> {
    return this.handleGetUserTasksRefresh(req, res);
  }

  /**
   * GET /api/user/tasks/cached
   */
  async handleGetUserTasksCached(req: Request, res: Response): Promise<void> {
    const view = (req.query?.view as string) || 'my';
    const blockedOrgs = req.query?.blockedOrgs
      ? (JSON.parse(req.query.blockedOrgs as string) as string[])
      : undefined;
    const cacheKey = `${req.session.userEmail || 'unknown'}_${view}_${blockedOrgs?.sort().join(',') || 'none'}`;

    try {
      const cached = this.tasksCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.TASKS_CACHE_TTL) {
        res.json({ ...cached.data, cached: true, cacheTimestamp: cached.timestamp });
        return;
      }

      const data = await this.fetchUserTasks(req, view, blockedOrgs);

      this.tasksCache.set(cacheKey, { data, timestamp: Date.now() });

      res.json({ ...data, cached: false, cacheTimestamp: Date.now() });
    } catch (error: any) {
      console.error('[UserHandler] Error in handleGetUserTasksCached:', error);
      res.status(500).json({
        error: error.message || 'Failed to fetch tasks',
        open_issues: [],
        closed_today: [],
        prs: [],
        total_open: 0,
        total_closed_today: 0,
        total_prs: 0,
        view,
        cached: false,
      });
    }
  }

  /**
   * GET /api/user/tasks/refresh
   */
  async handleGetUserTasksRefresh(req: Request, res: Response): Promise<void> {
    const requestStartTime = Date.now();

    const view = (req.query?.view as string) || 'my';
    const blockedOrgs = req.query?.blockedOrgs
      ? (JSON.parse(req.query.blockedOrgs as string) as string[])
      : undefined;
    const cacheKey = `${req.session.userEmail || 'unknown'}_${view}_${blockedOrgs?.sort().join(',') || 'none'}`;

    try {
      const data = await this.fetchUserTasks(req, view, blockedOrgs);

      this.tasksCache.set(cacheKey, { data, timestamp: Date.now() });

      res.json({ ...data, cached: false, cacheTimestamp: Date.now() });
    } catch (error: any) {
      const errorDuration = Date.now() - requestStartTime;
      console.error(`[UserHandler] /api/user/tasks/refresh FAILED after ${errorDuration}ms:`, {
        view,
        status: error?.status,
        message: error?.message,
        responseMessage: error?.response?.data?.message,
        code: error?.code,
        name: error?.name,
      });

      if (this.deps.handleGitHubApiError(error, req, res, req.session?.authToken)) {
        return;
      }

      res.status(500).json({
        error: error.message || 'Failed to refresh tasks',
        open_issues: [],
        closed_today: [],
        prs: [],
        total_open: 0,
        total_closed_today: 0,
        total_prs: 0,
        view,
        cached: false,
      });
    }
  }

  /**
   * The `owner/repo` names of the repositories the user has cloned into their
   * sandbox workspace — a fast filesystem scan via GitLocalService (attached to
   * the request by the api-routes middleware). Returns `[]` when nothing is
   * cloned or the service is unavailable (degrades to the "clone a repo"
   * guidance state rather than throwing). Capped at {@link MAX_LOCAL_REPOS}.
   */
  private async getLocalRepoFullNames(req: Request, userId: string): Promise<string[]> {
    const gitLocalService = (req as any).gitLocalService;
    if (!gitLocalService || typeof gitLocalService.getLocalRepositories !== 'function') {
      return [];
    }

    try {
      const repos = await gitLocalService.getLocalRepositories(userId);
      const names = (repos || [])
        .map((r: any) => r?.full_name)
        .filter((name: any): name is string => typeof name === 'string' && name.includes('/'))
        // Drop locally-created projects (owner `local`) — they have no GitHub remote,
        // so GitHub GraphQL can't resolve them and they'd fail the whole tasks query.
        .filter((name: string) => name.split('/')[0] !== LOCAL_PLACEHOLDER_OWNER);
      return names.slice(0, MAX_LOCAL_REPOS);
    } catch (error) {
      console.warn('[UserHandler] Failed to list local repositories for tasks:', error);
      return [];
    }
  }

  /**
   * Private method to fetch user tasks data from GitHub API.
   *
   * Scoped to the user's LOCALLY CLONED repositories: a fast
   * filesystem scan picks the repos, then ONE per-repo GraphQL query fetches
   * their open issues, open PRs, and (assignee-filtered) closed issues. The
   * `my` view keeps only the viewer's assigned issues + authored PRs; the `all`
   * view returns everything in those repos. When no repo is cloned the payload
   * carries `noLocalRepos: true` so the client can prompt the user to clone one.
   */
  private async fetchUserTasks(req: Request, view: string, blockedOrgs?: string[]): Promise<any> {
    const userId = req.session.userEmail!;
    const authToken = req.session.authToken;
    const userOctokit = await this.deps.getOctokitForUser(userId, authToken);

    let user: any;
    try {
      const response = await withGitHubTimeout(() => userOctokit.users.getAuthenticated(), {
        label: 'tasks.users.getAuthenticated',
      });
      user = response.data;
    } catch (error: any) {
      console.error('[UserHandler] GitHub users.getAuthenticated for tasks failed', {
        userId,
        view,
        status: error?.status,
        message: error?.message,
        responseMessage: error?.response?.data?.message,
      });
      throw error;
    }

    const login = user.login;
    const userRef = { login: user.login, avatar_url: user.avatar_url };

    // Scope every query to the repos the user has cloned locally.
    const localRepos = await this.getLocalRepoFullNames(req, userId);

    if (localRepos.length === 0) {
      // Nothing cloned yet — tell the client to guide the user to clone a repo
      // instead of scanning their whole GitHub account.
      return {
        open_issues: [],
        closed_today: [],
        prs: [],
        total_open: 0,
        total_closed_today: 0,
        total_prs: 0,
        user: userRef,
        view,
        noLocalRepos: true,
      };
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const isMyView = view === 'my';
    const query = buildLocalTasksQuery(localRepos, isMyView);

    let graphqlResponse: any;
    try {
      graphqlResponse = await withGitHubRetry(
        () =>
          withGitHubTimeout(() => userOctokit.graphql(query, { login }), {
            label: 'tasks.graphql',
          }),
        { label: 'tasks.graphql' }
      );
    } catch (error: any) {
      // GitHub GraphQL returns PARTIAL data when only SOME of the per-repo aliases
      // fail to resolve (e.g. a cloned repo later deleted/renamed/made-inaccessible
      // on GitHub). Octokit throws a GraphqlResponseError that STILL carries the
      // partial `.data`, so use it — one unresolvable repo must not blank the Tasks
      // page for every other repo. Only bail when there is no data at all.
      if (error?.data) {
        console.warn(
          '[UserHandler] Partial GraphQL response in fetchUserTasks (some repos unresolved):',
          { userId, view, message: error?.message }
        );
        graphqlResponse = error.data;
      } else {
        console.error('[UserHandler] GraphQL error in fetchUserTasks:', {
          userId,
          view,
          status: error?.status,
          message: error?.message,
          responseMessage: error?.response?.data?.message,
        });
        return {
          open_issues: [],
          closed_today: [],
          prs: [],
          total_open: 0,
          total_closed_today: 0,
          total_prs: 0,
          user: userRef,
          view,
          error: error.message || 'GraphQL query failed',
        };
      }
    }

    // Aggregate the per-repo aliases (repo0, repo1, ...).
    const openIssueNodes: any[] = [];
    const prNodes: any[] = [];
    const closedIssueNodes: any[] = [];
    localRepos.forEach((_fullName, index) => {
      const repoData = graphqlResponse[`repo${index}`];
      if (!repoData) return;
      if (repoData.issues?.nodes) openIssueNodes.push(...repoData.issues.nodes);
      if (repoData.pullRequests?.nodes) prNodes.push(...repoData.pullRequests.nodes);
      if (repoData.closedIssues?.nodes) closedIssueNodes.push(...repoData.closedIssues.nodes);
    });

    // Open issues: `my` is already assignee-filtered by the GraphQL query; both
    // views sort newest-first and cap the cross-repo total.
    let openIssuesData = openIssueNodes.filter((issue: any) => issue.updatedAt);
    openIssuesData.sort(
      (a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    openIssuesData = openIssuesData.slice(0, MAX_TASK_ITEMS);
    const openIssues = openIssuesData.map(mapIssueNode);

    // PRs: the `my` view keeps only the viewer's authored PRs (the GraphQL PR
    // connection has no author argument, so filter client-side).
    let pullRequestsData = prNodes.filter((pr: any) => pr.updatedAt);
    if (isMyView) {
      pullRequestsData = pullRequestsData.filter((pr: any) => pr.author?.login === login);
    }
    pullRequestsData.sort(
      (a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    pullRequestsData = pullRequestsData.slice(0, MAX_TASK_ITEMS);
    const prs = pullRequestsData.map(mapPrNode);

    // Done Today: assignee-filtered closed issues whose closedAt is today.
    const closedToday = closedIssueNodes
      .filter((issue: any) => {
        if (!issue.closedAt) return false;
        return new Date(issue.closedAt) >= today;
      })
      .map(mapIssueNode);

    // Filter out blocked organizations if specified.
    const filterByOrg = (items: any[]) => {
      if (!blockedOrgs || blockedOrgs.length === 0) return items;
      return items.filter((item) => {
        const ownerLogin = item.repository?.owner?.login;
        return !ownerLogin || !blockedOrgs.includes(ownerLogin);
      });
    };

    const filteredOpenIssues = filterByOrg(openIssues);
    const filteredClosedToday = filterByOrg(closedToday);
    const filteredPrs = filterByOrg(prs);

    return {
      open_issues: filteredOpenIssues,
      closed_today: filteredClosedToday,
      prs: filteredPrs,
      total_open: filteredOpenIssues.length,
      total_closed_today: filteredClosedToday.length,
      total_prs: filteredPrs.length,
      user: {
        login: graphqlResponse.viewer?.login ?? user.login,
        avatar_url: graphqlResponse.viewer?.avatarUrl ?? user.avatar_url,
      },
      view,
      noLocalRepos: false,
    };
  }

  /**
   * GET /api/user/tasks/stats
   */
  async handleGetUserTaskStats(req: Request, res: Response): Promise<void> {
    const userId = req.session.userEmail!;

    try {
      const userOctokit = this.deps.getUserOctokit(userId);

      const { data: user } = await withGitHubRetry(() => userOctokit.users.getAuthenticated(), {
        label: 'tasks.stats.getAuthenticated',
      });

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayISO = today.toISOString().split('T')[0];

      const openIssuesQuery = `type:issue state:open assignee:${user.login} archived:false`;
      const closedTodayQuery = `type:issue state:closed assignee:${user.login} closed:>=${todayISO} archived:false`;
      const prsQuery = `type:pr author:${user.login} state:open archived:false`;

      // GraphQL search (not the deprecated REST search.issuesAndPullRequests endpoint).
      const countQuery = `
        query CountSearch($q: String!) {
          search(query: $q, type: ISSUE, first: 1) {
            issueCount
          }
        }
      `;
      const searchCount = (q: string): Promise<number> =>
        withGitHubRetry(
          () =>
            withGitHubTimeout(() => userOctokit.graphql(countQuery, { q }), {
              label: 'tasks.count',
            }),
          { label: 'tasks.count' }
        ).then((r: any) => r?.search?.issueCount ?? 0);

      const openCount = await searchCount(openIssuesQuery);
      const closedTodayCount = await searchCount(closedTodayQuery);
      const prsCount = await searchCount(prsQuery);

      res.json({
        open_issues_count: openCount,
        closed_today_count: closedTodayCount,
        prs_count: prsCount,
        total_tasks: openCount + prsCount,
      });
    } catch (error: any) {
      console.error('Error fetching user task stats:', error);
      if (error.status === 401) {
        res.status(401).json({ error: 'GitHub token expired. Please log in again.' });
        return;
      }
      res
        .status(error.status || 500)
        .json({ error: error.message || 'Failed to fetch task stats' });
    }
  }
}
