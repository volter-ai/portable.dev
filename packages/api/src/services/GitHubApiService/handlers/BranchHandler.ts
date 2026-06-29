import { Request, Response } from 'express';

import { HandlerDependencies } from '../types.js';

export class BranchHandler {
  private deps: HandlerDependencies;

  constructor(deps: HandlerDependencies) {
    this.deps = deps;
  }

  /**
   * GET /api/repos/:owner/:repo/branches
   */
  async handleGetBranches(req: Request, res: Response): Promise<void> {
    const { owner, repo } = req.params as { owner: string; repo: string };
    const { page, per_page, search } = req.query;

    const userId = req.session.userEmail!;

    const pageNum = page ? Math.max(1, parseInt(page as string)) : 1;
    const perPageNum = per_page ? Math.min(parseInt(per_page as string), 100) : 10;
    const searchQuery = search ? (search as string) : '';

    try {
      const userOctokit = this.deps.getUserOctokit(userId);

      const graphqlQuery = `
        query GetBranches($owner: String!, $name: String!, $first: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            refs(
              refPrefix: "refs/heads/"
              first: $first
              after: $after
            ) {
              totalCount
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                name
                target {
                  ... on Commit {
                    oid
                    committedDate
                    messageHeadline
                    author {
                      name
                      avatarUrl
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
      `;

      let allNodes: any[] = [];
      let hasNextPage = true;
      let cursor: string | undefined = undefined;

      while (hasNextPage) {
        const result: any = await userOctokit.graphql(graphqlQuery, {
          owner,
          name: repo,
          first: 100,
          after: cursor,
        });

        allNodes = allNodes.concat(result.repository.refs.nodes);
        hasNextPage = result.repository.refs.pageInfo.hasNextPage;
        cursor = result.repository.refs.pageInfo.endCursor;
      }

      let allBranches = allNodes.map((node: any) => ({
        name: node.name,
        sha: node.target.oid,
        protected: false,
        lastCommitDate: node.target.committedDate,
        lastCommitMessage: node.target.messageHeadline,
        lastCommitAuthor: node.target.author?.name || 'Unknown',
        author: {
          login: node.target.author?.user?.login || node.target.author?.name || 'Unknown',
          avatar_url: node.target.author?.avatarUrl || '',
          html_url: node.target.author?.user?.login
            ? `https://github.com/${node.target.author.user.login}`
            : '',
        },
        commit: {
          sha: node.target.oid,
          commit: {
            author: {
              name: node.target.author?.name,
              date: node.target.committedDate,
            },
          },
        },
      }));

      if (searchQuery) {
        const lowerSearch = searchQuery.toLowerCase();
        allBranches = allBranches.filter((branch: any) =>
          branch.name.toLowerCase().includes(lowerSearch)
        );
      }

      allBranches.sort(
        (a: any, b: any) =>
          new Date(b.lastCommitDate).getTime() - new Date(a.lastCommitDate).getTime()
      );

      const totalCount = allBranches.length;

      const startIndex = (pageNum - 1) * perPageNum;
      const endIndex = startIndex + perPageNum;
      const paginatedBranches = allBranches.slice(startIndex, endIndex);
      const hasMore = endIndex < totalCount;

      res.json({
        branches: paginatedBranches,
        count_on_page: paginatedBranches.length,
        total_count: totalCount,
        has_more_pages: hasMore,
        per_page: perPageNum,
      });
    } catch (error: any) {
      console.error(`[BranchHandler] Error fetching branches for ${owner}/${repo}:`, error);
      if (error.status === 401) {
        req.session?.destroy?.((err) => {
          if (err) console.error('Error destroying session:', err);
        });
        res.status(401).json({ error: 'GitHub token expired. Please log in again.' });
        return;
      }
      res.status(error.status || 500).json({ error: error.message || 'Failed to fetch branches' });
    }
  }

  /**
   * GET /api/repos/:owner/:repo/commits/:branch
   */
  async handleGetCommits(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.session.userEmail!;
      const userOctokit = this.deps.getUserOctokit(userId);
      const { owner, repo, branch } = req.params as { owner: string; repo: string; branch: string };
      const { data } = await userOctokit.repos.listCommits({
        owner,
        repo,
        sha: branch,
        per_page: 50,
      });
      res.json(data);
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
}
