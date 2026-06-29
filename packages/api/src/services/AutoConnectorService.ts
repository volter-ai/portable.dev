import { ConnectionsService } from './ConnectionsService';

/**
 * AutoConnectorService
 *
 * Automatically creates the GitHub connector on user login.
 * The connector is created with isActive=true because the user already has
 * the credentials from their session (from OAuth).
 *
 * Key Features:
 * - Runs on every /api/user call with intelligent deduplication
 * - Fire-and-forget pattern (non-blocking, graceful error handling)
 * - Race condition safe (database UNIQUE constraints prevent duplicates)
 * - Creates connectors only if session tokens exist
 * - Skips if connectors already exist
 *
 * Responsibilities:
 * - Check if user has required tokens in session
 * - Create connector entries if they don't exist
 * - Mark connectors as active (isActive=true) - already authenticated
 * - Handle errors gracefully without blocking user authentication
 * - Log all operations for debugging
 */
export class AutoConnectorService {
  constructor(private connectionsService: ConnectionsService) {}

  /**
   * Ensure user has the GitHub connector
   * Called on every /api/user request (idempotent with deduplication)
   *
   * Uses fire-and-forget pattern - errors logged but don't throw
   *
   * @param userId - User email
   * @param authToken - JWT auth token
   * @param githubToken - GitHub OAuth token from session
   */
  async ensureDefaultConnectors(
    userId: string,
    authToken?: string,
    githubToken?: string
  ): Promise<void> {
    // Create GitHub connector if token available
    this.createGitHubConnector(userId, authToken, githubToken).catch((err) =>
      console.error('[AutoConnector] GitHub connector creation failed:', err.message)
    );
  }

  /**
   * Create GitHub connector if token exists and connector doesn't exist
   *
   * GitHub connector is created as 'cli' type and marked as active (isActive=true)
   * because the user already has the GitHub token from OAuth session.
   */
  private async createGitHubConnector(
    userId: string,
    authToken?: string,
    githubToken?: string
  ): Promise<void> {
    // Check if token exists in session
    if (!githubToken) {
      console.log(`[AutoConnector] Skipping GitHub connector for ${userId} - no token in session`);
      return;
    }

    // Check if connector already exists
    const existing = await this.connectionsService.getConnectionsByService({
      userId,
      service: 'github',
      authToken,
    });

    if (existing.length > 0) {
      console.log(`[AutoConnector] GitHub connector already exists for ${userId}`);
      return;
    }

    // Create connector with isActive=true (already authenticated)
    try {
      await this.connectionsService.storeConnection({
        userId,
        service: 'github',
        serviceType: 'cli',
        connectionId: 'github',
        displayName: 'GitHub',
        credentials: { token: githubToken },
        authToken,
      });
      console.log(`[AutoConnector] ✓ Created GitHub connector for ${userId}`);
    } catch (error: any) {
      // Handle duplicate key error (race condition - another request created it)
      if (error.code === '23505') {
        console.log(
          `[AutoConnector] GitHub connector already created (race condition handled) for ${userId}`
        );
        return;
      }
      // Re-throw other errors for logging in caller
      throw error;
    }
  }
}
