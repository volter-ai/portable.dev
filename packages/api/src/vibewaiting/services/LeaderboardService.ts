import { debugLog } from '@vgit2/shared/constants';
import { LEADERBOARD_GAME_IDS } from '@vgit2/shared/gameRegistry';

import { SqliteLeaderboardStore } from './SqliteLeaderboardStore.js';

import type {
  LeaderboardEntry,
  LeaderboardResponse,
  SubmitScoreRequest,
  SubmitScoreResponse,
  GetLeaderboardRequest,
  GetUserScoreRequest,
  GetUserScoreResponse,
  LeaderboardGameId,
  TrackPlayRequest,
  TrackPlayResponse,
  RateGameRequest,
  RateGameResponse,
  GetGameStatsRequest,
  GameStats,
} from '@vgit2/shared/types/index.js';

/**
 * LeaderboardService
 *
 * Manages game leaderboards, play tracking, and ratings for vibewaiting games.
 * Local-first: persists to a SQLite database under DATA_DIR
 * (`SqliteLeaderboardStore`). Games are dynamically loaded from
 * GAME_REGISTRY.
 *
 * The store is lazily initialized on first use so the public, no-arg constructor
 * (`new LeaderboardService()`) used by server.ts keeps working unchanged.
 */
export class LeaderboardService {
  private readonly store: SqliteLeaderboardStore;
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.store = new SqliteLeaderboardStore();
    debugLog('[LeaderboardService] ✓ Initialized with local SQLite store');
    debugLog('[LeaderboardService] Registered games:', LEADERBOARD_GAME_IDS.join(', '));
    debugLog('[LeaderboardService] Security: Backend-validated user sessions');
  }

  /**
   * Lazily initialize the SQLite store exactly once. Every public method awaits
   * this before touching the store, so the synchronous no-arg constructor stays
   * intact while the async DB setup happens on first use.
   */
  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.store.initialize();
    }
    return this.initPromise;
  }

  /**
   * Check if service is available. Local SQLite is always available on the PC,
   * so this is unconditionally true.
   */
  isAvailable(): boolean {
    return true;
  }

  /**
   * Submit a score for a user
   */
  async submitScore(
    userId: string,
    username: string,
    avatar: string,
    request: SubmitScoreRequest
  ): Promise<SubmitScoreResponse> {
    try {
      await this.ensureInitialized();
      const { game, score } = request;

      // Get existing score
      const existing = this.store.getScore(userId, game);

      const previousBest = existing?.score;
      const isNewBest = !previousBest || score > previousBest;

      if (isNewBest) {
        // Upsert the new score
        const data = this.store.upsertScore({
          user_id: userId,
          username,
          avatar,
          game,
          score,
          timestamp: new Date().toISOString(),
        });

        const newEntry: LeaderboardEntry = {
          userId: data.user_id,
          username: data.username,
          avatar: data.avatar,
          score: data.score,
          game: data.game as LeaderboardGameId,
          timestamp: data.timestamp,
        };

        return {
          success: true,
          entry: newEntry,
          isNewBest: true,
          previousBest,
        };
      }

      // Return existing score if not a new best
      const entry: LeaderboardEntry = {
        userId: existing!.user_id,
        username: existing!.username,
        avatar: existing!.avatar,
        score: existing!.score,
        game: existing!.game as LeaderboardGameId,
        timestamp: existing!.timestamp,
      };

      return {
        success: true,
        entry,
        isNewBest: false,
        previousBest,
      };
    } catch (error: any) {
      console.error('[LeaderboardService] Error in submitScore:', error);
      throw error;
    }
  }

  /**
   * Get leaderboard for a game
   */
  async getLeaderboard(request: GetLeaderboardRequest): Promise<LeaderboardResponse> {
    try {
      await this.ensureInitialized();
      const { game, limit = 10 } = request;

      // Get top scores (ordered by score DESC, timestamp ASC)
      const data = this.store.getTopScores(game, limit);

      // Get total player count
      const count = this.store.countPlayers(game);

      const entries: LeaderboardEntry[] = data.map((row, index) => ({
        userId: row.user_id,
        username: row.username,
        avatar: row.avatar,
        score: row.score,
        game: row.game as LeaderboardGameId,
        timestamp: row.timestamp,
        rank: index + 1,
      }));

      return {
        entries,
        totalPlayers: count || 0,
      };
    } catch (error: any) {
      console.error('[LeaderboardService] Error in getLeaderboard:', error);
      throw error;
    }
  }

  /**
   * Get a specific user's score for a game
   */
  async getUserScore(request: GetUserScoreRequest): Promise<GetUserScoreResponse> {
    try {
      await this.ensureInitialized();
      const { game, userId } = request;

      // Get user's score
      const userScore = this.store.getScore(userId, game);

      if (!userScore) {
        return {
          entry: null,
          rank: null,
        };
      }

      // Get rank by counting how many scores are better
      // Better scores = higher score OR (same score but earlier timestamp)
      const betterScoresCount = this.store.countBetterScores(game, userScore.score);
      const sameScoreEarlierCount = this.store.countSameScoreEarlier(
        game,
        userScore.score,
        userScore.timestamp
      );

      const rank = (betterScoresCount || 0) + (sameScoreEarlierCount || 0) + 1;

      const entry: LeaderboardEntry = {
        userId: userScore.user_id,
        username: userScore.username,
        avatar: userScore.avatar,
        score: userScore.score,
        game: userScore.game as LeaderboardGameId,
        timestamp: userScore.timestamp,
        rank,
      };

      return {
        entry,
        rank,
      };
    } catch (error: any) {
      console.error('[LeaderboardService] Error in getUserScore:', error);
      throw error;
    }
  }

  /**
   * Get leaderboard with user's score included
   */
  async getLeaderboardWithUser(
    game: LeaderboardGameId,
    userId: string,
    limit: number = 10
  ): Promise<LeaderboardResponse> {
    try {
      const leaderboard = await this.getLeaderboard({ game, limit });

      // Get user's score if not in top results
      const userInLeaderboard = leaderboard.entries.some((e) => e.userId === userId);

      if (!userInLeaderboard) {
        const userScoreResult = await this.getUserScore({ game, userId });
        if (userScoreResult.entry) {
          leaderboard.userEntry = userScoreResult.entry;
        }
      } else {
        // User is already in the leaderboard
        leaderboard.userEntry = leaderboard.entries.find((e) => e.userId === userId);
      }

      return leaderboard;
    } catch (error: any) {
      console.error('[LeaderboardService] Error in getLeaderboardWithUser:', error);
      throw error;
    }
  }

  /**
   * Clear all scores (admin function)
   */
  async clearScores(game?: LeaderboardGameId) {
    try {
      await this.ensureInitialized();
      if (game) {
        this.store.deleteScoresForGame(game);
        console.log(`[LeaderboardService] Cleared ${game} leaderboard`);
      } else {
        this.store.deleteAllScores(); // Delete all rows
        console.log('[LeaderboardService] Cleared all leaderboards');
      }
    } catch (error: any) {
      console.error('[LeaderboardService] Error in clearScores:', error);
      throw error;
    }
  }

  /**
   * Get statistics
   */
  async getStats() {
    try {
      await this.ensureInitialized();
      const stats: Record<string, { players: number; topScore: number | null }> = {};

      for (const game of LEADERBOARD_GAME_IDS) {
        // Get player count
        const count = this.store.countPlayers(game);

        // Get top score
        const topScore = this.store.getTopScore(game);

        stats[game] = {
          players: count || 0,
          topScore: topScore || null,
        };
      }

      return stats;
    } catch (error: any) {
      console.error('[LeaderboardService] Error in getStats:', error);
      throw error;
    }
  }

  /**
   * Track a play (open/close counts as one play)
   */
  async trackPlay(request: TrackPlayRequest): Promise<TrackPlayResponse> {
    try {
      await this.ensureInitialized();
      const { game, userId } = request;

      // Get current play count
      const existingCount = this.store.getPlayCount(userId, game);

      const newCount = (existingCount || 0) + 1;

      // Upsert play count
      this.store.upsertPlayCount(userId, game, newCount);

      return {
        success: true,
        totalPlays: newCount,
      };
    } catch (error: any) {
      console.error('[LeaderboardService] Error in trackPlay:', error);
      throw error;
    }
  }

  /**
   * Rate a game (1-5 stars)
   */
  async rateGame(request: RateGameRequest): Promise<RateGameResponse> {
    try {
      await this.ensureInitialized();
      const { game, userId, rating } = request;

      // Validate rating
      if (rating < 1 || rating > 5) {
        throw new Error('Rating must be between 1 and 5');
      }

      // Upsert rating
      this.store.upsertRating(userId, game, rating);

      // Calculate average rating
      const ratings = this.store.getAllRatings(game);
      const averageRating =
        ratings.length > 0 ? ratings.reduce((sum, r) => sum + r, 0) / ratings.length : 0;

      return {
        success: true,
        rating,
        averageRating,
        totalRatings: ratings.length,
      };
    } catch (error: any) {
      console.error('[LeaderboardService] Error in rateGame:', error);
      throw error;
    }
  }

  /**
   * Get game statistics including plays and ratings
   */
  async getGameStats(request: GetGameStatsRequest): Promise<GameStats> {
    try {
      await this.ensureInitialized();
      const { game, userId } = request;

      // Get total plays
      const allPlays = this.store.getAllPlayCounts(game);

      const totalPlays = allPlays.reduce((sum, p) => sum + p, 0);
      const uniquePlayers = allPlays.length;

      // Get ratings
      const ratings = this.store.getAllRatings(game);
      const averageRating =
        ratings.length > 0 ? ratings.reduce((sum, r) => sum + r, 0) / ratings.length : 0;

      const stats: GameStats = {
        game,
        totalPlays,
        uniquePlayers,
        averageRating,
        totalRatings: ratings.length,
      };

      // Add user-specific data if userId provided
      if (userId) {
        const userRating = this.store.getUserRating(userId, game);
        const userPlays = this.store.getPlayCount(userId, game);

        stats.userRating = userRating ?? undefined;
        stats.userPlays = userPlays || 0;
      }

      return stats;
    } catch (error: any) {
      console.error('[LeaderboardService] Error in getGameStats:', error);
      throw error;
    }
  }
}
