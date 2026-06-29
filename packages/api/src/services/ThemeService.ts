import { DbAdapter } from '../db/DbAdapter.js';

/**
 * ThemeService
 *
 * Handles theme persistence using the database adapter pattern.
 * Automatically uses SQLite or JSON file storage based on the configured adapter.
 *
 * Each user has one theme configuration stored as JSON.
 */
export class ThemeService {
  constructor(private dbAdapter: DbAdapter) {
    console.log(`[ThemeService] Initialized with ${dbAdapter.getAdapterType()} adapter`);
  }

  /**
   * Get user's theme configuration
   *
   * @param userEmail - User's email address (user_id)
   * @param authToken - JWT token for RLS authentication
   * @returns Theme configuration object or null if not found
   */
  async getTheme(userEmail: string, authToken?: string): Promise<Record<string, any> | null> {
    return this.dbAdapter.getTheme(userEmail, authToken);
  }

  /**
   * Save user's theme configuration
   *
   * @param userEmail - User's email address (user_id)
   * @param themeConfig - Theme configuration object
   * @param authToken - JWT token for RLS authentication
   * @returns True if successful
   */
  async saveTheme(
    userEmail: string,
    themeConfig: Record<string, any>,
    authToken?: string
  ): Promise<boolean> {
    return this.dbAdapter.saveTheme(userEmail, themeConfig, authToken);
  }

  /**
   * Delete user's theme configuration
   *
   * @param userEmail - User's email address (user_id)
   * @param authToken - JWT token for RLS authentication
   * @returns True if successful
   */
  async deleteTheme(userEmail: string, authToken?: string): Promise<boolean> {
    return this.dbAdapter.deleteTheme(userEmail, authToken);
  }
}
