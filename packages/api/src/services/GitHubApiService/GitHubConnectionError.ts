/**
 * Error thrown when user has no GitHub connection
 * Includes .status property for consistent error handling
 */
export class GitHubConnectionError extends Error {
  status: number = 401;
  code: string = 'NO_GITHUB_CONNECTION';

  constructor(message: string = 'GitHub account not connected. Please link your GitHub account.') {
    super(message);
    this.name = 'GitHubConnectionError';
  }
}
