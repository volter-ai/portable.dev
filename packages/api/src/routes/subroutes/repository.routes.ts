import fs, { promises as fsPromises } from 'fs';
import path from 'path';

import { WORKSPACE_DIR } from '@vgit2/shared/constants';
import { isEffortLevel, getSupportedEffortLevels } from '@vgit2/shared/effort';
import { isModelMode, type ModelMode } from '@vgit2/shared/models';
import { getRepoFromPath } from '@vgit2/shared/utils/pathHelpers';
import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';
import { CommandsService } from '../../services/CommandsService.js';
import { resolveRepoLocalPath } from '../../services/GitHubApiService/utils/repoPathResolver.js';
import { GenerationsTracker } from '../../tools/generations/generationsTracker.js';
import { getAuthToken } from '../utils/route-helpers.js';

import type { AuthService } from '../../services/AuthService.js';
import type { ChatService } from '../../services/ChatService.js';
import type { ConnectionsService } from '../../services/ConnectionsService.js';
import type { GitHubApiService } from '../../services/GitHubApiService.js';
import type { GitLocalService } from '../../services/GitLocalService.js';
import type { SocketIOService } from '../../services/SocketIOService.js';
import type { TunnelService } from '../../services/TunnelService.js';
import type { UploadService } from '../../services/UploadService.js';
import type { VoicePhrasesService } from '../../services/VoicePhrasesService.js';
import type {
  CreateProjectResponse,
  CreateLocalFolderResponse,
  GetRecentProjectsResponse,
  TrackRepoViewResponse,
  GetFileHistoryResponse,
  GetTaskOutputResponse,
  GetGenerationsResponse,
  GetQuickActionsResponse,
  GetChatSettingsResponse,
  GetChatCommandsResponse,
  GenerationType,
  GenerationFilters,
  VoicePhrasesResponse,
} from '@vgit2/shared/types';

/**
 * Repository, project, and GitHub integration routes
 */
export function createRepositoryRoutes(
  githubApiService: GitHubApiService,
  gitLocalService: GitLocalService,
  chatService: ChatService,
  uploadService: UploadService,
  connectionsService: ConnectionsService,
  tunnelService: TunnelService | undefined,
  authService?: AuthService,
  socketIOService?: SocketIOService,
  voicePhrasesService?: VoicePhrasesService
): Router {
  const router = Router();
  // Stateless enumerator for the `/` slash-command picker (shared registry + the
  // repo's `.claude` dirs); reused by the repo-scoped commands route below.
  const commandsService = new CommandsService();

  // Slash commands + skills available in a repo view (the repo Overview "Work on…"
  // input `/` picker). Resolves the repo's local clone path (flat-clone aware;
  // canonical fallback when uncloned → built-ins + global skills still surface).
  router.get('/repos/:owner/:repo/commands', requireAuth, async (req, res) => {
    try {
      if (!req.session.userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const { owner, repo } = req.params;
      const repoPath = await resolveRepoLocalPath(
        gitLocalService,
        req.session.userEmail,
        owner as string,
        repo as string
      );
      const commands = await commandsService.getCommandsForChat(repoPath);
      const response: GetChatCommandsResponse = { commands };
      return res.json(response);
    } catch (error) {
      console.error('[API] GET /repos/:owner/:repo/commands error:', error);
      return res.status(500).json({ error: 'Failed to get commands' });
    }
  });

  // Get recent local projects
  router.get('/projects/recent', requireAuth, async (req, res) => {
    if (!req.session.userEmail) {
      console.log('[API] /api/projects/recent - Not authenticated');
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (req.session.onWaitlist) {
      console.log('[API] /api/projects/recent - User on waitlist, access denied');
      return res.status(403).json({ error: 'Access denied - on waitlist' });
    }

    try {
      const authToken = getAuthToken(req);
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 20);

      // Get repo activity map from database
      const activityMap = await chatService.dbAdapter.getLastChatActivityByRepo(
        req.session.userEmail,
        authToken
      );

      // Convert to array and sort by last activity
      const projects = Array.from(activityMap.entries())
        .map(([repoPath, lastUpdated]) => {
          // Extract project name from path (e.g., ~/workspace/user/owner/repo → repo)
          const parts = repoPath.split('/');
          const projectName = parts[parts.length - 1];
          const owner = parts.length >= 2 ? parts[parts.length - 2] : null;

          return {
            name: projectName,
            path: repoPath,
            owner: owner,
            lastUpdated: parseInt(lastUpdated),
          };
        })
        .sort((a, b) => b.lastUpdated - a.lastUpdated)
        .slice(0, limit);

      console.log(`[API] GET /api/projects/recent → ${projects.length} projects`);
      const response: GetRecentProjectsResponse = { projects };
      res.json(response);
    } catch (error) {
      console.error('[API] GET /api/projects/recent error:', error);
      res.status(500).json({ error: 'Failed to fetch recent projects' });
    }
  });

  // Create new project (explicit project creation endpoint)
  router.post('/projects/create', requireAuth, async (req, res) => {
    console.log('[API] projects/create endpoint called');

    if (!req.session.userEmail) {
      console.log('[API] projects/create: Not authenticated');
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { folderName, framework } = req.body;
    console.log(
      `[API] projects/create: folderName="${folderName}", framework="${framework || 'none'}"`
    );

    if (!folderName) {
      console.log('[API] projects/create: folderName is missing');
      return res.status(400).json({ error: 'folderName is required' });
    }

    try {
      // Get GitHub token from ConnectionsService (tokens no longer in JWT for security)
      const authToken = getAuthToken(req);
      let githubToken = '';
      if (req.session.userEmail && connectionsService) {
        try {
          const activeConnection = await connectionsService.getActiveGitHubConnection(
            req.session.userEmail,
            authToken
          );
          if (activeConnection.type !== 'none' && activeConnection.token) {
            githubToken = activeConnection.token;
          }
        } catch (err) {
          console.warn(
            '[API] projects/create: Could not get GitHub token from ConnectionsService:',
            err
          );
        }
      }

      const result = await gitLocalService.createProject(
        folderName,
        framework || null,
        req.session.userEmail,
        githubToken
      );

      console.log(`[API] ✓ Project created: ${result.owner}/${result.repoName}`);
      const response: CreateProjectResponse = result;
      res.json(response);
    } catch (error) {
      console.error('[API] Error creating project:', error);
      res
        .status(500)
        .json({ error: error instanceof Error ? error.message : 'Failed to create project' });
    }
  });

  // Create local folder only (for simple tasks)
  router.post('/projects/create-local', requireAuth, async (req, res) => {
    console.log('[API] projects/create-local endpoint called');

    if (!req.session.userEmail) {
      console.log('[API] projects/create-local: Not authenticated');
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { folderName } = req.body;
    console.log(`[API] projects/create-local: folderName="${folderName}"`);

    if (!folderName) {
      console.log('[API] projects/create-local: folderName is missing');
      return res.status(400).json({ error: 'folderName is required' });
    }

    // Security: Check for directory traversal attempts
    if (folderName.includes('..') || folderName.includes('/') || folderName.includes('\\')) {
      console.error('[API] projects/create-local: Invalid folder name:', folderName);
      return res.status(400).json({ error: 'Invalid folder name: special characters not allowed' });
    }

    try {
      // Create local folder with git init (but no GitHub repo)
      const result = await gitLocalService.createLocalFolder(folderName, req.session.userEmail);

      console.log(`[API] ✓ Local folder created: ${result.folderPath}`);
      const response: CreateLocalFolderResponse = result;
      res.json(response);
    } catch (error) {
      console.error('[API] Error creating local folder:', error);
      res
        .status(500)
        .json({ error: error instanceof Error ? error.message : 'Failed to create local folder' });
    }
  });

  // File upload
  router.post(
    '/upload',
    requireAuth,
    uploadService.getUploadMiddleware().single('file'),
    async (req, res) => uploadService.handleFileUpload(req, res)
  );

  // Serve uploaded files
  router.get('/uploads/:filename', requireAuth, async (req, res) =>
    uploadService.serveUploadedFile(req, res)
  );

  // Serve workspace files (for AI-generated file:// URLs)
  router.get('/workspace-file', requireAuth, async (req, res) =>
    uploadService.serveWorkspaceFile(req, res)
  );

  // Read task output file content (for background bash processes)
  router.get('/task-output', requireAuth, async (req, res) => {
    const userEmail = req.session?.userEmail;
    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const filePath = req.query.path as string;
    if (!filePath) {
      return res.status(400).json({ error: 'File path required' });
    }

    try {
      const content = await fsPromises.readFile(filePath, 'utf-8');
      const response: GetTaskOutputResponse = { content };
      res.json(response);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        const response: GetTaskOutputResponse = { content: '' }; // File doesn't exist yet
        res.json(response);
      } else {
        console.error('[API] Error reading task output:', error);
        res.status(500).json({ error: 'Failed to read file' });
      }
    }
  });

  // Audio transcription — UNUSED in local-first (speech→text now happens ON-DEVICE in the
  // mobile app via native STT; nothing uploads audio). Returns 501; do NOT add a
  // server-side STT/correction provider here.
  router.post(
    '/transcribe',
    requireAuth,
    uploadService.getUploadMiddleware().single('audio'),
    async (req, res) => uploadService.handleAudioTranscription(req, res)
  );

  // Voice dictation phrases (the on-device recognizer's contextualStrings biasing vocabulary),
  // stored in the PC's portable metadata. The phone fetches them (cached) and busts the cache
  // when one is added.
  router.get('/voice/phrases', requireAuth, (req, res) => {
    if (!req.session.userEmail) return res.status(401).json({ error: 'Not authenticated' });
    if (!voicePhrasesService) {
      const empty: VoicePhrasesResponse = { phrases: [], version: 0 };
      return res.json(empty);
    }
    return res.json(voicePhrasesService.getPhrases());
  });

  router.post('/voice/phrases', requireAuth, (req, res) => {
    if (!req.session.userEmail) return res.status(401).json({ error: 'Not authenticated' });
    const phrase = typeof req.body?.phrase === 'string' ? req.body.phrase : '';
    if (!phrase.trim()) return res.status(400).json({ error: 'phrase is required' });
    if (!voicePhrasesService) {
      const empty: VoicePhrasesResponse = { phrases: [], version: 0 };
      return res.json(empty);
    }
    return res.json(voicePhrasesService.addPhrase(phrase));
  });

  router.delete('/voice/phrases', requireAuth, (req, res) => {
    if (!req.session.userEmail) return res.status(401).json({ error: 'Not authenticated' });
    const phrase = typeof req.body?.phrase === 'string' ? req.body.phrase : '';
    if (!voicePhrasesService) {
      const empty: VoicePhrasesResponse = { phrases: [], version: 0 };
      return res.json(empty);
    }
    return res.json(voicePhrasesService.removePhrase(phrase));
  });

  // GitHub API endpoints
  // Drop this user's in-memory repo caches so a freshly-linked/unlinked local
  // project (junction + repo-views.json written by `portable link`/`unlink`)
  // shows up on the NEXT repos fetch without restarting `portable`. The launcher
  // calls this loopback endpoint best-effort right after a link/unlink.
  router.post('/repos/rescan', requireAuth, async (req, res) =>
    githubApiService.handleRescanRepos(req, res)
  );

  // Repository endpoints with cached + refresh pattern
  router.get('/repos/cached', requireAuth, async (req, res) =>
    githubApiService.handleListReposCached(req, res)
  );
  router.get('/repos/refresh', requireAuth, async (req, res) =>
    githubApiService.handleListReposRefresh(req, res)
  );
  router.post('/repos/git-status', requireAuth, async (req, res) =>
    githubApiService.handleGetGitStatus(req, res)
  );

  // Legacy repos endpoint (kept for backward compatibility)
  router.get('/repos', requireAuth, async (req, res) => {
    // Add timeout to prevent hanging requests
    const timeoutMs = 45000; // 45 seconds
    const timeoutHandle = setTimeout(() => {
      if (!res.headersSent) {
        console.error('[API] /api/repos timeout exceeded (45s)');
        res.status(504).json({
          error: 'Request timeout - the server took too long to respond. Please try again.',
          code: 'GATEWAY_TIMEOUT',
        });
      }
    }, timeoutMs);

    try {
      await githubApiService.handleListRepos(req, res);
    } catch (error) {
      console.error('[API] /api/repos error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to fetch repositories' });
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
  });
  router.get('/repos/:owner/:repo', requireAuth, async (req, res) =>
    githubApiService.handleGetRepo(req, res)
  );
  router.get('/repos/:owner/:repo/tree/*', requireAuth, async (req, res) =>
    githubApiService.handleGetTree(req, res)
  );
  router.get('/repos/:owner/:repo/raw/*', requireAuth, async (req, res) =>
    githubApiService.handleGetRawContent(req, res)
  ); // Raw binary file content (images, videos, PDFs)
  router.get('/repos/:owner/:repo/contents/*', requireAuth, async (req, res) =>
    githubApiService.handleGetContents(req, res)
  );
  router.put('/repos/:owner/:repo/contents/*', requireAuth, async (req, res) =>
    githubApiService.handleUpdateContents(req, res)
  ); // LOCAL file update only
  router.put('/repos/:owner/:repo/github-contents/*', requireAuth, async (req, res) =>
    githubApiService.handleUpdateGitHubContents(req, res)
  ); // GitHub API update (commits to remote)

  // File history endpoint - check if file existed in git history
  router.get('/repos/:owner/:repo/file-history/*', requireAuth, async (req, res) => {
    try {
      if (!req.session.userEmail) {
        res.status(401).json({ error: 'Unauthorized: Please log in' });
        return;
      }

      const { owner, repo } = req.params;
      const filePath = (req.params as Record<string, string>)[0]; // Wildcard path after file-history/
      const userId = req.session.userEmail;

      console.log(`[API] Checking file history for ${owner}/${repo}/${filePath}`);

      const history = await gitLocalService.getFileHistory(
        owner as string,
        repo as string,
        filePath,
        userId
      );

      if (!history) {
        res.status(404).json({ error: 'Repository not cloned locally or git history unavailable' });
        return;
      }

      const response: GetFileHistoryResponse = history;
      res.json(response);
    } catch (error) {
      console.error('[API] Error getting file history:', error);
      res
        .status(500)
        .json({ error: error instanceof Error ? error.message : 'Failed to get file history' });
    }
  });

  router.get('/repos/:owner/:repo/branches', requireAuth, async (req, res) =>
    githubApiService.handleGetBranches(req, res)
  );
  router.get('/repos/:owner/:repo/collaborators', requireAuth, async (req, res) =>
    githubApiService.handleGetCollaborators(req, res)
  );
  router.get('/repos/:owner/:repo/issues', requireAuth, async (req, res) =>
    githubApiService.handleGetIssues(req, res)
  );
  router.get('/repos/:owner/:repo/labels', requireAuth, async (req, res) =>
    githubApiService.handleGetLabels(req, res)
  );
  router.get('/repos/:owner/:repo/actions/runs', requireAuth, async (req, res) =>
    githubApiService.handleGetActionsRuns(req, res)
  );
  router.get('/repos/:owner/:repo/actions/runs/:runId', requireAuth, async (req, res) =>
    githubApiService.handleGetWorkflowRun(req, res)
  );

  // GitHub Actions Workflows & Secrets routes
  router.get('/repos/:owner/:repo/workflows', requireAuth, async (req, res) =>
    githubApiService.listWorkflows(req, res)
  );
  router.get('/repos/:owner/:repo/workflows/file', requireAuth, async (req, res) =>
    githubApiService.getWorkflowFile(req, res)
  );
  router.post('/repos/:owner/:repo/workflows/file', requireAuth, async (req, res) =>
    githubApiService.createWorkflowFile(req, res)
  );
  router.put('/repos/:owner/:repo/workflows/file', requireAuth, async (req, res) =>
    githubApiService.updateWorkflowFile(req, res)
  );
  router.delete('/repos/:owner/:repo/workflows/file', requireAuth, async (req, res) =>
    githubApiService.deleteWorkflowFile(req, res)
  );
  router.post(
    '/repos/:owner/:repo/workflows/:workflow_id/dispatches',
    requireAuth,
    async (req, res) => githubApiService.triggerWorkflowDispatch(req, res)
  );
  router.get('/repos/:owner/:repo/workflows/:workflow_id/runs', requireAuth, async (req, res) =>
    githubApiService.listWorkflowRuns(req, res)
  );
  router.post('/repos/:owner/:repo/secrets', requireAuth, async (req, res) =>
    githubApiService.createOrUpdateRepoSecret(req, res)
  );

  router.get('/repos/:owner/:repo/pulls', requireAuth, async (req, res) =>
    githubApiService.handleGetPulls(req, res)
  );
  router.get('/repos/:owner/:repo/issues/:number', requireAuth, async (req, res) =>
    githubApiService.handleGetIssue(req, res)
  );
  router.post('/repos/:owner/:repo/issues/:number/comments', requireAuth, async (req, res) =>
    githubApiService.handleCreateComment(req, res)
  );
  router.patch('/repos/:owner/:repo/issues/:number', requireAuth, async (req, res) =>
    githubApiService.handleUpdateIssue(req, res)
  );
  router.put('/repos/:owner/:repo/issues/:number/assignees', requireAuth, async (req, res) =>
    githubApiService.handleAddAssignees(req, res)
  );
  router.delete('/repos/:owner/:repo/issues/:number/assignees', requireAuth, async (req, res) =>
    githubApiService.handleRemoveAssignees(req, res)
  );
  router.get('/repos/:owner/:repo/pulls/:number', requireAuth, async (req, res) =>
    githubApiService.handleGetPull(req, res)
  );
  router.put(
    '/repos/:owner/:repo/pulls/:number/requested_reviewers',
    requireAuth,
    async (req, res) => githubApiService.handleRequestReviewers(req, res)
  );
  router.delete(
    '/repos/:owner/:repo/pulls/:number/requested_reviewers',
    requireAuth,
    async (req, res) => githubApiService.handleRemoveRequestedReviewers(req, res)
  );
  router.get('/repos/:owner/:repo/commits/:branch', requireAuth, async (req, res) =>
    githubApiService.handleGetCommits(req, res)
  );

  // Generations endpoint - list AI media generations from .volter/generations.json
  router.get('/repos/:owner/:repo/generations', requireAuth, async (req, res) => {
    try {
      if (!req.session.userEmail) {
        res.status(401).json({ error: 'Unauthorized: Please log in' });
        return;
      }

      const { owner, repo } = req.params;
      const userId = req.session.userEmail;

      // Get query parameters for filtering and pagination
      const name = req.query.name as string | undefined;
      const version = req.query.version as string | undefined;
      const type = req.query.type as string | undefined;
      const model = req.query.model as string | undefined;
      const search = req.query.search as string | undefined;
      const sortBy = (req.query.sort as string) || 'timestamp';
      const sortDirection = (req.query.direction as string) || 'desc';
      const page = parseInt(req.query.page as string) || 1;
      const perPage = parseInt(req.query.per_page as string) || 30;

      // Get local repo path (flat-clone aware; canonical fallback)
      const repoPath = await resolveRepoLocalPath(
        gitLocalService,
        userId,
        owner as string,
        repo as string
      );

      // Check if repo exists locally - return empty array if not (similar to quick-actions)
      if (!fs.existsSync(repoPath)) {
        const emptyResponse: GetGenerationsResponse = {
          generations: [],
          total_count: 0,
          has_more_pages: false,
        };
        res.json(emptyResponse);
        return;
      }

      // Check if .volter/generations.json exists - return empty array if not
      const generationsFilePath = path.join(repoPath, '.volter/generations.json');
      if (!fs.existsSync(generationsFilePath)) {
        const emptyResponse: GetGenerationsResponse = {
          generations: [],
          total_count: 0,
          has_more_pages: false,
        };
        res.json(emptyResponse);
        return;
      }

      // Initialize GenerationsTracker
      const tracker = new GenerationsTracker(repoPath);

      // Build filters
      const filters: GenerationFilters & { limit: number; offset: number } = {
        limit: perPage * 10, // Get more items for filtering/sorting
        offset: 0,
      };

      if (name) filters.name = name;
      if (version) filters.version = version;
      if (type && type !== 'all') filters.type = type as GenerationType;
      if (model) filters.model = model;

      // Get all matching generations
      let generations = tracker.listGenerations(filters);

      // Apply search filter (name or version contains search string)
      if (search) {
        const searchLower = search.toLowerCase();
        generations = generations.filter(
          (g) =>
            g.name.toLowerCase().includes(searchLower) ||
            g.version.toLowerCase().includes(searchLower)
        );
      }

      // Apply sorting
      if (sortBy === 'name') {
        generations.sort((a, b) => {
          const comparison = a.name.localeCompare(b.name);
          return sortDirection === 'asc' ? comparison : -comparison;
        });
      } else if (sortBy === 'version') {
        generations.sort((a, b) => {
          const comparison = a.version.localeCompare(b.version);
          return sortDirection === 'asc' ? comparison : -comparison;
        });
      } else {
        // Default: sort by timestamp (already done by tracker, but respect direction)
        if (sortDirection === 'asc') {
          generations.reverse();
        }
      }

      // Apply pagination
      const totalCount = generations.length;
      const offset = (page - 1) * perPage;
      const paginatedGenerations = generations.slice(offset, offset + perPage);
      const hasMorePages = offset + perPage < totalCount;

      // Normalize output URLs - older data may have arrays instead of strings
      const normalizedGenerations = paginatedGenerations.map((gen) => ({
        ...gen,
        output: {
          ...gen.output,
          url: Array.isArray(gen.output.url) ? gen.output.url[0] || '' : gen.output.url,
          cloudfront_url: Array.isArray(gen.output.cloudfront_url)
            ? gen.output.cloudfront_url[0] || ''
            : gen.output.cloudfront_url,
        },
      }));

      const response: GetGenerationsResponse = {
        generations: normalizedGenerations,
        total_count: totalCount,
        has_more_pages: hasMorePages,
      };
      res.json(response);
    } catch (error) {
      console.error('[API] Error fetching generations:', error);
      res
        .status(500)
        .json({ error: error instanceof Error ? error.message : 'Failed to fetch generations' });
    }
  });

  // Quick actions for a repository
  router.get('/repos/:owner/:repo/quick-actions', requireAuth, async (req, res) => {
    const { owner, repo } = req.params;
    const userEmail = req.session?.userEmail;

    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const repoPath = await resolveRepoLocalPath(
        gitLocalService,
        userEmail,
        owner as string,
        repo as string
      );

      // Check if repo is cloned locally
      if (!fs.existsSync(repoPath)) {
        const response: GetQuickActionsResponse = { quickActions: [] };
        return res.json(response);
      }

      // Get active tunnels for this user/repo (canonical method extracts owner/repo from
      // tunnel paths). `tunnelService` can be absent on the legacy sandbox path (local mode
      // always constructs it), so degrade to "no tunnels" instead of dereferencing
      // undefined and 500ing.
      const userTunnels = tunnelService?.getUserTunnels(userEmail) ?? [];

      // Filter tunnels by extracting owner/repo from the full filesystem path
      const repoTunnels = userTunnels.filter((t) => {
        const tunnelRepo = getRepoFromPath(t.createdByRepoPath, WORKSPACE_DIR);
        return tunnelRepo === `${owner}/${repo}`;
      });

      // Check which tunnels are actually active
      const activeTunnels = [];
      for (const tunnel of repoTunnels) {
        const isActive = tunnelService ? await tunnelService.isPortActive(tunnel.port) : false;
        if (isActive) {
          activeTunnels.push({
            name: tunnel.name,
            port: tunnel.port,
            url: tunnel.url,
            main: tunnel.main,
          });
        }
      }

      // Use the QuickActionsService for intelligent action detection
      const { QuickActionsService } = await import('../../services/QuickActionsService.js');
      const quickActionsService = new QuickActionsService();
      const quickActions = quickActionsService.getQuickActionsForRepo(
        owner as string,
        repo as string,
        repoPath,
        activeTunnels
      );

      const response: GetQuickActionsResponse = { quickActions };
      return res.json(response);
    } catch (error) {
      console.error('[API] Error getting quick actions:', error);
      return res
        .status(500)
        .json({ error: error instanceof Error ? error.message : 'Failed to get quick actions' });
    }
  });

  // Get git status
  router.get('/repos/:owner/:repo/git-status', requireAuth, async (req, res) => {
    const { owner, repo } = req.params;
    const userEmail = req.session?.userEmail;

    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const repoPath = await resolveRepoLocalPath(
        gitLocalService,
        userEmail,
        owner as string,
        repo as string
      );

      // Check if repo exists locally
      if (!fs.existsSync(repoPath)) {
        return res.status(404).json({ error: 'Repository not cloned locally' });
      }

      // `?fresh=1` bypasses the short-TTL cache so post-run change counts are
      // accurate right after the agent modifies files.
      // getRepoStatusSafe bounds the underlying git work and degrades gracefully
      // (stale/zeroed payload) instead of hanging on a large repo.
      const fresh = req.query.fresh === '1';
      const status = await gitLocalService.getRepoStatusSafe(repoPath, {
        bypassCache: fresh,
      });

      return res.json(status);
    } catch (error) {
      console.error('[API] Error getting git status:', error);
      return res
        .status(500)
        .json({ error: error instanceof Error ? error.message : 'Failed to get git status' });
    }
  });

  // Git status with fetch (accurate ahead/behind)
  router.get('/repos/:owner/:repo/git-status-fetch', requireAuth, async (req, res) => {
    const { owner, repo } = req.params;
    const userEmail = req.session?.userEmail;

    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const repoPath = await resolveRepoLocalPath(
        gitLocalService,
        userEmail,
        owner as string,
        repo as string
      );

      // Check if repo exists locally
      if (!fs.existsSync(repoPath)) {
        return res.status(404).json({ error: 'Repository not cloned locally' });
      }

      // Fetch from remote and get updated status (resilient: bounds the fetch +
      // status work and degrades gracefully instead of hanging on a large repo).
      const status = await gitLocalService.getRepoStatusSafe(repoPath, { fetchFirst: true });

      return res.json(status);
    } catch (error) {
      console.error('[API] Error getting git status with fetch:', error);
      return res
        .status(500)
        .json({ error: error instanceof Error ? error.message : 'Failed to get git status' });
    }
  });

  // Track repository view
  router.post('/repos/:owner/:repo/view', requireAuth, async (req, res) => {
    try {
      if (!req.session.userEmail) {
        res.status(401).json({ error: 'Unauthorized: Please log in' });
        return;
      }

      // View tracking is handled by GitHubApiService (which has repoViewTracker injected)
      // Actual tracking happens when repo is fetched via GET /repos/:owner/:repo
      // This endpoint simply acknowledges the view request
      const response: TrackRepoViewResponse = { success: true };
      res.json(response);
    } catch (error) {
      console.error('[API] Error tracking repository view:', error);
      res
        .status(500)
        .json({ error: error instanceof Error ? error.message : 'Failed to track view' });
    }
  });

  // User tasks endpoints (cross-repository issues and PRs)
  router.get('/user/tasks', requireAuth, async (req, res) =>
    githubApiService.handleGetUserTasks(req, res)
  );
  router.get('/user/tasks/cached', requireAuth, async (req, res) =>
    githubApiService.handleGetUserTasksCached(req, res)
  );
  router.get('/user/tasks/refresh', requireAuth, async (req, res) =>
    githubApiService.handleGetUserTasksRefresh(req, res)
  );
  router.get('/user/tasks/stats', requireAuth, async (req, res) =>
    githubApiService.handleGetUserTaskStats(req, res)
  );

  // NOTE: `/repos/:owner/:repo/quick-actions` is registered ONCE, above (Express serves
  // the first matching registration). A second identical handler used to live here — it
  // was dead code (never reached) and carried the same unguarded `tunnelService` deref, so
  // it was removed.

  // Git local operations
  router.post('/repos/:owner/:repo/clone', requireAuth, async (req, res) =>
    gitLocalService.handleCloneRequest(req, res)
  );

  // List all local repos with git status
  router.get('/local-repos', requireAuth, async (req, res) => {
    const userEmail = req.session?.userEmail;

    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const repos = await gitLocalService.listLocalReposWithStatus(userEmail);
      return res.json({ repos });
    } catch (error) {
      console.error('[API] Error listing local repos:', error);
      return res
        .status(500)
        .json({ error: error instanceof Error ? error.message : 'Failed to list local repos' });
    }
  });

  // Get git diff output (unified diff + file list)
  router.get('/repos/:owner/:repo/git-diff', requireAuth, async (req, res) => {
    const { owner, repo } = req.params;
    const userEmail = req.session?.userEmail;

    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const repoPath = await resolveRepoLocalPath(
        gitLocalService,
        userEmail,
        owner as string,
        repo as string
      );

      if (!fs.existsSync(repoPath)) {
        return res.status(404).json({ error: 'Repository not cloned locally' });
      }

      const diff = await gitLocalService.getUnifiedDiff(repoPath);
      const files = await gitLocalService.getChangedFiles(repoPath);

      return res.json({ diff, files });
    } catch (error) {
      console.error('[API] Error getting git diff:', error);
      return res
        .status(500)
        .json({ error: error instanceof Error ? error.message : 'Failed to get git diff' });
    }
  });

  // Environment files endpoints
  router.get('/repos/:owner/:repo/env-files', requireAuth, async (req, res) => {
    const { owner, repo } = req.params;
    const userEmail = req.session?.userEmail;

    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      console.log(`[API] Env files request: ${owner}/${repo} for user ${userEmail}`);
      const files = await gitLocalService.listEnvFiles(owner as string, repo as string, userEmail);
      return res.json({ files });
    } catch (error) {
      console.error('[API] Error listing env files:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to list environment files',
      });
    }
  });

  router.get('/env-file/read', requireAuth, async (req, res) => {
    const { filePath } = req.query;
    const userEmail = req.session?.userEmail;

    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'File path is required' });
    }

    try {
      console.log(`[API] Read env file request: ${filePath} for user ${userEmail}`);
      const envVars = await gitLocalService.readEnvFile(filePath, userEmail);
      return res.json({ envVars });
    } catch (error) {
      console.error('[API] Error reading env file:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to read environment file',
      });
    }
  });

  router.post('/env-file/write', requireAuth, async (req, res) => {
    const { filePath, envVars } = req.body;
    const userEmail = req.session?.userEmail;

    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'File path is required' });
    }

    if (!envVars || typeof envVars !== 'object') {
      return res.status(400).json({ error: 'Environment variables object is required' });
    }

    try {
      console.log(`[API] Write env file request: ${filePath} for user ${userEmail}`);
      await gitLocalService.writeEnvFile(filePath, envVars, userEmail);
      return res.json({ success: true });
    } catch (error) {
      console.error('[API] Error writing env file:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to write environment file',
      });
    }
  });

  // Media serving
  router.get('/video/:owner/:repo/*', requireAuth, async (req, res) =>
    githubApiService.handleServeVideo(req, res)
  );
  router.get('/image/:owner/:repo/*', requireAuth, async (req, res) =>
    githubApiService.handleServeImage(req, res)
  );

  // Chat management endpoints
  router.patch('/chats/:chatId/device', requireAuth, async (req, res) => {
    const { chatId } = req.params;
    const { playwrightDevice } = req.body;

    if (!playwrightDevice || (playwrightDevice !== 'mobile' && playwrightDevice !== 'desktop')) {
      return res.status(400).json({ error: 'Invalid device mode' });
    }

    // Extract JWT from Authorization header for request auth
    const authToken = getAuthToken(req);

    try {
      const success = await chatService.updatePlaywrightDevice(
        chatId as string,
        req.session.userEmail!,
        playwrightDevice,
        authToken
      );

      if (!success) {
        return res.status(404).json({ error: 'Chat not found' });
      }

      const response: { success: boolean } = { success };
      res.json(response);
    } catch (error) {
      console.error('[API] /api/chats/:chatId/device error:', error);
      res.status(500).json({ error: 'Failed to update device mode' });
    }
  });

  router.patch('/chats/:chatId/permissions', requireAuth, async (req, res) => {
    const { chatId } = req.params;
    const { permissions } = req.body;

    const validPermissions = ['default', 'plan', 'accept_edits', 'bypass_permissions'];
    if (!permissions || !validPermissions.includes(permissions)) {
      return res.status(400).json({ error: 'Invalid permissions mode' });
    }

    // Extract JWT from Authorization header for request auth
    const authToken = getAuthToken(req);

    try {
      const success = await chatService.updatePermissions(
        chatId as string,
        req.session.userEmail!,
        permissions,
        authToken
      );

      if (!success) {
        return res.status(404).json({ error: 'Chat not found' });
      }

      const response: { success: boolean } = { success };
      res.json(response);
    } catch (error) {
      console.error('[API] /api/chats/:chatId/permissions error:', error);
      res.status(500).json({ error: 'Failed to update permissions mode' });
    }
  });

  // Read chat settings (model, permissions, agentSetupId).
  // Counterpart of the PATCH below — lets a client (e.g. mobile) hydrate a
  // chat's persisted settings. Only fields that are actually set are returned so
  // the client applies its own defaults for any omitted field.
  router.get('/chat/:chatId/settings', requireAuth, async (req, res) => {
    const { chatId } = req.params;

    // Extract JWT from Authorization header for request auth
    const authToken = getAuthToken(req);
    const userEmail = req.session.userEmail!;

    try {
      const chatIdStr = Array.isArray(chatId) ? chatId[0] : chatId;

      const chat = await chatService.getChat(chatIdStr, userEmail, authToken);
      if (!chat) {
        return res.status(404).json({ error: 'Chat not found' });
      }

      // Omit null/empty so a missing value never clobbers a client-side default.
      const response: GetChatSettingsResponse = {};
      if (chat.model) response.model = chat.model;
      if (chat.permissions) response.permissions = chat.permissions;
      if (chat.agent_setup_id) response.agentSetupId = chat.agent_setup_id;
      if (chat.effort) response.effort = chat.effort;

      res.json(response);
    } catch (error) {
      console.error('[API] GET /api/chat/:chatId/settings error:', error);
      res.status(500).json({ error: 'Failed to get chat settings' });
    }
  });

  // Update chat settings (model and/or permissions and/or agentSetupId)
  router.patch('/chat/:chatId/settings', requireAuth, async (req, res) => {
    const { chatId } = req.params;
    const { model, permissions, agentSetupId, effort } = req.body;

    // Extract JWT from Authorization header for request auth
    const authToken = getAuthToken(req);
    const userEmail = req.session.userEmail!;

    try {
      const chatIdStr = Array.isArray(chatId) ? chatId[0] : chatId;

      // Check if chat exists FIRST (before validating request body)
      const chat = await chatService.getChat(chatIdStr, userEmail, authToken);
      if (!chat) {
        return res.status(404).json({ error: 'Chat not found' });
      }

      // Now validate request body
      // Require at least one setting to be provided
      if (!model && !permissions && !agentSetupId && !effort) {
        return res.status(400).json({ error: 'At least one setting must be provided' });
      }

      // Validate permissions if provided
      if (permissions) {
        const validPermissions = ['default', 'plan', 'accept_edits', 'bypass_permissions'];
        if (!validPermissions.includes(permissions)) {
          return res.status(400).json({ error: 'Invalid permissions mode' });
        }
      }

      // Validate model if provided
      if (model) {
        if (typeof model !== 'string' || !isModelMode(model)) {
          return res.status(400).json({ error: 'Invalid model' });
        }
      }

      // Validate agentSetupId if provided
      if (agentSetupId) {
        const validSetups = ['best-practice', 'freestyle']; // Add more as needed
        if (!validSetups.includes(agentSetupId)) {
          return res.status(400).json({ error: 'Invalid agent setup ID' });
        }
      }

      // Validate effort if provided — must be a known level AND supported by the
      // chat's (possibly-just-updated) model, so a chat can never end up with an
      // effort value its model rejects (e.g. Haiku, or 'xhigh' on Sonnet).
      if (effort) {
        if (typeof effort !== 'string' || !isEffortLevel(effort)) {
          return res.status(400).json({ error: 'Invalid effort level' });
        }
        const effectiveModel: ModelMode | undefined =
          model && isModelMode(model)
            ? model
            : chat.model && isModelMode(chat.model)
              ? chat.model
              : undefined;
        if (!effectiveModel || !getSupportedEffortLevels(effectiveModel).includes(effort)) {
          return res
            .status(400)
            .json({ error: `Model '${effectiveModel}' does not support effort '${effort}'` });
        }
      }

      await chatService.updateChatSettings(
        chatIdStr,
        userEmail,
        { model, permissions, agentSetupId, effort },
        authToken
      );

      // Broadcast settings update to all clients in the chat room (multi-device sync)
      if (socketIOService) {
        console.log(`[API] Broadcasting chat:settings_updated for ${chatId}:`, {
          model,
          permissions,
          agentSetupId,
          effort,
        });
        socketIOService.broadcastToRoom(chatId as string, 'chat:settings_updated', {
          chatId: chatId as string,
          settings: { model, permissions, agentSetupId, effort },
        });
      } else {
        console.warn(
          `[API] socketIOService not available, cannot broadcast settings update for ${chatId}`
        );
      }

      const response: {
        success: boolean;
        updated: {
          model?: string;
          permissions?: string;
          agentSetupId?: string;
          effort?: string;
        };
      } = {
        success: true,
        updated: { model, permissions, agentSetupId, effort },
      };
      res.json(response);
    } catch (error) {
      console.error('[API] /api/chat/:chatId/settings error:', error);
      res.status(500).json({ error: 'Failed to update chat settings' });
    }
  });

  router.patch('/chats/:chatId/archive', requireAuth, async (req, res) => {
    const { chatId } = req.params;
    const { archived } = req.body;

    // Extract JWT from Authorization header for request auth
    const authToken = getAuthToken(req);
    const userEmail = req.session.userEmail!;

    try {
      const chatIdStr = Array.isArray(chatId) ? chatId[0] : chatId;

      // Check if chat exists
      const chat = await chatService.getChat(chatIdStr, userEmail, authToken);
      if (!chat) {
        return res.status(404).json({ error: 'Chat not found' });
      }

      await chatService.archiveChat(chatIdStr, userEmail, archived, authToken);
      const response: { success: boolean } = { success: true };
      res.json(response);
    } catch (error) {
      console.error('[API] /api/chats/:chatId/archive error:', error);
      res.status(500).json({ error: 'Failed to update archive status' });
    }
  });

  // Removed: Container orchestration endpoints (container orchestration no longer used)
  // Removed: Dev endpoints (/dev/google-token, /dev/session) - use OAuth flow and proper authentication instead

  // Get GitHub issue details
  // GET /api/github/issues/:owner/:repo/:issue_number
  router.get('/github/issues/:owner/:repo/:issue_number', requireAuth, async (req, res) => {
    if (!req.session.userEmail) {
      console.log('[API] /api/github/issues - Not authenticated');
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (!authService) {
      return res.status(503).json({ error: 'Auth service not available' });
    }

    const { owner, repo, issue_number } = req.params;

    try {
      const octokit = await authService.getUserOctokitAsync(req);

      // Fetch issue details from GitHub
      const { data: issue } = await octokit.issues.get({
        owner: owner as string,
        repo: repo as string,
        issue_number: parseInt(issue_number as string),
      });

      // Return simplified issue data for the banner
      const response: {
        title: string;
        state: string;
        html_url: string;
        labels: Array<{ name: string; color: string }>;
        assignee?: {
          login: string;
          avatar_url: string;
        };
      } = {
        title: issue.title,
        state: issue.state,
        html_url: issue.html_url,
        labels:
          issue.labels?.map((l: string | { name?: string; color?: string }) => ({
            name: typeof l === 'string' ? l : l.name || '',
            color: typeof l === 'string' ? '' : l.color || '',
          })) || [],
        assignee: issue.assignee
          ? {
              login: issue.assignee.login,
              avatar_url: issue.assignee.avatar_url,
            }
          : undefined,
      };
      res.json(response);
    } catch (error) {
      console.error(`[API] Error fetching issue ${owner}/${repo}#${issue_number}:`, error);
      res
        .status(
          error &&
            typeof error === 'object' &&
            'status' in error &&
            typeof error.status === 'number'
            ? error.status
            : 500
        )
        .json({
          error: error instanceof Error ? error.message : 'Failed to fetch issue details',
        });
    }
  });

  return router;
}
