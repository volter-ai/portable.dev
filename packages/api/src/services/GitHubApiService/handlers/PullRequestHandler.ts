import { exec } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';

import { Octokit } from '@octokit/rest';
import { Request, Response } from 'express';

import { HandlerDependencies } from '../types.js';
import { extractLinkedIssues, withGitHubRetry } from '../utils/GitHubUtils.js';
import { resolveRepoLocalPath } from '../utils/repoPathResolver.js';

const execAsync = promisify(exec);

export class PullRequestHandler {
  private deps: HandlerDependencies;

  constructor(deps: HandlerDependencies) {
    this.deps = deps;
  }

  /**
   * GET /api/repos/:owner/:repo/pulls
   */
  async handleGetPulls(req: Request, res: Response): Promise<void> {
    const userId = req.session.userEmail!;
    const { owner, repo } = req.params as { owner: string; repo: string };
    const { state, page, per_page, sort, direction } = req.query;

    try {
      const userOctokit = this.deps.getUserOctokit(userId);

      const pageNum = parseInt(page as string) || 1;
      const perPageNum = Math.min(parseInt(per_page as string) || 10, 100);

      const normalizedState = (state as 'open' | 'closed' | 'all') || 'open';

      const pullsResponse = await withGitHubRetry(
        () =>
          userOctokit.pulls.list({
            owner,
            repo,
            state: normalizedState,
            sort: (sort as 'created' | 'updated' | 'popularity' | 'long-running') || 'created',
            direction: (direction as 'asc' | 'desc') || 'desc',
            per_page: perPageNum,
            page: pageNum,
          }),
        { label: 'pulls.list' }
      );

      const pulls = pullsResponse.data;

      const { data: repoInfo } = await userOctokit.repos.get({
        owner,
        repo,
      });
      const defaultBranch = repoInfo.default_branch;

      let canCreatePR = false;
      let commitsAhead = 0;
      let currentBranch = '';
      let upstreamBranch: string | null = null;

      // rev9 D27: flat-clone aware local path (canonical fallback) so a flat checkout
      // still reports canCreatePR / commitsAhead instead of silently losing the block.
      const localPath = await resolveRepoLocalPath(
        (req as any).gitLocalService,
        userId,
        owner,
        repo
      );

      try {
        await fs.access(path.join(localPath, '.git'));

        try {
          const { stdout: branch } = await execAsync('git branch --show-current', {
            cwd: localPath,
          });
          currentBranch = branch.trim();
        } catch (err) {
          console.debug(
            `[PullRequestHandler] Could not get current branch for ${owner}/${repo}:`,
            err
          );
        }

        if (currentBranch) {
          try {
            const { stdout: upstream } = await execAsync(
              `git rev-parse --abbrev-ref ${currentBranch}@{upstream}`,
              { cwd: localPath }
            );
            upstreamBranch = upstream.trim();
          } catch (err) {
            console.debug(
              `[PullRequestHandler] No upstream branch for ${currentBranch} in ${owner}/${repo}:`,
              err
            );
          }
        }

        if (currentBranch && currentBranch !== defaultBranch) {
          try {
            const { stdout: revList } = await execAsync(
              // POSIX keeps `2>/dev/null` (stderr suppress); Windows (cmd.exe) can't
              // redirect to /dev/null without failing the command, so it runs bare
              // and the try/catch handles a non-zero exit. POSIX behaviour unchanged.
              process.platform === 'win32'
                ? `git rev-list --left-right --count origin/${defaultBranch}...HEAD`
                : `git rev-list --left-right --count origin/${defaultBranch}...HEAD 2>/dev/null`,
              { cwd: localPath }
            );
            const [behind, ahead] = revList.trim().split('\t').map(Number);
            commitsAhead = ahead || 0;
          } catch (err) {
            console.debug(
              `[PullRequestHandler] Failed to compare with origin/${defaultBranch}, trying local comparison:`,
              err
            );
            try {
              const { stdout: localRevList } = await execAsync(
                process.platform === 'win32'
                  ? `git rev-list --count ${defaultBranch}..HEAD`
                  : `git rev-list --count ${defaultBranch}..HEAD 2>/dev/null`,
                { cwd: localPath }
              );
              commitsAhead = parseInt(localRevList.trim()) || 0;
            } catch (localErr) {
              console.warn(
                `[PullRequestHandler] Could not get commit count for ${owner}/${repo}:`,
                localErr
              );
            }
          }

          const existingPR = pulls.find(
            (pr) => pr.head.ref === currentBranch && pr.state === 'open'
          );

          canCreatePR = commitsAhead > 0 && !existingPR;
        }
      } catch (err) {
        console.debug(`[PullRequestHandler] Repository ${owner}/${repo} not cloned locally:`, err);
      }

      let totalCount = pulls.length;
      let hasMore = false;

      try {
        // Exact PR count via GraphQL (core/GraphQL quota), replacing the deprecated
        // REST search.issuesAndPullRequests endpoint.
        totalCount = await this.countRepoPullsGraphql(userOctokit, owner, repo, normalizedState);
        hasMore = pageNum * perPageNum < totalCount;
      } catch (countError) {
        console.warn('[PullRequestHandler] GraphQL PR count failed, using fallback:', countError);
        hasMore = pulls.length === perPageNum;
        if (pageNum === 1) {
          totalCount = pulls.length;
        } else {
          totalCount = (pageNum - 1) * perPageNum + pulls.length;
          if (pulls.length === perPageNum) {
            totalCount += 1;
          }
        }
      }

      res.json({
        pulls,
        canCreatePR,
        commitsAhead,
        currentBranch,
        defaultBranch,
        upstreamBranch,
        totalCount,
        hasMore,
        page: pageNum,
        perPage: perPageNum,
      });
    } catch (error: any) {
      console.error('GitHub API Error:', error);
      if (error.status === 401) {
        req.session?.destroy?.((err) => {
          if (err) console.error('Error destroying session:', err);
        });
        res.status(401).json({ error: 'GitHub token expired. Please log in again.' });
        return;
      }
      res.status(error.status || 500).json({ error: error.message || 'GitHub API request failed' });
    }
  }

  /**
   * Exact pull-request count for a repo via GraphQL, replacing the deprecated
   * REST `search.issuesAndPullRequests` endpoint. REST "closed" includes merged PRs,
   * so it maps to both CLOSED and MERGED GraphQL states.
   */
  private async countRepoPullsGraphql(
    octokit: Octokit,
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all'
  ): Promise<number> {
    const states = state === 'open' ? ['OPEN'] : state === 'closed' ? ['CLOSED', 'MERGED'] : null;

    const statesVarDecl = states ? ', $states: [PullRequestState!]' : '';
    const statesArg = states ? '(states: $states)' : '';

    const query = `
      query CountPulls($owner: String!, $repo: String!${statesVarDecl}) {
        repository(owner: $owner, name: $repo) {
          pullRequests${statesArg} {
            totalCount
          }
        }
      }
    `;

    const variables: Record<string, unknown> = { owner, repo };
    if (states) variables.states = states;

    const response: any = await withGitHubRetry(() => octokit.graphql(query, variables), {
      label: 'pulls.count',
    });

    return response?.repository?.pullRequests?.totalCount ?? 0;
  }

  /**
   * GET /api/repos/:owner/:repo/pulls/:number
   */
  async handleGetPull(req: Request, res: Response): Promise<void> {
    const userId = req.session.userEmail!;
    const { owner, repo, number } = req.params as { owner: string; repo: string; number: string };

    try {
      const userOctokit = this.deps.getUserOctokit(userId);

      const { data: pr } = await userOctokit.pulls.get({
        owner,
        repo,
        pull_number: parseInt(number),
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
        const { data: issueComments } = await userOctokit.issues.listComments({
          owner,
          repo,
          issue_number: parseInt(number),
        });
        const { data: reviewComments } = await userOctokit.pulls.listReviewComments({
          owner,
          repo,
          pull_number: parseInt(number),
        });
        const commentTimeline = issueComments.map((comment: any) => ({
          ...comment,
          event: 'commented',
        }));
        const reviewTimeline = reviewComments.map((comment: any) => ({
          ...comment,
          event: 'reviewed',
        }));
        timeline = [...commentTimeline, ...reviewTimeline].sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );
      }

      const { data: files } = await userOctokit.pulls.listFiles({
        owner,
        repo,
        pull_number: parseInt(number),
      });

      res.json({ pr, timeline, files });
    } catch (error: any) {
      console.error(`Error fetching PR ${owner}/${repo}#${number}:`, error);
      if (error.status === 401) {
        req.session?.destroy?.((err) => {
          if (err) console.error('Error destroying session:', err);
        });
        res.status(401).json({ error: 'GitHub token expired. Please log in again.' });
        return;
      }
      res
        .status(error.status || 500)
        .json({ error: error.message || 'Failed to fetch pull request' });
    }
  }

  /**
   * PUT /api/repos/:owner/:repo/pulls/:number/requested_reviewers
   */
  async handleRequestReviewers(req: Request, res: Response): Promise<void> {
    const userId = req.session.userEmail!;
    const { owner, repo, number } = req.params as { owner: string; repo: string; number: string };
    const { reviewers = [], team_reviewers = [] } = req.body;

    try {
      const userOctokit = this.deps.getUserOctokit(userId);

      const { data } = await userOctokit.pulls.requestReviewers({
        owner,
        repo,
        pull_number: parseInt(number),
        reviewers,
        team_reviewers,
      });

      res.json(data);
    } catch (error: any) {
      console.error(`Error requesting reviewers for ${owner}/${repo}#${number}:`, error);
      res
        .status(error.status || 500)
        .json({ error: error.message || 'Failed to request reviewers' });
    }
  }

  /**
   * DELETE /api/repos/:owner/:repo/pulls/:number/requested_reviewers
   */
  async handleRemoveRequestedReviewers(req: Request, res: Response): Promise<void> {
    const userId = req.session.userEmail!;
    const { owner, repo, number } = req.params as { owner: string; repo: string; number: string };
    const { reviewers = [], team_reviewers = [] } = req.body;

    try {
      const userOctokit = this.deps.getUserOctokit(userId);

      const { data } = await userOctokit.pulls.removeRequestedReviewers({
        owner,
        repo,
        pull_number: parseInt(number),
        reviewers,
        team_reviewers,
      });

      res.json(data);
    } catch (error: any) {
      console.error(`Error removing reviewers from ${owner}/${repo}#${number}:`, error);
      res
        .status(error.status || 500)
        .json({ error: error.message || 'Failed to remove reviewers' });
    }
  }
}
