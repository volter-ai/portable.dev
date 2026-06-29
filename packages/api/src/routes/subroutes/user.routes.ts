import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';
import { getAuthToken } from '../utils/route-helpers.js';

import type { AuthService } from '../../services/AuthService.js';
import type { GitHubApiService } from '../../services/GitHubApiService.js';
import type { ThemeService } from '../../services/ThemeService.js';
import type { GetUserThemeResponse, SaveUserThemeResponse } from '@vgit2/shared/types';

/**
 * User profile and theme routes.
 *
 * The local-first runtime has no billing and no external database.
 * AI usage is the user's own Anthropic credential.
 */
export function createUserRoutes(
  authService: AuthService,
  githubApiService: GitHubApiService,
  themeService: ThemeService
): Router {
  const router = Router();

  // User info
  router.get('/', requireAuth, (req, res) => authService.getUser(req, res));

  // User profile (fresh from GitHub API)
  router.get('/profile', requireAuth, async (req, res) =>
    githubApiService.handleGetUserProfile(req, res)
  );

  // User organizations
  router.get('/organizations', requireAuth, async (req, res) =>
    githubApiService.handleGetUserOrganizations(req, res)
  );

  // Theme endpoints
  router.get('/theme', requireAuth, async (req, res) => {
    try {
      const authToken = getAuthToken(req);
      const themeConfig = await themeService.getTheme(req.session.userEmail!, authToken);
      const response: GetUserThemeResponse = { themeConfig };
      res.json(response);
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to fetch theme' });
    }
  });

  router.put('/theme', requireAuth, async (req, res) => {
    const { themeConfig } = req.body;

    if (!themeConfig || typeof themeConfig !== 'object') {
      return res.status(400).json({ error: 'Theme configuration is required' });
    }

    try {
      const authToken = getAuthToken(req);
      await themeService.saveTheme(req.session.userEmail!, themeConfig, authToken);
      const response: SaveUserThemeResponse = { success: true };
      res.json(response);
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to save theme' });
    }
  });

  router.delete('/theme', requireAuth, async (req, res) => {
    try {
      const authToken = getAuthToken(req);
      await themeService.deleteTheme(req.session.userEmail!, authToken);
      res.status(204).send();
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to delete theme' });
    }
  });

  // Recent branches
  router.get('/recent-branches', requireAuth, async (req, res) =>
    githubApiService.handleGetRecentBranches(req, res)
  );

  return router;
}
