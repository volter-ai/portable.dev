/**
 * SqliteLeaderboardStore - SQLite-backed storage for the vibewaiting leaderboard
 * domain (local-first).
 *
 * The local-first PC runtime has no external database, so the three leaderboard
 * tables (`leaderboard_scores`, `leaderboard_plays`,
 * `leaderboard_ratings`) live in a single SQLite database under DATA_DIR.
 * The semantics are:
 *
 *   - leaderboard_scores  : one row per (user_id, game), keeping the BEST score
 *     (caller decides "is new best"); ranking is "better scores + same-score
 *     earlier timestamps + 1".
 *   - leaderboard_plays   : one row per (user_id, game), an incrementing
 *     play_count.
 *   - leaderboard_ratings : one row per (user_id, game), a 1-5 rating.
 *
 * Single-user scoping: a PC install serves exactly ONE user, so access control
 * is enforced at the route level. The (user_id, game) keying the upserts rely on
 * is preserved here as a composite PRIMARY KEY.
 *
 * Layout (under `dataDir`, default `resolveDataDir()` = DATA_DIR):
 *   leaderboard.sqlite   Single database file holding all three tables.
 *
 * Concurrency: bun:sqlite is synchronous, so every mutation completes atomically
 * relative to other JS execution — no write-serialization chain is needed
 * (mirrors SqliteThemeStore / SqlitePushStore).
 *
 * ⚠️ bun:sqlite's `.get()` returns `null` (not `undefined`) for no row — use
 * `!= null` / falsy checks, never `!== undefined`.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import { resolveDataDir } from '@vgit2/shared/secrets';
import { Database } from 'bun:sqlite';

/** Filename of the SQLite database inside the data directory. */
export const SQLITE_LEADERBOARD_DB_FILE = 'leaderboard.sqlite';

/** Raw `leaderboard_scores` table row. */
export interface DbScoreRow {
  user_id: string;
  username: string;
  avatar: string;
  game: string;
  score: number;
  timestamp: string;
}

/** Raw `leaderboard_plays` table row. */
interface DbPlayRow {
  user_id: string;
  game: string;
  play_count: number;
}

/** Raw `leaderboard_ratings` table row. */
interface DbRatingRow {
  user_id: string;
  game: string;
  rating: number;
}

export class SqliteLeaderboardStore {
  private readonly dbPath: string;
  private readonly dataDir: string;
  private db!: Database;

  /**
   * @param dataDir Directory for the leaderboard SQLite database. Defaults to
   *                `resolveDataDir()` (DATA_DIR) — the same root the
   *                LocalSecretStore and the other Sqlite*Stores use.
   */
  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? resolveDataDir();
    this.dbPath = path.join(this.dataDir, SQLITE_LEADERBOARD_DB_FILE);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.db = new Database(this.dbPath, { create: true });
    this.db.exec('PRAGMA busy_timeout = 5000');
    // WAL avoids torn writes, but may be unsupported on FUSE-backed volumes;
    // fall back to TRUNCATE (kernel-local locks) rather than failing startup.
    // Same probe pattern as SqliteThemeStore / SqlitePushStore.
    try {
      const mode = this.db.prepare<{ journal_mode: string }>('PRAGMA journal_mode = WAL').get();
      if ((mode?.journal_mode ?? '').toLowerCase() !== 'wal') {
        throw new Error(`journal_mode pragma returned '${mode?.journal_mode}'`);
      }
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec('COMMIT');
    } catch (error) {
      console.warn(
        '[SqliteLeaderboardStore] WAL unavailable on this filesystem, falling back to TRUNCATE journal:',
        error
      );
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // No transaction was open.
      }
      this.db.exec('PRAGMA journal_mode = TRUNCATE');
    }
    this.db.exec('PRAGMA synchronous = NORMAL');

    // Best score per (user_id, game) — composite PK = the old upsert key.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leaderboard_scores (
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        avatar TEXT NOT NULL,
        game TEXT NOT NULL,
        score INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        PRIMARY KEY (user_id, game)
      );
    `);
    // Helps the leaderboard ORDER BY score DESC, timestamp ASC + rank counts.
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_leaderboard_scores_game_score ON leaderboard_scores (game, score, timestamp)'
    );

    // Play count per (user_id, game).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leaderboard_plays (
        user_id TEXT NOT NULL,
        game TEXT NOT NULL,
        play_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, game)
      );
    `);

    // Rating (1-5) per (user_id, game).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leaderboard_ratings (
        user_id TEXT NOT NULL,
        game TEXT NOT NULL,
        rating INTEGER NOT NULL,
        PRIMARY KEY (user_id, game)
      );
    `);
  }

  close(): void {
    this.db?.close();
  }

  // ==========================================================================
  // SCORES
  // ==========================================================================

  /**
   * Get a user's score row for a game, or null when there is none.
   */
  getScore(userId: string, game: string): DbScoreRow | null {
    const row = this.db
      .prepare<DbScoreRow>(
        'SELECT user_id, username, avatar, game, score, timestamp FROM leaderboard_scores WHERE user_id = ? AND game = ?'
      )
      .get(userId, game);
    // bun:sqlite's .get() returns null (not undefined) when there is no row.
    return row == null ? null : row;
  }

  /**
   * Upsert the score row for (user_id, game) — keyed on (user_id, game).
   * Returns the persisted row.
   */
  upsertScore(row: DbScoreRow): DbScoreRow {
    this.db
      .prepare(
        `INSERT INTO leaderboard_scores (user_id, username, avatar, game, score, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, game) DO UPDATE SET
           username = excluded.username,
           avatar = excluded.avatar,
           score = excluded.score,
           timestamp = excluded.timestamp`
      )
      .run(row.user_id, row.username, row.avatar, row.game, row.score, row.timestamp);
    return row;
  }

  /**
   * Top scores for a game, ordered by score DESC then timestamp ASC (the tie
   * break). `limit` caps the rows returned.
   */
  getTopScores(game: string, limit: number): DbScoreRow[] {
    return this.db
      .prepare<DbScoreRow>(
        `SELECT user_id, username, avatar, game, score, timestamp
           FROM leaderboard_scores
           WHERE game = ?
           ORDER BY score DESC, timestamp ASC
           LIMIT ?`
      )
      .all(game, limit);
  }

  /** Total number of players (score rows) for a game. */
  countPlayers(game: string): number {
    const row = this.db
      .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM leaderboard_scores WHERE game = ?')
      .get(game);
    return row == null ? 0 : row.c;
  }

  /** Count of scores strictly better (higher) than `score` for a game. */
  countBetterScores(game: string, score: number): number {
    const row = this.db
      .prepare<{
        c: number;
      }>('SELECT COUNT(*) AS c FROM leaderboard_scores WHERE game = ? AND score > ?')
      .get(game, score);
    return row == null ? 0 : row.c;
  }

  /** Count of same-score rows with an earlier timestamp (tie-break ordering). */
  countSameScoreEarlier(game: string, score: number, timestamp: string): number {
    const row = this.db
      .prepare<{
        c: number;
      }>(
        'SELECT COUNT(*) AS c FROM leaderboard_scores WHERE game = ? AND score = ? AND timestamp < ?'
      )
      .get(game, score, timestamp);
    return row == null ? 0 : row.c;
  }

  /** Top score for a game, or null when there are no scores. */
  getTopScore(game: string): number | null {
    const row = this.db
      .prepare<{
        score: number;
      }>('SELECT score FROM leaderboard_scores WHERE game = ? ORDER BY score DESC LIMIT 1')
      .get(game);
    return row == null ? null : row.score;
  }

  /** Delete every score row for a game. */
  deleteScoresForGame(game: string): void {
    this.db.prepare('DELETE FROM leaderboard_scores WHERE game = ?').run(game);
  }

  /** Delete ALL score rows (every game / every user). */
  deleteAllScores(): void {
    this.db.prepare('DELETE FROM leaderboard_scores').run();
  }

  // ==========================================================================
  // PLAYS
  // ==========================================================================

  /** Current play_count for (user_id, game), or 0 when there is no row. */
  getPlayCount(userId: string, game: string): number {
    const row = this.db
      .prepare<DbPlayRow>(
        'SELECT user_id, game, play_count FROM leaderboard_plays WHERE user_id = ? AND game = ?'
      )
      .get(userId, game);
    return row == null ? 0 : row.play_count;
  }

  /** Upsert the play_count for (user_id, game). */
  upsertPlayCount(userId: string, game: string, playCount: number): void {
    this.db
      .prepare(
        `INSERT INTO leaderboard_plays (user_id, game, play_count)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id, game) DO UPDATE SET play_count = excluded.play_count`
      )
      .run(userId, game, playCount);
  }

  /** All play_count values for a game (one per user that played). */
  getAllPlayCounts(game: string): number[] {
    return this.db
      .prepare<{ play_count: number }>('SELECT play_count FROM leaderboard_plays WHERE game = ?')
      .all(game)
      .map((r) => r.play_count);
  }

  // ==========================================================================
  // RATINGS
  // ==========================================================================

  /** Upsert the rating for (user_id, game). */
  upsertRating(userId: string, game: string, rating: number): void {
    this.db
      .prepare(
        `INSERT INTO leaderboard_ratings (user_id, game, rating)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id, game) DO UPDATE SET rating = excluded.rating`
      )
      .run(userId, game, rating);
  }

  /** All rating values for a game (one per user that rated). */
  getAllRatings(game: string): number[] {
    return this.db
      .prepare<{ rating: number }>('SELECT rating FROM leaderboard_ratings WHERE game = ?')
      .all(game)
      .map((r) => r.rating);
  }

  /** A user's rating for a game, or null when they have not rated it. */
  getUserRating(userId: string, game: string): number | null {
    const row = this.db
      .prepare<DbRatingRow>(
        'SELECT user_id, game, rating FROM leaderboard_ratings WHERE user_id = ? AND game = ?'
      )
      .get(userId, game);
    return row == null ? null : row.rating;
  }
}
