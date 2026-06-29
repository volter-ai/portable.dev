import { Octokit } from '@octokit/rest';
import { Request, Response } from 'express';

import { isUpstreamUnreachableError } from '../../../utils/fetchWithTimeout.js';
import { GitHubConnectionError } from '../GitHubConnectionError.js';
import { RepoReasonAndScore, GitStatus } from '../types.js';

/**
 * Format time ago with action prefix (e.g., "Worked 2h ago", "Viewed 3d ago")
 */
export function formatTimeAgo(dateString: string | null, action: string): string {
  if (!dateString) return '';

  const now = new Date().getTime();
  const then = new Date(dateString).getTime();
  const seconds = Math.floor((now - then) / 1000);

  let timeStr = '';
  if (seconds < 60) {
    timeStr = `${seconds}s ago`;
  } else {
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      timeStr = `${minutes}m ago`;
    } else {
      const hours = Math.floor(minutes / 60);
      if (hours < 24) {
        timeStr = `${hours}h ago`;
      } else {
        const days = Math.floor(hours / 24);
        if (days < 30) {
          timeStr = `${days}d ago`;
        } else {
          const months = Math.floor(days / 30);
          if (months < 12) {
            timeStr = `${months}mo ago`;
          } else {
            const years = Math.floor(months / 12);
            timeStr = `${years}y ago`;
          }
        }
      }
    }
  }

  return `${action} ${timeStr}`;
}

/**
 * Determine repo reason and composite sort score based on all activities
 * Returns { reason, sortScore } where:
 * - reason: Display text (e.g., "Worked 2h ago", "Viewed 3d ago")
 * - sortScore: Composite weighted score summing all activities (higher = more recent/relevant)
 *
 * Composite weighted scoring system:
 * Score = Σ(weight / days_since_activity) for each activity type
 * - Worked (chat/changes): 10.0 weight (highest priority)
 * - Viewed (local clone): 2.0 weight (medium priority)
 * - Updated (GitHub): 1.0 weight (lowest priority)
 *
 * All activities contribute to the final score, with more recent and higher-priority
 * activities contributing more to the total.
 */
export function determineRepoReasonAndScore(
  repo: any,
  isLocal: boolean,
  lastUpdated: string | null,
  gitStatus: GitStatus | null,
  lastChatActivity: string | null
): RepoReasonAndScore {
  let reason = '';
  let activityType = 'updated';

  const hasChanges =
    gitStatus &&
    (gitStatus.staged > 0 ||
      gitStatus.modified > 0 ||
      gitStatus.untracked > 0 ||
      gitStatus.insertions > 0 ||
      gitStatus.deletions > 0);

  // Get timestamps for all activity types
  const chatTime = lastChatActivity ? new Date(lastChatActivity).getTime() : 0;
  const localTime = lastUpdated ? new Date(lastUpdated).getTime() : 0;
  const remoteTime = repo.updated_at ? new Date(repo.updated_at).getTime() : 0;
  const now = Date.now();
  const ONE_DAY = 1000 * 60 * 60 * 24;

  // Calculate composite score by summing all activities
  // Formula: Score = Σ(weight / days_since_activity)
  // Higher score = more recent/relevant
  let sortScore = 0;
  let workedScore = 0;
  let viewedScore = 0;
  let updatedScore = 0;

  // Worked activity (chat or local changes) - 10.0 weight
  const workedTime = Math.max(chatTime, hasChanges && localTime ? localTime : 0);
  if (workedTime > 0) {
    const daysSinceWorked = Math.max(0.01, (now - workedTime) / ONE_DAY); // Min 0.01 to avoid division by zero
    workedScore = 10.0 / daysSinceWorked;
    sortScore += workedScore;
  }

  // Viewed activity (local clone without changes) - 2.0 weight
  if (isLocal && localTime > 0 && !hasChanges) {
    const daysSinceViewed = Math.max(0.01, (now - localTime) / ONE_DAY);
    viewedScore = 2.0 / daysSinceViewed;
    sortScore += viewedScore;
  }

  // Updated activity (GitHub remote update) - 1.0 weight
  if (remoteTime > 0) {
    const daysSinceUpdated = Math.max(0.01, (now - remoteTime) / ONE_DAY);
    updatedScore = 1.0 / daysSinceUpdated;
    sortScore += updatedScore;
  }

  // If no activities at all, set very low score
  if (sortScore === 0) {
    sortScore = 0.0001;
  }

  // Determine activityType based on which score component contributes MOST
  if (workedScore >= viewedScore && workedScore >= updatedScore) {
    activityType = 'worked';
  } else if (viewedScore >= updatedScore) {
    activityType = 'viewed';
  } else {
    activityType = 'updated';
  }

  // Determine reason to display (based on most recent activity)
  if (chatTime > 0 && chatTime >= localTime && chatTime >= remoteTime) {
    // Chat activity is most recent
    reason = formatTimeAgo(lastChatActivity, 'Worked');
  } else if (isLocal && localTime > remoteTime) {
    // Local activity is more recent
    if (hasChanges) {
      reason = formatTimeAgo(lastUpdated, 'Worked');
    } else {
      reason = formatTimeAgo(lastUpdated, 'Viewed');
    }
  } else if (repo.updated_at) {
    // Remote update is most recent (or repo not local)
    reason = formatTimeAgo(repo.updated_at, 'Updated');
  }

  return { reason, sortScore, activityType };
}

/**
 * Sort repos by composite weighted score: higher score = more recent/relevant
 * Uses composite scoring that sums all activity types with their weights
 * New repos (never viewed) get a +1 bonus added to their composite score
 */
export function sortReposByScore(repos: any[]): any[] {
  return repos.sort((a, b) => {
    // Add +1 bonus for "new" repos (never viewed before)
    const scoreA = (a.sortScore || 0.0001) + (a.isNew ? 1 : 0);
    const scoreB = (b.sortScore || 0.0001) + (b.isNew ? 1 : 0);

    // Higher score = higher priority (more recent/relevant)
    return scoreB - scoreA;
  });
}

/**
 * Handle GitHub API errors consistently
 * Returns true if error was handled, false otherwise
 *
 * @param _authToken - Unused; kept for call-site compatibility. The old 401
 * branch used it to DELETE the user's GitHub credentials from Clerk, which
 * permanently destroyed a valid OAuth credential whenever a stale cached
 * GitHub App token 401'd.
 */
export function handleGitHubApiError(
  error: any,
  req: Request,
  res: Response,
  _authToken?: string
): boolean {
  // Handle GitHub being unreachable (offline / DNS failure / timeout / connection
  // refused). These carry no HTTP `.status`, so without this branch they fall
  // through to a generic 500 — or, before request timeouts were added, hung the
  // route forever. Return a retryable 503 so the client backs off and the app
  // stays responsive while GitHub is down.
  if (isUpstreamUnreachableError(error)) {
    console.warn('[GitHubApiService] GitHub API unreachable:', error?.message || error);
    res.status(503).json({
      error: 'GitHub API temporarily unavailable',
      code: 'GITHUB_UNAVAILABLE',
      retryable: true,
    });
    return true;
  }

  // Handle GitHub connection errors (no token available)
  if (error instanceof GitHubConnectionError || error.code === 'NO_GITHUB_CONNECTION') {
    console.log('[GitHubApiService] Handling GitHub connection error:', error.message);
    res.status(401).json({
      error: error.message || 'GitHub account not connected. Please link your GitHub account.',
      code: 'NO_GITHUB_CONNECTION',
      needsConnection: true,
    });
    return true;
  }

  // Handle authentication errors (expired token).
  //
  // Do NOT delete Clerk credentials and do NOT destroy the session here: by
  // the time a 401 reaches this handler, the per-user Octokit hook
  // (octokitFactory) has already invalidated the token caches and retried once
  // with a freshly-fetched token — so a reconnect is legitimately required,
  // and the user performs it from their still-valid session. The old behavior
  // (fire-and-forget deleteCredentials('github_1') + session destroy) wiped a
  // perfectly valid OAuth credential whenever an unrelated stale GitHub App
  // token 401'd.
  if (error.status === 401) {
    res.status(401).json({
      error: 'GITHUB_TOKEN_EXPIRED',
      requiresReconnect: true,
      message: 'GitHub token expired or revoked. Please reconnect your GitHub account.',
    });
    return true;
  }

  // Handle permission errors (insufficient GitHub scopes)
  if (error.status === 403) {
    console.log('[GitHubApiService] 403 error - likely insufficient GitHub permissions');

    const message = error.message?.toLowerCase().includes('rate limit')
      ? 'GitHub API rate limit exceeded. Please try again later.'
      : 'Insufficient GitHub permissions. Additional scopes may be required.';

    res.status(403).json({
      error: message,
      code: error.message?.toLowerCase().includes('rate limit')
        ? 'RATE_LIMIT_EXCEEDED'
        : 'INSUFFICIENT_PERMISSIONS',
      missingScopes: error.message?.toLowerCase().includes('rate limit') ? undefined : ['repo'],
    });
    return true;
  }

  return false;
}

/**
 * Detect GitHub primary/secondary rate-limit (or abuse-detection) responses.
 * The deprecated search endpoint and rapid bursts surface these as 403/429.
 */
export function isRateLimitError(error: any): boolean {
  if (!error) return false;
  const status = error.status;
  const msg = (error.message || '').toLowerCase();
  return (
    status === 429 ||
    (status === 403 &&
      (msg.includes('rate limit') ||
        msg.includes('secondary rate') ||
        msg.includes('abuse detection')))
  );
}

/**
 * Run a GitHub API call with exponential backoff on rate-limit responses
 * (403 secondary-rate-limit / 429). Honors the `Retry-After` header when present.
 *
 * Non-rate-limit errors propagate immediately so existing error handling still applies.
 */
export async function withGitHubRetry<T>(
  fn: () => Promise<T>,
  options: { retries?: number; baseDelayMs?: number; maxDelayMs?: number; label?: string } = {}
): Promise<T> {
  const { retries = 2, baseDelayMs = 600, maxDelayMs = 4000, label = 'github' } = options;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error: any) {
      if (!isRateLimitError(error) || attempt >= retries) {
        throw error;
      }

      const headers = error.response?.headers || {};
      const retryAfter = headers['retry-after'] ?? headers['Retry-After'];
      let delayMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      if (retryAfter) {
        const parsed = parseInt(String(retryAfter), 10);
        if (!Number.isNaN(parsed) && parsed > 0) {
          delayMs = Math.min(parsed * 1000, maxDelayMs);
        }
      }

      attempt += 1;
      console.warn(
        `[${label}] GitHub rate-limited (status ${error.status}); backing off ${delayMs}ms (attempt ${attempt}/${retries})`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Bound GitHub SDK calls with an app-level timeout.
 *
 * Octokit's request timeout is not always enough to keep local runtimes from
 * leaving a route pending, so this gives handlers a deterministic failure path.
 */
export async function withGitHubTimeout<T>(
  fn: () => Promise<T>,
  options: { timeoutMs?: number; label?: string } = {}
): Promise<T> {
  const { timeoutMs = 15_000, label = 'github' } = options;
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} timed out after ${timeoutMs}ms`) as Error & {
            code?: string;
          };
          error.name = 'TimeoutError';
          error.code = 'GITHUB_REQUEST_TIMEOUT';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Build GitHub API-style Link header for pagination
 *
 * @param currentPage - Current page number
 * @param perPage - Items per page
 * @param totalCount - Total number of items
 * @returns Link header string
 */
export function buildLinkHeader(currentPage: number, perPage: number, totalCount: number): string {
  const lastPage = Math.ceil(totalCount / perPage);
  const links: string[] = [];

  // Next page
  if (currentPage < lastPage) {
    links.push(`<page=${currentPage + 1}>; rel="next"`);
  }

  // Last page
  if (currentPage < lastPage) {
    links.push(`<page=${lastPage}>; rel="last"`);
  }

  // First page
  if (currentPage > 1) {
    links.push(`<page=1>; rel="first"`);
  }

  // Previous page
  if (currentPage > 1) {
    links.push(`<page=${currentPage - 1}>; rel="prev"`);
  }

  return links.join(', ');
}

/**
 * Extract linked issue numbers from PR body text
 * Looks for patterns like: Closes #123, Fixes #456, Resolves #789
 */
export function extractLinkedIssues(body: string): number[] {
  const keywords = ['closes', 'fixes', 'resolves', 'close', 'fix', 'resolve'];
  const regex = new RegExp(`(${keywords.join('|')})\\s+#(\\d+)`, 'gi');
  const matches = Array.from(body.matchAll(regex));
  return matches.map((match) => parseInt(match[2], 10));
}

/**
 * Fetch display names for users using GraphQL
 * Returns array of { name, username } objects
 */
export async function fetchUserDisplayNames(
  octokit: Octokit,
  logins: string[]
): Promise<Array<{ name: string; username: string }>> {
  if (logins.length === 0) {
    return [];
  }

  try {
    // Build GraphQL query to fetch all users at once
    // GitHub GraphQL supports multiple queries in one request
    const queries = logins
      .map(
        (login, index) => `
      user${index}: user(login: "${login}") {
        login
        name
      }
    `
      )
      .join('\n');

    const query = `
      query {
        ${queries}
      }
    `;

    const response: any = await octokit.graphql(query);

    // Extract results and map to our format
    return logins.map((login, index) => {
      const userData = response[`user${index}`];
      return {
        name: userData?.name || login, // Use display name if available, otherwise username
        username: login,
      };
    });
  } catch (error) {
    console.error('[GitHubApiService] Error fetching user display names via GraphQL:', error);
    // Fallback: return logins as names
    return logins.map((login) => ({
      name: login,
      username: login,
    }));
  }
}
