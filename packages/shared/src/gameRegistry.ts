/**
 * Centralized Game Registry
 *
 * This is the SINGLE SOURCE OF TRUTH for all games in the vibewaiting system.
 * To add a new game, just add it to the GAME_REGISTRY array below.
 * Everything else (types, routes, leaderboards, UI) derives from this.
 */

export interface GameDefinition {
  /** Unique game identifier (used in URLs, storage keys, etc.) */
  id: string;
  /** Human-readable game title */
  title: string;
  /** URL path for the game (usually same as id) */
  path: string;
  /** Whether this game has competitive scoring/leaderboards */
  hasLeaderboard: boolean;
  /** Page component name (for dynamic imports) */
  componentName: string;
}

/**
 * GAME REGISTRY - Add new games here!
 *
 * To add a new game:
 * 1. Add entry to this array
 * 2. Create the game component + page wrapper in the client app
 * 3. That's it! Everything else is automatic.
 */
export const GAME_REGISTRY: readonly GameDefinition[] = [
  {
    id: '2048',
    title: '2048',
    path: '2048',
    hasLeaderboard: true,
    componentName: 'Game2048Page',
  },
  {
    id: 'flappy-bird',
    title: 'Flappy Bird',
    path: 'flappy-bird',
    hasLeaderboard: true,
    componentName: 'GameFlappyBirdPage',
  },
  {
    id: 'dino',
    title: 'Dino Run',
    path: 'dino',
    hasLeaderboard: true,
    componentName: 'GameDinoPage',
  },
  {
    id: 'plinko',
    title: 'Plinko',
    path: 'plinko',
    hasLeaderboard: true,
    componentName: 'GamePlinkoPage',
  },
  {
    id: 'videos',
    title: 'Videos',
    path: 'videos',
    hasLeaderboard: false,
    componentName: 'GameVideosPage',
  },
  {
    id: 'suika',
    title: 'Suika Game',
    path: 'suika',
    hasLeaderboard: true,
    componentName: 'GameSuikaPage',
  },
] as const;

/**
 * Derived constants and utilities
 */

/** All game IDs as a type union */
export type GameId = (typeof GAME_REGISTRY)[number]['id'];

/** All game IDs as an array */
export const GAME_IDS = GAME_REGISTRY.map((g) => g.id);

/** Games with leaderboards only */
export const LEADERBOARD_GAMES = GAME_REGISTRY.filter((g) => g.hasLeaderboard);

/** Leaderboard game IDs as a type union */
export type LeaderboardGameId = (typeof LEADERBOARD_GAMES)[number]['id'];

/** Leaderboard game IDs as an array */
export const LEADERBOARD_GAME_IDS = LEADERBOARD_GAMES.map((g) => g.id);

/** Game lookup by ID */
export const GAME_BY_ID = Object.fromEntries(GAME_REGISTRY.map((g) => [g.id, g])) as Record<
  GameId,
  GameDefinition
>;

/**
 * Get game title by ID
 */
export function getGameTitle(gameId: GameId | string): string {
  const game = GAME_BY_ID[gameId as GameId];
  return game?.title || 'Unknown Game';
}

/**
 * Check if a game has leaderboards
 */
export function hasLeaderboard(gameId: GameId | string): boolean {
  const game = GAME_BY_ID[gameId as GameId];
  return game?.hasLeaderboard || false;
}

/**
 * Check if a string is a valid game ID
 */
export function isValidGameId(id: string): id is GameId {
  return GAME_IDS.includes(id as GameId);
}

/**
 * Check if a string is a valid leaderboard game ID
 */
export function isLeaderboardGameId(id: string): id is LeaderboardGameId {
  return LEADERBOARD_GAME_IDS.includes(id as LeaderboardGameId);
}
