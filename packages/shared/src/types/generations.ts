/**
 * AI Media Types (Shared)
 *
 * Types used across the client and backend for AI media generation tracking
 */

/**
 * Type of media generation
 */
export type GenerationType = 'image' | 'video';

/**
 * Generation metadata
 */
export interface Generation {
  /** Unique generation ID */
  id: string;

  /** Timestamp of generation */
  timestamp: string;

  /** Concept name (can be reused across versions) */
  name: string;

  /** Descriptive version (e.g., "initial", "cartoon", "more_cartoon") */
  version: string;

  /** Iteration number for parallel variants (0, 1, 2...) */
  iteration: number;

  /** Custom labels for organization */
  labels?: Record<string, string>;

  /** Type of generation */
  type: GenerationType;

  /** Model used for generation */
  model: string;

  /** Full input parameters */
  input: Record<string, any>;

  /** Output URLs */
  output: {
    url: string;
    cloudfront_url?: string;
    metadata?: Record<string, any>;
  };

  /** Repository context */
  repoOwner?: string;
  repoName?: string;

  /** User who created this generation */
  userId: string;
}

/**
 * Version information summary
 */
export interface VersionInfo {
  /** Version name */
  version: string;

  /** Number of iterations */
  iterations: number;

  /** Latest timestamp */
  latest_timestamp: string;

  /** Model used */
  model?: string;
}

/**
 * Filters for listing generations
 */
export interface GenerationFilters {
  /** Filter by name */
  name?: string;

  /** Filter by version */
  version?: string;

  /** Filter by iteration */
  iteration?: number;

  /** Filter by type */
  type?: GenerationType;

  /** Filter by model */
  model?: string;

  /** Filter by labels */
  labels?: Record<string, string>;

  /** Repository context */
  repoOwner?: string;
  repoName?: string;

  /** Pagination */
  limit?: number;
  offset?: number;
}

/**
 * Generations database structure
 */
export interface GenerationsDatabase {
  /** All generations */
  generations: Generation[];

  /** Schema version */
  version: string;
}
