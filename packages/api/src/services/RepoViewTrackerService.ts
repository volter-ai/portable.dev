import { promises as fs } from 'fs';
import path from 'path';

import { getUserWorkspaceDir } from '@vgit2/shared/constants';

/**
 * RepoViewTrackerService tracks which repos each user has viewed
 * Stores data in user's workspace: {workspace}/.vgit/repo-views.json
 */
export class RepoViewTrackerService {
  private cache: Map<string, Set<string>> = new Map();

  /**
   * Initialize the service (no-op, directories created per-user)
   */
  async initialize(): Promise<void> {
    console.log('[RepoViewTracker] Initialized');
  }

  /**
   * Get file path for user's viewed repos in their workspace
   */
  private getUserFilePath(userId: string): string {
    const userWorkspace = getUserWorkspaceDir(userId);
    const vgitDir = path.join(userWorkspace, '.vgit');
    return path.join(vgitDir, 'repo-views.json');
  }

  /**
   * Ensure .vgit directory exists in user's workspace
   */
  private async ensureVgitDir(userId: string): Promise<void> {
    const userWorkspace = getUserWorkspaceDir(userId);
    const vgitDir = path.join(userWorkspace, '.vgit');
    await fs.mkdir(vgitDir, { recursive: true });
  }

  /**
   * Load viewed repos for a user
   */
  private async loadViewedRepos(userId: string): Promise<Set<string>> {
    // Check cache first
    if (this.cache.has(userId)) {
      return this.cache.get(userId)!;
    }

    const filePath = this.getUserFilePath(userId);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      const repos = JSON.parse(data) as string[];
      const repoSet = new Set(repos);
      this.cache.set(userId, repoSet);
      return repoSet;
    } catch (err) {
      // File doesn't exist or is invalid - return empty set
      const repoSet = new Set<string>();
      this.cache.set(userId, repoSet);
      return repoSet;
    }
  }

  /**
   * Save viewed repos for a user
   */
  private async saveViewedRepos(userId: string, repos: Set<string>): Promise<void> {
    const filePath = this.getUserFilePath(userId);
    try {
      // Ensure .vgit directory exists
      await this.ensureVgitDir(userId);
      const repoArray = Array.from(repos);
      await fs.writeFile(filePath, JSON.stringify(repoArray, null, 2), 'utf-8');
      this.cache.set(userId, repos);
    } catch (err) {
      console.error(`[RepoViewTracker] Failed to save for ${userId}:`, err);
    }
  }

  /**
   * Mark a repo as viewed by a user
   */
  async markAsViewed(userId: string, repoFullName: string): Promise<void> {
    const viewedRepos = await this.loadViewedRepos(userId);
    if (!viewedRepos.has(repoFullName)) {
      viewedRepos.add(repoFullName);
      await this.saveViewedRepos(userId, viewedRepos);
      console.log(`[RepoViewTracker] ${userId} viewed ${repoFullName}`);
    }
  }

  /**
   * Check if a user has viewed a repo
   */
  async hasViewed(userId: string, repoFullName: string): Promise<boolean> {
    const viewedRepos = await this.loadViewedRepos(userId);
    return viewedRepos.has(repoFullName);
  }

  /**
   * Check multiple repos at once (bulk operation)
   */
  async checkMultiple(userId: string, repoFullNames: string[]): Promise<Map<string, boolean>> {
    const viewedRepos = await this.loadViewedRepos(userId);
    const result = new Map<string, boolean>();
    for (const repoFullName of repoFullNames) {
      result.set(repoFullName, viewedRepos.has(repoFullName));
    }
    return result;
  }

  /**
   * Get all viewed repos for a user
   */
  async getViewedRepos(userId: string): Promise<string[]> {
    const viewedRepos = await this.loadViewedRepos(userId);
    return Array.from(viewedRepos);
  }

  /**
   * Drop the in-memory cache for a user so the NEXT read re-reads
   * `repo-views.json` from disk.
   *
   * The viewed-repos set is loaded from disk ONCE per user and then served from
   * `this.cache` forever (only `markAsViewed` mutates it). That means an
   * out-of-process write to `repo-views.json` — e.g. `portable link`/`unlink`
   * adding/removing an entry while the api is already running — is invisible
   * until restart. Calling this after such a write forces a fresh read.
   * Returns true when a cache entry was actually present and removed.
   */
  clearCache(userId: string): boolean {
    return this.cache.delete(userId);
  }
}
