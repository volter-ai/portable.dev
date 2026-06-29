/**
 * Generations Tracker
 *
 * Manages the .volter/generations.json file with collision detection,
 * versioning, and iteration tracking.
 */

import * as fs from 'fs';
import * as path from 'path';

import type {
  Generation,
  GenerationsDatabase,
  VersionInfo,
  GenerationFilters,
} from '@vgit2/shared/types';

const GENERATIONS_FILE = '.volter/generations.json';
const DB_VERSION = '1.0.0';

/**
 * Version collision information
 */
export interface CollisionResult {
  /** Whether a collision exists */
  hasCollision: boolean;

  /** Existing generation that conflicts */
  existingGeneration?: Generation;

  /** All versions for this name */
  allVersions?: VersionInfo[];
}

/**
 * Generations Tracker class
 */
export class GenerationsTracker {
  private repoPath: string;
  private generationsFilePath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    this.generationsFilePath = path.join(repoPath, GENERATIONS_FILE);
  }

  /**
   * Load generations database
   */
  private loadDatabase(): GenerationsDatabase {
    try {
      // Ensure .volter directory exists
      const volterDir = path.join(this.repoPath, '.volter');
      if (!fs.existsSync(volterDir)) {
        fs.mkdirSync(volterDir, { recursive: true });
      }

      // Load existing database
      if (fs.existsSync(this.generationsFilePath)) {
        const content = fs.readFileSync(this.generationsFilePath, 'utf-8');
        return JSON.parse(content);
      }

      // Create new database
      return {
        version: DB_VERSION,
        generations: [],
      };
    } catch (error) {
      console.error('[GenerationsTracker] Error loading database:', error);
      return {
        version: DB_VERSION,
        generations: [],
      };
    }
  }

  /**
   * Save generations database
   */
  private saveDatabase(db: GenerationsDatabase): void {
    try {
      const volterDir = path.join(this.repoPath, '.volter');
      if (!fs.existsSync(volterDir)) {
        fs.mkdirSync(volterDir, { recursive: true });
      }

      fs.writeFileSync(this.generationsFilePath, JSON.stringify(db, null, 2), 'utf-8');
    } catch (error) {
      console.error('[GenerationsTracker] Error saving database:', error);
      throw new Error(`Failed to save generations database: ${error}`);
    }
  }

  /**
   * Check if name + version combination already exists
   */
  checkVersionCollision(name: string, version: string): CollisionResult {
    const db = this.loadDatabase();

    const existingGeneration = db.generations.find((g) => g.name === name && g.version === version);

    if (existingGeneration) {
      const allVersions = this.getVersionsForName(name);
      return {
        hasCollision: true,
        existingGeneration,
        allVersions,
      };
    }

    return {
      hasCollision: false,
    };
  }

  /**
   * Get all versions for a given name
   */
  getVersionsForName(name: string): VersionInfo[] {
    const db = this.loadDatabase();

    const generationsForName = db.generations.filter((g) => g.name === name);

    // Group by version
    const versionMap = new Map<
      string,
      { iterations: number; latest_timestamp: string; model?: string }
    >();

    for (const gen of generationsForName) {
      const existing = versionMap.get(gen.version);
      if (!existing || new Date(gen.timestamp) > new Date(existing.latest_timestamp)) {
        versionMap.set(gen.version, {
          iterations: generationsForName.filter((g) => g.version === gen.version).length,
          latest_timestamp: gen.timestamp,
          model: gen.model,
        });
      }
    }

    return Array.from(versionMap.entries()).map(([version, info]) => ({
      version,
      ...info,
    }));
  }

  /**
   * Get next iteration number for name + version
   */
  getNextIteration(name: string, version: string): number {
    const db = this.loadDatabase();

    const existingIterations = db.generations
      .filter((g) => g.name === name && g.version === version)
      .map((g) => g.iteration);

    if (existingIterations.length === 0) {
      return 0;
    }

    return Math.max(...existingIterations) + 1;
  }

  /**
   * Save a generation
   */
  saveGeneration(generation: Generation): void {
    const db = this.loadDatabase();
    db.generations.push(generation);
    this.saveDatabase(db);
  }

  /**
   * Save multiple generations (batch)
   */
  saveGenerations(generations: Generation[]): void {
    const db = this.loadDatabase();
    db.generations.push(...generations);
    this.saveDatabase(db);
  }

  /**
   * List generations with filters
   */
  listGenerations(filters: GenerationFilters = {}): Generation[] {
    const db = this.loadDatabase();
    let filtered = db.generations;

    // Apply filters
    if (filters.name) {
      filtered = filtered.filter((g) => g.name === filters.name);
    }
    if (filters.version) {
      filtered = filtered.filter((g) => g.version === filters.version);
    }
    if (filters.iteration !== undefined) {
      filtered = filtered.filter((g) => g.iteration === filters.iteration);
    }
    if (filters.type) {
      filtered = filtered.filter((g) => g.type === filters.type);
    }
    if (filters.model) {
      filtered = filtered.filter((g) => g.model === filters.model);
    }
    if (filters.repoOwner) {
      filtered = filtered.filter((g) => g.repoOwner === filters.repoOwner);
    }
    if (filters.repoName) {
      filtered = filtered.filter((g) => g.repoName === filters.repoName);
    }
    if (filters.labels) {
      filtered = filtered.filter((g) => {
        if (!g.labels) return false;
        return Object.entries(filters.labels!).every(([key, value]) => g.labels![key] === value);
      });
    }

    // Sort by timestamp (newest first)
    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Apply pagination
    const offset = filters.offset || 0;
    const limit = filters.limit || filtered.length;

    return filtered.slice(offset, offset + limit);
  }

  /**
   * Get a specific generation by name + version + iteration
   */
  getGeneration(name: string, version: string, iteration: number): Generation | undefined {
    const db = this.loadDatabase();
    return db.generations.find(
      (g) => g.name === name && g.version === version && g.iteration === iteration
    );
  }

  /**
   * Get all names (unique)
   */
  getAllNames(): string[] {
    const db = this.loadDatabase();
    return Array.from(new Set(db.generations.map((g) => g.name)));
  }

  /**
   * Generate a unique generation ID
   */
  generateId(): string {
    return `gen_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
