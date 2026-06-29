import { Octokit } from '@octokit/rest';
import { Request, Response } from 'express';

import { HandlerDependencies } from '../types.js';
import { withGitHubRetry } from '../utils/GitHubUtils.js';

/** GraphQL fields needed to reconstruct the REST-style Issue shape the client consumes. */
const ISSUE_NODE_FIELDS = `
  number
  title
  state
  createdAt
  updatedAt
  closedAt
  body
  url
  comments { totalCount }
  labels(first: 10) { nodes { name color } }
  assignees(first: 5) { nodes { login avatarUrl } }
  author { login avatarUrl }
  milestone { title dueOn }
`;

/** Map a GraphQL issue node to the REST-style Issue object the client expects. */
function mapGraphqlIssueNode(node: any): any {
  return {
    id: node.number,
    number: node.number,
    title: node.title,
    state: typeof node.state === 'string' ? node.state.toLowerCase() : node.state,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    closed_at: node.closedAt ?? null,
    body: node.body ?? null,
    html_url: node.url,
    comments: node.comments?.totalCount ?? 0,
    labels: (node.labels?.nodes ?? []).map((label: any) => ({
      name: label.name,
      color: label.color,
    })),
    assignees: (node.assignees?.nodes ?? []).map((a: any) => ({
      login: a.login,
      avatar_url: a.avatarUrl,
    })),
    assignee:
      node.assignees?.nodes?.length > 0
        ? { login: node.assignees.nodes[0].login, avatar_url: node.assignees.nodes[0].avatarUrl }
        : null,
    user: node.author ? { login: node.author.login, avatar_url: node.author.avatarUrl } : null,
    milestone: node.milestone
      ? { title: node.milestone.title, due_on: node.milestone.dueOn }
      : null,
  };
}

export class IssueHandler {
  private deps: HandlerDependencies;

  constructor(deps: HandlerDependencies) {
    this.deps = deps;
  }

  /**
   * GET /api/repos/:owner/:repo/issues
   */
  async handleGetIssues(req: Request, res: Response): Promise<void> {
    const { owner, repo } = req.params as { owner: string; repo: string };
    const { state, text, ids, labels, assignee, sort, direction, per_page, page } = req.query;

    const userId = req.session.userEmail!;

    try {
      const userOctokit = this.deps.getUserOctokit(userId);
      const pageNum = page ? Math.max(1, parseInt(page as string)) : 1;
      const perPageNum = per_page ? Math.min(parseInt(per_page as string), 100) : 10;

      let issues: any[];
      let totalCount: number;

      if (ids && typeof ids === 'string') {
        const issueIds = ids
          .split(',')
          .map((id) => parseInt(id.trim()))
          .filter((id) => !isNaN(id));
        const issuePromises = issueIds.map((issueNumber) =>
          userOctokit.issues
            .get({
              owner,
              repo,
              issue_number: issueNumber,
            })
            .then((response) => response.data)
            .catch(() => null)
        );
        const fetchedIssues = await Promise.all(issuePromises);
        issues = fetchedIssues.filter(
          (issue): issue is any => issue !== null && !issue.pull_request
        );

        if (state && state !== 'all') {
          issues = issues.filter((issue) => issue.state === state);
        }

        totalCount = issues.length;
      } else {
        const labelArray =
          labels && typeof labels === 'string'
            ? labels
                .split(',')
                .map((l) => l.trim())
                .filter(Boolean)
            : [];
        const assigneeFilter = assignee && typeof assignee === 'string' ? assignee : undefined;

        if (text && typeof text === 'string' && text.trim()) {
          // Free-text title search -> GraphQL search (NOT the deprecated REST search endpoint).
          const result = await this.searchIssuesGraphql(userOctokit, {
            owner,
            repo,
            text: text.trim(),
            state: typeof state === 'string' ? state : undefined,
            labels: labelArray,
            assignee: assigneeFilter,
            sort: typeof sort === 'string' ? sort : undefined,
            direction: typeof direction === 'string' ? direction : undefined,
            perPage: perPageNum,
            page: pageNum,
          });
          issues = result.issues;
          totalCount = result.totalCount;
        } else {
          // Default/filter list -> core REST list endpoint (5000/hr quota) for the page,
          // plus a single GraphQL totalCount so pagination/counts stay accurate.
          const normalizedState =
            state === 'open' || state === 'closed' || state === 'all'
              ? (state as 'open' | 'closed' | 'all')
              : 'all';

          const listResponse = await withGitHubRetry(
            () =>
              userOctokit.issues.listForRepo({
                owner,
                repo,
                state: normalizedState,
                labels: labelArray.length > 0 ? labelArray.join(',') : undefined,
                assignee: assigneeFilter,
                sort:
                  sort === 'created' || sort === 'updated' || sort === 'comments'
                    ? sort
                    : 'created',
                direction: direction === 'asc' || direction === 'desc' ? direction : 'desc',
                per_page: perPageNum,
                page: pageNum,
              }),
            { label: 'issues.listForRepo' }
          );

          // listForRepo returns issues AND pull requests; keep only issues.
          issues = listResponse.data.filter((issue: any) => !issue.pull_request);
          totalCount = await this.countRepoIssuesGraphql(userOctokit, {
            owner,
            repo,
            state: normalizedState,
            labels: labelArray,
            assignee: assigneeFilter,
          });
        }
      }

      const hasMore = pageNum * perPageNum < totalCount;

      res.json({
        issues,
        count_on_page: issues.length,
        total_count: totalCount,
        has_more_pages: hasMore,
        per_page: perPageNum,
      });
    } catch (error: any) {
      console.error('[IssueHandler] Error in handleGetIssues:', error);

      if (this.deps.handleGitHubApiError(error, req, res, req.session?.authToken)) {
        return;
      }

      res.status(500).json({ error: 'Failed to fetch issues' });
    }
  }

  /**
   * GET /api/repos/:owner/:repo/labels
   *
   * All labels defined on the repository — powers the Issues-tab label filter
   * (web + mobile RN). A single page of up to 100 covers virtually every repo's
   * label set, so we deliberately don't paginate further (the filter UI shows a
   * flat list of labels with their colors).
   */
  async handleGetLabels(req: Request, res: Response): Promise<void> {
    const { owner, repo } = req.params as { owner: string; repo: string };
    const userId = req.session.userEmail!;

    try {
      const userOctokit = this.deps.getUserOctokit(userId);

      const response = await withGitHubRetry(
        () => userOctokit.issues.listLabelsForRepo({ owner, repo, per_page: 100 }),
        { label: 'issues.listLabelsForRepo' }
      );

      const labels = (response.data ?? []).map((label: any) => ({
        id: label.id,
        name: label.name,
        color: label.color,
        description: label.description ?? null,
      }));

      res.json({ labels });
    } catch (error: any) {
      console.error(`[IssueHandler] Error fetching labels for ${owner}/${repo}:`, error);

      if (this.deps.handleGitHubApiError(error, req, res, req.session?.authToken)) {
        return;
      }

      res.status(500).json({ error: 'Failed to fetch labels' });
    }
  }

  /**
   * Exact issue count for a repo via GraphQL (issues only, excludes PRs).
   * Mirrors the filters applied to the REST list so pagination stays accurate.
   */
  private async countRepoIssuesGraphql(
    octokit: Octokit,
    params: {
      owner: string;
      repo: string;
      state: 'open' | 'closed' | 'all';
      labels: string[];
      assignee?: string;
    }
  ): Promise<number> {
    const { owner, repo, state, labels, assignee } = params;
    const states =
      state === 'open' ? ['OPEN'] : state === 'closed' ? ['CLOSED'] : ['OPEN', 'CLOSED'];

    const filterByClause = assignee ? ', filterBy: { assignee: $assignee }' : '';
    const assigneeVarDecl = assignee ? ', $assignee: String' : '';

    const query = `
      query CountIssues($owner: String!, $repo: String!, $states: [IssueState!], $labels: [String!]${assigneeVarDecl}) {
        repository(owner: $owner, name: $repo) {
          issues(states: $states, labels: $labels${filterByClause}) {
            totalCount
          }
        }
      }
    `;

    const variables: Record<string, unknown> = {
      owner,
      repo,
      states,
      labels: labels.length > 0 ? labels : null,
    };
    if (assignee) variables.assignee = assignee;

    const response: any = await withGitHubRetry(() => octokit.graphql(query, variables), {
      label: 'issues.count',
    });

    return response?.repository?.issues?.totalCount ?? 0;
  }

  /**
   * Free-text issue title search via GraphQL `search` (type: ISSUE).
   * Replaces the deprecated REST `search.issuesAndPullRequests` endpoint.
   */
  private async searchIssuesGraphql(
    octokit: Octokit,
    params: {
      owner: string;
      repo: string;
      text: string;
      state?: string;
      labels: string[];
      assignee?: string;
      sort?: string;
      direction?: string;
      perPage: number;
      page: number;
    }
  ): Promise<{ issues: any[]; totalCount: number }> {
    const { owner, repo, text, state, labels, assignee, sort, direction, perPage, page } = params;

    const stateFilter = state && state !== 'all' ? state : 'open';
    const sortField = sort === 'updated' ? 'updated' : sort === 'comments' ? 'comments' : 'created';
    const sortDir = direction === 'asc' ? 'asc' : 'desc';

    let q = `repo:${owner}/${repo} type:issue state:${stateFilter} ${text} in:title`;
    for (const label of labels) q += ` label:"${label}"`;
    if (assignee) q += ` assignee:${assignee}`;
    q += ` sort:${sortField}-${sortDir}`;

    // GraphQL search uses cursor pagination; over-fetch then slice to honor page-based UI.
    const first = Math.min(page * perPage, 100);
    const query = `
      query SearchIssues($q: String!, $first: Int!) {
        search(query: $q, type: ISSUE, first: $first) {
          issueCount
          nodes {
            ... on Issue {
              ${ISSUE_NODE_FIELDS}
            }
          }
        }
      }
    `;

    const response: any = await withGitHubRetry(() => octokit.graphql(query, { q, first }), {
      label: 'issues.search',
    });

    const allNodes: any[] = response?.search?.nodes ?? [];
    const start = (page - 1) * perPage;
    const pageNodes = allNodes.slice(start, start + perPage);

    return {
      issues: pageNodes.map(mapGraphqlIssueNode),
      totalCount: response?.search?.issueCount ?? pageNodes.length,
    };
  }

  /**
   * GET /api/repos/:owner/:repo/issues/:number
   */
  async handleGetIssue(req: Request, res: Response): Promise<void> {
    const userId = req.session.userEmail!;
    const { owner, repo, number } = req.params as { owner: string; repo: string; number: string };

    try {
      const userOctokit = this.deps.getUserOctokit(userId);

      const { data: issue } = await userOctokit.issues.get({
        owner,
        repo,
        issue_number: parseInt(number),
      });

      let timeline = [];
      try {
        timeline = await userOctokit.paginate(userOctokit.rest.issues.listEventsForTimeline, {
          owner,
          repo,
          issue_number: parseInt(number),
          per_page: 100,
        });
      } catch (timelineError: any) {
        const { data: comments } = await userOctokit.issues.listComments({
          owner,
          repo,
          issue_number: parseInt(number),
        });
        timeline = comments.map((comment: any) => ({
          ...comment,
          event: 'commented',
        }));
      }

      res.json({ issue, timeline });
    } catch (error: any) {
      console.error(`Error fetching issue ${owner}/${repo}#${number}:`, error);
      if (error.status === 401) {
        req.session?.destroy?.((err) => {
          if (err) console.error('Error destroying session:', err);
        });
        res.status(401).json({ error: 'GitHub token expired. Please log in again.' });
        return;
      }
      res.status(error.status || 500).json({ error: error.message || 'Failed to fetch issue' });
    }
  }

  /**
   * POST /api/repos/:owner/:repo/issues/:number/comments
   */
  async handleCreateComment(req: Request, res: Response): Promise<void> {
    const userId = req.session.userEmail!;
    const { owner, repo, number } = req.params as { owner: string; repo: string; number: string };
    const { body } = req.body;

    if (!body || !body.trim()) {
      res.status(400).json({ error: 'Comment body is required' });
      return;
    }

    try {
      const userOctokit = this.deps.getUserOctokit(userId);

      const { data: comment } = await userOctokit.issues.createComment({
        owner,
        repo,
        issue_number: parseInt(number),
        body: body.trim(),
      });

      res.json({ success: true, comment });
    } catch (error: any) {
      console.error(`Error creating comment on issue ${owner}/${repo}#${number}:`, error);

      if (error.status === 404) {
        res.status(404).json({ error: 'Issue not found' });
        return;
      }
      if (error.status === 403) {
        res
          .status(403)
          .json({ error: 'Permission denied. You need write access to comment on issues.' });
        return;
      }
      if (error.status === 401) {
        req.session?.destroy?.((err) => {
          if (err) console.error('Error destroying session:', err);
        });
        res.status(401).json({ error: 'GitHub token expired. Please log in again.' });
        return;
      }

      res.status(error.status || 500).json({ error: error.message || 'Failed to create comment' });
    }
  }

  /**
   * PATCH /api/repos/:owner/:repo/issues/:number
   */
  async handleUpdateIssue(req: Request, res: Response): Promise<void> {
    const userId = req.session.userEmail!;
    const { owner, repo, number } = req.params as { owner: string; repo: string; number: string };
    const updateData = req.body;

    try {
      const userOctokit = this.deps.getUserOctokit(userId);

      const { data: updatedIssue } = await userOctokit.issues.update({
        owner,
        repo,
        issue_number: parseInt(number),
        ...updateData,
      });

      res.json(updatedIssue);
    } catch (error: any) {
      console.error(`Error updating issue ${owner}/${repo}#${number}:`, error);

      if (error.status === 404) {
        res.status(404).json({ error: 'Issue not found' });
        return;
      }
      if (error.status === 403) {
        res
          .status(403)
          .json({ error: 'Permission denied. You need write access to update issues.' });
        return;
      }
      if (error.status === 401) {
        req.session?.destroy?.((err) => {
          if (err) console.error('Error destroying session:', err);
        });
        res.status(401).json({ error: 'GitHub token expired. Please log in again.' });
        return;
      }

      res.status(error.status || 500).json({ error: error.message || 'Failed to update issue' });
    }
  }

  /**
   * PUT /api/repos/:owner/:repo/issues/:number/assignees
   */
  async handleAddAssignees(req: Request, res: Response): Promise<void> {
    const userId = req.session.userEmail!;
    const { owner, repo, number } = req.params as { owner: string; repo: string; number: string };
    const { assignees } = req.body;

    try {
      const userOctokit = this.deps.getUserOctokit(userId);

      const { data } = await userOctokit.issues.addAssignees({
        owner,
        repo,
        issue_number: parseInt(number),
        assignees,
      });

      res.json(data);
    } catch (error: any) {
      console.error(`Error adding assignees to ${owner}/${repo}#${number}:`, error);
      res.status(error.status || 500).json({ error: error.message || 'Failed to add assignees' });
    }
  }

  /**
   * DELETE /api/repos/:owner/:repo/issues/:number/assignees
   */
  async handleRemoveAssignees(req: Request, res: Response): Promise<void> {
    const userId = req.session.userEmail!;
    const { owner, repo, number } = req.params as { owner: string; repo: string; number: string };
    const { assignees } = req.body;

    try {
      const userOctokit = this.deps.getUserOctokit(userId);

      const { data } = await userOctokit.issues.removeAssignees({
        owner,
        repo,
        issue_number: parseInt(number),
        assignees,
      });

      res.json(data);
    } catch (error: any) {
      console.error(`Error removing assignees from ${owner}/${repo}#${number}:`, error);
      res
        .status(error.status || 500)
        .json({ error: error.message || 'Failed to remove assignees' });
    }
  }
}
