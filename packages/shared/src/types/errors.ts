/**
 * Error types for structured error handling
 */

export interface ErrorContext {
  [key: string]: any;
}

/**
 * Structured error response format
 */
export interface StructuredErrorResponse {
  error: {
    code: string;
    message: string;
    context?: ErrorContext;
  };
  requestId?: string;
  timestamp: string;
}

/**
 * User-friendly formatted error message
 */
export interface FormattedError {
  title: string;
  message: string;
  action?: string;
  details?: string;
  code: string;
}

/**
 * Error returned when a GitHub token is expired or invalid (401 from GitHub API).
 * The client should prompt the user to reconnect their GitHub account.
 */
export interface GitHubTokenExpiredError {
  error: 'GITHUB_TOKEN_EXPIRED';
  requiresReconnect: true;
  message: string;
}
