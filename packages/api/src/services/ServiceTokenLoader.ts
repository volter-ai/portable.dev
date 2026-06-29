/**
 * ServiceTokenLoader - Secure service token management
 *
 * Loads SERVICE_TOKEN from a protected file instead of environment variables
 * for enhanced security (file-based, owner-read-only).
 *
 * Security features:
 * - Token stored in file with 400 permissions (read-only by owner)
 * - File owned by node:node (application user)
 * - Token loaded once and kept in memory
 * - Fallback to environment variable for local development
 */

import * as fs from 'fs';
import * as path from 'path';

class ServiceTokenLoader {
  private static instance: ServiceTokenLoader;
  private token: string | null = null;
  private readonly tokenPath = '/app/.service-token';
  private isLoaded = false;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): ServiceTokenLoader {
    if (!ServiceTokenLoader.instance) {
      ServiceTokenLoader.instance = new ServiceTokenLoader();
    }
    return ServiceTokenLoader.instance;
  }

  /**
   * Get service token
   * Loads from file on first call, returns cached value on subsequent calls
   */
  getToken(): string {
    if (!this.isLoaded) {
      this.loadToken();
    }
    return this.token || '';
  }

  /**
   * Load token from file or environment
   */
  private loadToken(): void {
    this.isLoaded = true;

    try {
      // Check if the service token file exists
      if (fs.existsSync(this.tokenPath)) {
        // Verify file permissions for security
        const stats = fs.statSync(this.tokenPath);
        const mode = (stats.mode & parseInt('777', 8)).toString(8);

        if (mode !== '400') {
          console.warn(
            `[ServiceTokenLoader] Warning: Token file has unexpected permissions: ${mode} (expected: 400)`
          );
        }

        // Read token from protected file
        const fileContent = fs.readFileSync(this.tokenPath, 'utf-8').trim();

        if (!fileContent) {
          throw new Error('Token file is empty');
        }

        this.token = fileContent;

        // Don't log the token itself for security
        console.log('[ServiceTokenLoader] Service token loaded from protected file');
      } else {
        // Fallback to environment variable (local development)
        this.loadFromEnvironment();
      }
    } catch (error) {
      console.error('[ServiceTokenLoader] Failed to load token from file:', error);

      // Try fallback to environment
      this.loadFromEnvironment();
    }
  }

  /**
   * Fallback: Load token from environment variable
   * Used in local development or if file reading fails
   */
  private loadFromEnvironment(): void {
    const envToken = process.env.SERVICE_TOKEN;

    if (envToken) {
      this.token = envToken;
      console.log(
        '[ServiceTokenLoader] Service token loaded from environment variable (fallback mode)'
      );
    } else {
      // In production, this is a critical error
      const isProduction = process.env.NODE_ENV === 'production';

      if (isProduction) {
        console.error('[ServiceTokenLoader] CRITICAL: No service token available in production!');
      } else {
        console.warn('[ServiceTokenLoader] No service token available (development mode)');
      }

      this.token = '';
    }
  }

  /**
   * Check if token is available
   */
  hasToken(): boolean {
    if (!this.isLoaded) {
      this.loadToken();
    }
    return !!this.token && this.token.length > 0;
  }

  /**
   * Clear cached token (for testing purposes)
   */
  clearCache(): void {
    this.token = null;
    this.isLoaded = false;
  }
}

// Export singleton instance
export default ServiceTokenLoader.getInstance();
