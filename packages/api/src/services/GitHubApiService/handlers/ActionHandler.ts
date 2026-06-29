import { Octokit } from '@octokit/rest';
import { Request, Response } from 'express';

import { HandlerDependencies } from '../types.js';

export class ActionHandler {
  private deps: HandlerDependencies;

  constructor(deps: HandlerDependencies) {
    this.deps = deps;
  }

  /**
   * Validate repository access and write permissions
   */
  private async validateRepositoryAccess(
    octokit: Octokit,
    owner: string,
    repo: string
  ): Promise<{ canWrite: boolean; error?: string; repoData?: any }> {
    try {
      const { data } = await octokit.repos.get({ owner, repo });

      console.log('[ActionHandler] Repository permissions:', {
        owner,
        repo,
        permissions: data.permissions,
        defaultBranch: data.default_branch,
        empty: data.size === 0,
      });

      const canWrite = data.permissions?.push === true || data.permissions?.admin === true;

      if (!canWrite) {
        return {
          canWrite: false,
          error:
            'You do not have write access to this repository. Please check repository permissions.',
        };
      }

      return { canWrite: true, repoData: data };
    } catch (error: any) {
      if (error.status === 404) {
        return {
          canWrite: false,
          error: `Repository ${owner}/${repo} not found or you do not have access to it.`,
        };
      } else if (error.status === 403) {
        return {
          canWrite: false,
          error: 'Access forbidden. Your GitHub token may lack required permissions.',
        };
      } else {
        return {
          canWrite: false,
          error: `Failed to validate repository access: ${error.message}`,
        };
      }
    }
  }

  /**
   * Ensure .github/workflows/ directory exists
   */
  private async ensureWorkflowDirectory(
    octokit: Octokit,
    owner: string,
    repo: string,
    repoData?: any
  ): Promise<void> {
    try {
      if (repoData && (repoData.size === 0 || !repoData.default_branch)) {
        console.log(
          '[ActionHandler] Repository is empty or has no default branch, skipping directory creation'
        );
        return;
      }

      await octokit.repos.getContent({
        owner,
        repo,
        path: '.github/workflows',
      });
      console.log('[ActionHandler] .github/workflows/ directory already exists');
    } catch (error: any) {
      if (error.status === 404) {
        console.log(
          '[ActionHandler] .github/workflows/ directory does not exist yet - will be created automatically'
        );
      } else {
        console.error('[ActionHandler] Error checking .github/workflows/ directory:', {
          status: error.status,
          message: error.message,
        });
        throw error;
      }
    }
  }

  /**
   * GET /api/repos/:owner/:repo/actions/runs
   */
  async handleGetActionsRuns(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.session.userEmail!;
      const userOctokit = this.deps.getUserOctokit(userId);
      const { owner, repo } = req.params as { owner: string; repo: string };

      const page = parseInt((req.query?.page as string) || '1');
      const per_page = Math.min(parseInt((req.query?.per_page as string) || '10'), 100);

      const actor = req.query?.filter_actor as string | undefined;
      const branch = req.query?.filter_branch as string | undefined;
      const event = req.query?.filter_event as string | undefined;
      const status = req.query?.state as string | undefined;

      const params: any = {
        owner,
        repo,
        page,
        per_page,
      };

      if (actor) params.actor = actor;
      if (branch) params.branch = branch;
      if (event) params.event = event;
      if (status && status !== 'all') params.status = status;

      const { data, headers } = await userOctokit.actions.listWorkflowRunsForRepo(params);

      const linkHeader = headers.link || '';
      const hasNextPage = linkHeader.includes('rel="next"');

      res.json({
        runs: data.workflow_runs,
        total_count: data.total_count,
        page,
        per_page,
        has_more_pages: hasNextPage,
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
   * GET /api/repos/:owner/:repo/actions/runs/:runId
   */
  async handleGetWorkflowRun(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.session.userEmail!;
      const userOctokit = this.deps.getUserOctokit(userId);
      const { owner, repo, runId } = req.params as { owner: string; repo: string; runId: string };

      const { data: run } = await userOctokit.actions.getWorkflowRun({
        owner,
        repo,
        run_id: parseInt(runId),
      });

      const { data: jobsData } = await userOctokit.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: parseInt(runId),
      });

      const jobs = jobsData.jobs.map((job: any) => ({
        id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        started_at: job.started_at,
        completed_at: job.completed_at,
        html_url: job.html_url,
        steps: job.steps,
      }));

      res.json({ run, jobs });
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
   * List all workflows in a repository
   */
  async listWorkflows(req: Request, res: Response): Promise<void> {
    const { owner, repo } = req.params as { owner: string; repo: string };

    if (!owner || !repo) {
      res.status(400).json({ error: 'Owner and repo are required' });
      return;
    }

    try {
      const userId = req.session.userEmail!;
      const octokit = this.deps.getUserOctokit(userId);

      const { data } = await octokit.actions.listRepoWorkflows({
        owner,
        repo,
      });

      res.json(data);
    } catch (error: any) {
      console.error('[ActionHandler] listWorkflows error:', error);
      res.status(error.status || 500).json({
        error: 'Failed to list workflows',
        details: error.message,
      });
    }
  }

  /**
   * Get workflow file content
   */
  async getWorkflowFile(req: Request, res: Response): Promise<void> {
    const { owner, repo } = req.params as { owner: string; repo: string };
    const { path } = req.query;

    if (!owner || !repo || !path) {
      res.status(400).json({ error: 'Owner, repo, and path are required' });
      return;
    }

    try {
      const userId = req.session.userEmail!;
      const octokit = this.deps.getUserOctokit(userId);

      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: path as string,
      });

      if ('content' in data && data.type === 'file') {
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        res.json({
          content,
          sha: data.sha,
          path: data.path,
        });
      } else {
        res.status(400).json({ error: 'Path does not point to a file' });
      }
    } catch (error: any) {
      console.error('[ActionHandler] getWorkflowFile error:', error);

      if (error.status === 401) {
        res.status(401).json({
          error: 'Authentication failed',
          details: 'GitHub token expired. Please log in again.',
        });
      } else if (error.status === 403) {
        res.status(403).json({
          error: 'Permission denied',
          details: 'You do not have permission to access this repository.',
        });
      } else if (error.status === 404) {
        res.status(404).json({
          error: 'Not found',
          details:
            'Workflow file not found. The file may not exist or the repository may be inaccessible.',
        });
      } else {
        res.status(error.status || 500).json({
          error: 'Failed to get workflow file',
          details: error.message,
        });
      }
    }
  }

  /**
   * Create workflow file
   */
  async createWorkflowFile(req: Request, res: Response): Promise<void> {
    const { owner, repo } = req.params as { owner: string; repo: string };
    const { path, content, message } = req.body;

    if (!owner || !repo || !path || !content) {
      res.status(400).json({ error: 'Owner, repo, path, and content are required' });
      return;
    }

    try {
      const userId = req.session.userEmail!;
      const octokit = this.deps.getUserOctokit(userId);

      try {
        const { headers } = await octokit.request('GET /user');
        console.log('[ActionHandler] GitHub token scopes:', headers['x-oauth-scopes']);
      } catch (scopeError) {
        console.warn('[ActionHandler] Could not check token scopes:', scopeError);
      }

      const validation = await this.validateRepositoryAccess(octokit, owner, repo);
      if (!validation.canWrite) {
        res.status(403).json({
          error: 'Repository access denied',
          details: validation.error,
        });
        return;
      }

      await this.ensureWorkflowDirectory(octokit, owner, repo, validation.repoData);

      const branch = validation.repoData?.default_branch || 'main';
      const createParams = {
        owner,
        repo,
        path,
        message: message || `Create workflow: ${path}`,
        content: Buffer.from(content).toString('base64'),
        branch,
      };
      console.log(`[ActionHandler] Creating workflow file with params:`, {
        owner: createParams.owner,
        repo: createParams.repo,
        path: createParams.path,
        branch: createParams.branch,
        contentLength: createParams.content.length,
      });
      const { data } = await octokit.repos.createOrUpdateFileContents(createParams);

      res.json(data);
    } catch (error: any) {
      console.error('[ActionHandler] createWorkflowFile error:', {
        status: error.status,
        message: error.message,
        responseData: error.response?.data,
        url: error.response?.url,
        headers: error.response?.headers,
      });

      if (error.status === 401) {
        res.status(401).json({
          error: 'Authentication failed',
          details: 'GitHub token expired. Please log in again.',
        });
      } else if (error.status === 403) {
        res.status(403).json({
          error: 'Permission denied',
          details: 'You do not have permission to create files in this repository.',
        });
      } else if (error.status === 404) {
        res.status(404).json({
          error: 'Not found',
          details: 'Repository or path not found even after directory creation.',
        });
      } else if (error.status === 409) {
        res.status(409).json({
          error: 'Conflict',
          details: 'A file already exists at this path. Use update instead.',
        });
      } else {
        res.status(error.status || 500).json({
          error: 'Failed to create workflow file',
          details: error.message,
        });
      }
    }
  }

  /**
   * Update workflow file
   */
  async updateWorkflowFile(req: Request, res: Response): Promise<void> {
    const { owner, repo } = req.params as { owner: string; repo: string };
    const { path, content, sha, message } = req.body;

    if (!owner || !repo || !path || !content || !sha) {
      res.status(400).json({ error: 'Owner, repo, path, content, and sha are required' });
      return;
    }

    try {
      const userId = req.session.userEmail!;
      const octokit = this.deps.getUserOctokit(userId);

      const validation = await this.validateRepositoryAccess(octokit, owner, repo);
      if (!validation.canWrite) {
        res.status(403).json({
          error: 'Repository access denied',
          details: validation.error,
        });
        return;
      }

      const branch = validation.repoData?.default_branch || 'main';
      console.log(`[ActionHandler] Updating workflow file on branch: ${branch}`);
      const { data } = await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message: message || `Update workflow: ${path}`,
        content: Buffer.from(content).toString('base64'),
        sha,
        branch,
      });

      res.json(data);
    } catch (error: any) {
      console.error('[ActionHandler] updateWorkflowFile error:', error);

      if (error.status === 401) {
        res.status(401).json({
          error: 'Authentication failed',
          details: 'GitHub token expired. Please log in again.',
        });
      } else if (error.status === 403) {
        res.status(403).json({
          error: 'Permission denied',
          details: 'You do not have permission to update files in this repository.',
        });
      } else if (error.status === 404) {
        res.status(404).json({
          error: 'Not found',
          details: 'Workflow file not found. It may have been deleted.',
        });
      } else if (error.status === 409) {
        res.status(409).json({
          error: 'Conflict',
          details: 'File SHA mismatch. The file was modified. Please refresh and try again.',
        });
      } else {
        res.status(error.status || 500).json({
          error: 'Failed to update workflow file',
          details: error.message,
        });
      }
    }
  }

  /**
   * Delete workflow file
   */
  async deleteWorkflowFile(req: Request, res: Response): Promise<void> {
    const { owner, repo } = req.params as { owner: string; repo: string };
    const { path, sha, message } = req.body;

    if (!owner || !repo || !path || !sha) {
      res.status(400).json({ error: 'Owner, repo, path, and sha are required' });
      return;
    }

    try {
      const userId = req.session.userEmail!;
      const octokit = this.deps.getUserOctokit(userId);

      const validation = await this.validateRepositoryAccess(octokit, owner, repo);
      if (!validation.canWrite) {
        res.status(403).json({
          error: 'Repository access denied',
          details: validation.error,
        });
        return;
      }

      const { data } = await octokit.repos.deleteFile({
        owner,
        repo,
        path,
        message: message || `Delete workflow: ${path}`,
        sha,
      });

      res.json(data);
    } catch (error: any) {
      console.error('[ActionHandler] deleteWorkflowFile error:', error);

      if (error.status === 401) {
        res.status(401).json({
          error: 'Authentication failed',
          details: 'GitHub token expired. Please log in again.',
        });
      } else if (error.status === 403) {
        res.status(403).json({
          error: 'Permission denied',
          details: 'You do not have permission to delete files in this repository.',
        });
      } else if (error.status === 404) {
        res.status(404).json({
          error: 'Not found',
          details: 'Workflow file not found. It may have been already deleted.',
        });
      } else if (error.status === 409) {
        res.status(409).json({
          error: 'Conflict',
          details: 'File SHA mismatch. The file was modified. Please refresh and try again.',
        });
      } else {
        res.status(error.status || 500).json({
          error: 'Failed to delete workflow file',
          details: error.message,
        });
      }
    }
  }

  /**
   * Trigger workflow dispatch (manual run)
   */
  async triggerWorkflowDispatch(req: Request, res: Response): Promise<void> {
    const { owner, repo, workflow_id } = req.params as {
      owner: string;
      repo: string;
      workflow_id: string;
    };
    const { ref, inputs } = req.body;

    if (!owner || !repo || !workflow_id) {
      res.status(400).json({ error: 'Owner, repo, and workflow_id are required' });
      return;
    }

    try {
      const userId = req.session.userEmail!;
      const octokit = this.deps.getUserOctokit(userId);

      await octokit.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id,
        ref: ref || 'main',
        inputs: inputs || {},
      });

      res.json({ success: true, message: 'Workflow triggered' });
    } catch (error: any) {
      console.error('[ActionHandler] triggerWorkflowDispatch error:', error);
      res.status(error.status || 500).json({
        error: 'Failed to trigger workflow',
        details: error.message,
      });
    }
  }

  /**
   * List workflow runs
   */
  async listWorkflowRuns(req: Request, res: Response): Promise<void> {
    const { owner, repo, workflow_id } = req.params as {
      owner: string;
      repo: string;
      workflow_id: string;
    };
    const { per_page = 10, page = 1 } = req.query;

    if (!owner || !repo || !workflow_id) {
      res.status(400).json({ error: 'Owner, repo, and workflow_id are required' });
      return;
    }

    try {
      const userId = req.session.userEmail!;
      const octokit = this.deps.getUserOctokit(userId);

      const { data } = await octokit.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id,
        per_page: parseInt(per_page as string),
        page: parseInt(page as string),
      });

      res.json(data);
    } catch (error: any) {
      console.error('[ActionHandler] listWorkflowRuns error:', error);
      res.status(error.status || 500).json({
        error: 'Failed to list workflow runs',
        details: error.message,
      });
    }
  }

  /**
   * Create or update repository secret
   */
  async createOrUpdateRepoSecret(req: Request, res: Response): Promise<void> {
    const { owner, repo } = req.params as { owner: string; repo: string };
    const { secret_name, secret_value } = req.body;

    if (!owner || !repo || !secret_name || !secret_value) {
      res.status(400).json({ error: 'Owner, repo, secret_name, and secret_value are required' });
      return;
    }

    try {
      const userId = req.session.userEmail!;
      const octokit = this.deps.getUserOctokit(userId);

      const { data: publicKey } = await octokit.actions.getRepoPublicKey({
        owner,
        repo,
      });

      const sodium = await import('sodium-native');
      const keyBuffer = Buffer.from(publicKey.key, 'base64');
      const messageBuffer = Buffer.from(secret_value, 'utf-8');
      const encryptedBuffer = Buffer.alloc(messageBuffer.length + sodium.crypto_box_SEALBYTES);
      sodium.crypto_box_seal(encryptedBuffer, messageBuffer, keyBuffer);
      const encrypted_value = encryptedBuffer.toString('base64');

      await octokit.actions.createOrUpdateRepoSecret({
        owner,
        repo,
        secret_name,
        encrypted_value,
        key_id: publicKey.key_id,
      });

      res.json({ success: true, message: `Secret ${secret_name} created/updated` });
    } catch (error: any) {
      console.error('[ActionHandler] createOrUpdateRepoSecret error:', error);
      res.status(error.status || 500).json({
        error: 'Failed to create/update repository secret',
        details: error.message,
      });
    }
  }
}
