/**
 * Vibewaiting (game system) types
 */

import type { LeaderboardGameId } from '../gameRegistry';

// ============================================================================
// LEADERBOARD TYPES
// ============================================================================

export interface LeaderboardEntry {
  userId: string;
  username: string;
  avatar: string;
  score: number;
  game: LeaderboardGameId;
  timestamp: string; // ISO date string
  rank?: number; // Populated when fetching leaderboard
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  userEntry?: LeaderboardEntry; // Current user's best score
  totalPlayers: number;
}

// ============================================================================
// API REQUEST/RESPONSE TYPES
// ============================================================================

/**
 * POST /vibewaiting/leaderboard/submit
 */
export interface SubmitScoreRequest {
  userId: string;
  username: string;
  avatar: string;
  game: LeaderboardGameId;
  score: number;
}

export interface SubmitScoreResponse {
  success: boolean;
  entry: LeaderboardEntry;
  isNewBest: boolean;
  previousBest?: number;
}

/**
 * GET /vibewaiting/leaderboard/:game
 */
export interface GetLeaderboardRequest {
  game: LeaderboardGameId;
  limit?: number; // Default: 10
}

export type GetLeaderboardResponse = LeaderboardResponse;

/**
 * GET /vibewaiting/leaderboard/:game/user/:userId
 */
export interface GetUserScoreRequest {
  game: LeaderboardGameId;
  userId: string;
}

export interface GetUserScoreResponse {
  entry: LeaderboardEntry | null;
  rank: number | null;
}

// ============================================================================
// PLAY TRACKING & RATINGS
// ============================================================================

/**
 * POST /vibewaiting/game/play
 * Track a game play (open/close)
 */
export interface TrackPlayRequest {
  userId: string;
  game: LeaderboardGameId;
}

export interface TrackPlayResponse {
  success: boolean;
  totalPlays: number;
}

/**
 * POST /vibewaiting/game/rate
 * Rate a game (1-5 stars)
 */
export interface RateGameRequest {
  userId: string;
  game: LeaderboardGameId;
  rating: number; // 1-5
}

export interface RateGameResponse {
  success: boolean;
  rating: number;
  averageRating: number;
  totalRatings: number;
}

/**
 * GET /vibewaiting/game/:game/stats
 * Get game statistics including plays and ratings
 */
export interface GameStats {
  game: LeaderboardGameId;
  totalPlays: number;
  uniquePlayers: number;
  averageRating: number;
  totalRatings: number;
  userRating?: number; // If userId provided
  userPlays?: number; // If userId provided
}

export interface GetGameStatsRequest {
  game: LeaderboardGameId;
  userId?: string; // Optional, includes user-specific data if provided
}

export type GetGameStatsResponse = GameStats;
