import { isLeaderboardGameId } from '@vgit2/shared/gameRegistry';
import { Router, Request, Response } from 'express';

import type { LeaderboardService } from '../services/LeaderboardService.js';
import type {
  SubmitScoreRequest,
  GetLeaderboardRequest,
  GetUserScoreRequest,
  GetGameStatsRequest,
} from '@vgit2/shared/types/index.js';

/**
 * Vibewaiting routes
 *
 * Isolated game system routes under /vibewaiting
 * This will eventually be factored out into a separate backend
 */
export function createVibewaitingRoutes(leaderboardService: LeaderboardService): Router {
  const router = Router();

  // ============================================================================
  // VALIDATION MIDDLEWARE
  // ============================================================================

  /**
   * Validate user is authenticated
   * UserId is always read from session, never from request body/params/query
   */
  function validateAuthenticatedUser(req: Request, res: Response, next: Function) {
    // Check if user is authenticated (check both userId and githubUser for compatibility)
    if (!req.session?.userId && !req.session?.githubUser?.id) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
    }

    next();
  }

  /**
   * Validate required fields in request body
   */
  function validateRequiredFields(fields: string[]) {
    return (req: Request, res: Response, next: Function) => {
      const missing = fields.filter((field) => !req.body[field]);
      if (missing.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Missing required fields: ${missing.join(', ')}`,
        });
      }
      next();
    };
  }

  /**
   * Validate game ID against registered leaderboard games
   */
  function validateGameId(paramName: string = 'game') {
    return (req: Request, res: Response, next: Function) => {
      const gameId = req.params[paramName] || req.body[paramName];
      if (!gameId) {
        return res.status(400).json({
          success: false,
          error: `Missing game ID`,
        });
      }
      if (!isLeaderboardGameId(gameId)) {
        return res.status(400).json({
          success: false,
          error: `Invalid game ID: ${gameId}`,
        });
      }
      next();
    };
  }

  /**
   * Validate score is a positive number
   */
  function validateScore(req: Request, res: Response, next: Function) {
    const { score } = req.body;
    if (typeof score !== 'number' || isNaN(score) || score < 0) {
      return res.status(400).json({
        success: false,
        error: 'Score must be a positive number',
      });
    }
    next();
  }

  /**
   * Validate rating is between 1 and 5
   */
  function validateRating(req: Request, res: Response, next: Function) {
    const { rating } = req.body;
    if (typeof rating !== 'number' || isNaN(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        error: 'Rating must be a number between 1 and 5',
      });
    }
    next();
  }

  // ============================================================================
  // LEADERBOARD ROUTES
  // ============================================================================

  /**
   * POST /vibewaiting/leaderboard/submit
   * Submit a score to the leaderboard
   */
  router.post(
    '/leaderboard/submit',
    validateAuthenticatedUser,
    validateRequiredFields(['username', 'avatar', 'game', 'score']),
    validateGameId('game'),
    validateScore,
    async (req: Request, res: Response) => {
      try {
        // Get userId from authenticated session, not from request body
        // Support both userId (new) and githubUser.id (legacy) for compatibility
        const userId = req.session.userId || req.session.githubUser?.id.toString();
        const { username, avatar, game, score } = req.body;

        const response = await leaderboardService.submitScore(userId, username, avatar, {
          userId,
          username,
          avatar,
          game,
          score,
        });

        res.json(response);
      } catch (error: any) {
        console.error('[VibeWaiting] Error submitting score:', error);
        res.status(500).json({
          success: false,
          error: error.message || 'Failed to submit score',
        });
      }
    }
  );

  /**
   * GET /vibewaiting/leaderboard/:game
   * Get leaderboard for a game
   * Optional: Include authenticated user's score if logged in
   */
  router.get('/leaderboard/:game', validateGameId('game'), async (req: Request, res: Response) => {
    try {
      const { game } = req.params;
      const limitParam = req.query.limit as string;
      const limit = limitParam ? parseInt(limitParam, 10) : 10;

      // Get userId from session if authenticated (optional for this endpoint)
      const userId = req.session?.userId;

      // Validate limit is a positive number
      if (isNaN(limit) || limit <= 0 || limit > 100) {
        return res.status(400).json({
          success: false,
          error: 'Limit must be a positive number between 1 and 100',
        });
      }

      const response = userId
        ? await leaderboardService.getLeaderboardWithUser(game as any, userId, limit)
        : await leaderboardService.getLeaderboard({ game: game as any, limit });

      res.json(response);
    } catch (error: any) {
      console.error('[VibeWaiting] Error fetching leaderboard:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to fetch leaderboard',
      });
    }
  });

  /**
   * GET /vibewaiting/leaderboard/:game/user/me
   * Get authenticated user's score for a game
   */
  router.get(
    '/leaderboard/:game/user/me',
    validateAuthenticatedUser,
    validateGameId('game'),
    async (req: Request, res: Response) => {
      try {
        const { game } = req.params;
        // Get userId from authenticated session
        const userId = req.session.userId || req.session.githubUser?.id.toString();

        const response = await leaderboardService.getUserScore({
          game: game as any,
          userId,
        });

        res.json(response);
      } catch (error: any) {
        console.error('[VibeWaiting] Error fetching user score:', error);
        res.status(500).json({
          success: false,
          error: error.message || 'Failed to fetch user score',
        });
      }
    }
  );

  /**
   * GET /vibewaiting/leaderboard/stats
   * Get leaderboard statistics (admin/debugging)
   */
  router.get('/leaderboard/stats', async (_req: Request, res: Response) => {
    try {
      const stats = await leaderboardService.getStats();
      res.json(stats);
    } catch (error: any) {
      console.error('[VibeWaiting] Error fetching stats:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to fetch stats',
      });
    }
  });

  // ============================================================================
  // PLAY TRACKING & RATING ROUTES
  // ============================================================================

  /**
   * POST /vibewaiting/game/play
   * Track a game play (open/close)
   */
  router.post(
    '/game/play',
    validateAuthenticatedUser,
    validateRequiredFields(['game']),
    validateGameId('game'),
    async (req: Request, res: Response) => {
      try {
        // Get userId from authenticated session
        const userId = req.session.userId || req.session.githubUser?.id.toString();
        const { game } = req.body;

        const response = await leaderboardService.trackPlay({ userId, game });

        res.json(response);
      } catch (error: any) {
        console.error('[VibeWaiting] Error tracking play:', error);
        res.status(500).json({
          success: false,
          error: error.message || 'Failed to track play',
        });
      }
    }
  );

  /**
   * POST /vibewaiting/game/rate
   * Rate a game (1-5 stars)
   */
  router.post(
    '/game/rate',
    validateAuthenticatedUser,
    validateRequiredFields(['game', 'rating']),
    validateGameId('game'),
    validateRating,
    async (req: Request, res: Response) => {
      try {
        // Get userId from authenticated session
        const userId = req.session.userId || req.session.githubUser?.id.toString();
        const { game, rating } = req.body;

        const response = await leaderboardService.rateGame({ userId, game, rating });

        res.json(response);
      } catch (error: any) {
        console.error('[VibeWaiting] Error rating game:', error);
        res.status(500).json({
          success: false,
          error: error.message || 'Failed to rate game',
        });
      }
    }
  );

  /**
   * GET /vibewaiting/game/:game/stats
   * Get game statistics including plays and ratings
   * Optional: Include authenticated user's stats if logged in
   */
  router.get('/game/:game/stats', validateGameId('game'), async (req: Request, res: Response) => {
    try {
      const { game } = req.params;
      // Get userId from session if authenticated (optional for this endpoint)
      const userId = req.session?.userId;

      const response = await leaderboardService.getGameStats({
        game: game as any,
        userId,
      });

      res.json(response);
    } catch (error: any) {
      console.error('[VibeWaiting] Error fetching game stats:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to fetch game stats',
      });
    }
  });

  return router;
}
