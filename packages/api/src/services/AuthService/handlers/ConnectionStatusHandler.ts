import { debugLog } from '@vgit2/shared/constants';

import type { HandlerDependencies } from '../types';

/**
 * ConnectionStatusHandler - Manages service dependencies
 *
 * Responsibilities:
 * - Service injection
 * - Dependency management
 */
export class ConnectionStatusHandler {
  private dependencies: HandlerDependencies;

  constructor(dependencies: HandlerDependencies) {
    this.dependencies = dependencies;
    debugLog('[ConnectionStatusHandler] Initialized');
  }

  /**
   * Set GitHubApiService dependency (for lazy initialization)
   * Called after GitHubApiService is created since there's a circular dependency
   */
  setGitHubApiService(githubApiService: any): void {
    this.dependencies.githubApiService = githubApiService;
    debugLog('[ConnectionStatusHandler] GitHubApiService dependency injected');
  }

  /**
   * Get current dependencies
   */
  getDependencies(): HandlerDependencies {
    return this.dependencies;
  }
}
