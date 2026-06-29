import crypto from 'crypto';

import { FEATURE_FLAGS } from '../config/featureFlags.js';
import { buildSuggestionsPrompt } from '../prompts/suggestions.js';

import type { LocalAiHelper } from './ai/LocalAiHelper.js';
import type { GitHubApiService } from './GitHubApiService.js';

export interface SuggestionRepo {
  owner: string;
  name: string;
  ownerAvatarUrl?: string;
}

export interface Suggestion {
  name: string; // Brief label like "Fix profile bug"
  completion: string; // Autocomplete text like " profile page rendering bug in user/dashboard"
  repo: SuggestionRepo | null; // Structured repo data or null for general tasks
  taskReference: string | null; // Task description or ID this relates to
  issueNumber?: number | null; // Issue number if this is from a GitHub issue
}

interface SuggestionsParams {
  message?: string | null;
  framework?: string | null;
  userId: string; // For fetching tasks from cache
  view?: string; // 'my' or 'all' for tasks view
  req: any; // Express Request object for fetching repos
}

interface CachedSuggestions {
  suggestions: Suggestion[];
  timestamp: number;
}

export class SuggestionsService {
  private githubApiService: GitHubApiService;
  private localAiHelper?: LocalAiHelper;
  private cache: Map<string, CachedSuggestions> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(githubApiService: GitHubApiService, localAiHelper?: LocalAiHelper) {
    this.githubApiService = githubApiService;
    this.localAiHelper = localAiHelper;
    console.log('[SuggestionsService] Initialized with GitHubApiService');
  }

  async generateSuggestions(params: SuggestionsParams): Promise<{ suggestions: Suggestion[] }> {
    // Check if suggestions feature is enabled
    if (!FEATURE_FLAGS.ENABLE_SUGGESTIONS) {
      console.log('[SuggestionsService] Feature disabled via ENABLE_SUGGESTIONS flag');
      return { suggestions: [] };
    }

    // Fetch user's repos internally
    const repos = await this.githubApiService.getSimpleReposList(params.req);
    console.log(`[SuggestionsService] Fetched ${repos.length} repos from GitHubApiService`);

    // Fetch tasks from GitHubApiService cache
    const view = params.view || 'my';
    const cacheKey = `${params.userId}_${view}`;
    const tasks: string[] = [];
    const taskMetadata: Map<
      string,
      { issueNumber: number; repoOwner: string; repoName: string; ownerAvatarUrl: string }
    > = new Map();

    // Access GitHubApiService tasks cache directly
    const cachedTasks = (this.githubApiService as any).tasksCache?.get(cacheKey);
    if (cachedTasks && cachedTasks.data) {
      // Extract task titles from open issues and PRs (sorted by recency) with metadata
      if (cachedTasks.data.open_issues && Array.isArray(cachedTasks.data.open_issues)) {
        cachedTasks.data.open_issues.slice(0, 10).forEach((issue: any) => {
          tasks.push(issue.title);
          taskMetadata.set(issue.title, {
            issueNumber: issue.number,
            repoOwner: issue.repository?.owner?.login || '',
            repoName: issue.repository?.name || '',
            ownerAvatarUrl: issue.repository?.owner?.avatarUrl || '', // GraphQL uses camelCase
          });
        });
      }
      if (cachedTasks.data.prs && Array.isArray(cachedTasks.data.prs)) {
        cachedTasks.data.prs.slice(0, 10).forEach((pr: any) => {
          tasks.push(pr.title);
          taskMetadata.set(pr.title, {
            issueNumber: pr.number,
            repoOwner: pr.repository?.owner?.login || '',
            repoName: pr.repository?.name || '',
            ownerAvatarUrl: pr.repository?.owner?.avatarUrl || '', // GraphQL uses camelCase
          });
        });
      }
    }

    console.log('[SuggestionsService] Fetched tasks from GitHubApiService cache:', tasks.length);

    // If no tasks available, return empty suggestions
    if (tasks.length === 0) {
      console.log('[SuggestionsService] No tasks available, returning empty suggestions');
      return { suggestions: [] };
    }

    // Create params with tasks and repos for cache key generation
    const paramsWithTasksAndRepos = { ...params, tasks, repos };

    // Check cache first
    const suggestionsCacheKey = this.getCacheKey(paramsWithTasksAndRepos);
    const cached = this.cache.get(suggestionsCacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      console.log(
        '[SuggestionsService] Cache hit for key:',
        suggestionsCacheKey.substring(0, 8) + '...'
      );
      return { suggestions: cached.suggestions };
    }

    console.log('[SuggestionsService] Cache miss, generating new suggestions');

    // Local-first: generate suggestions with the user's OWN Anthropic credential (Haiku).
    // Suggestions are non-critical, so degrade to none if unavailable.
    const aiHelper = this.localAiHelper;
    if (!aiHelper || !aiHelper.isAvailable()) {
      console.warn(
        '[SuggestionsService] No local Anthropic credential — returning empty suggestions'
      );
      return { suggestions: [] };
    }

    const prompt = buildSuggestionsPrompt(paramsWithTasksAndRepos, taskMetadata);

    try {
      console.log(
        '[SuggestionsService] Generating suggestions via local Anthropic credential (Haiku)...'
      );

      const parsed = await aiHelper.completeJson<{ suggestions?: Suggestion[] }>(prompt, {
        temperature: 0.3,
        maxTokens: 1024,
      });
      const suggestions: Suggestion[] = parsed.suggestions || [];

      console.log('[SuggestionsService] Generated suggestions:', suggestions);

      // Validate and sanitize suggestions, enriching with metadata
      const validatedSuggestions = suggestions.map((s) => {
        const metadata = s.taskReference ? taskMetadata.get(s.taskReference) : null;

        return {
          name: s.name || 'Unnamed suggestion',
          completion: s.completion || '',
          repo:
            s.repo && s.repo.owner && s.repo.name
              ? {
                  owner: s.repo.owner,
                  name: s.repo.name,
                  ownerAvatarUrl: metadata?.ownerAvatarUrl || s.repo.ownerAvatarUrl,
                }
              : null,
          taskReference: s.taskReference || null,
          issueNumber: metadata?.issueNumber || s.issueNumber || null,
        };
      });

      // Cache the result
      this.cache.set(suggestionsCacheKey, {
        suggestions: validatedSuggestions,
        timestamp: Date.now(),
      });

      // Cleanup old cache entries
      this.cleanupCache();

      return { suggestions: validatedSuggestions };
    } catch (error) {
      // Non-critical — degrade to no suggestions rather than failing the request.
      console.error('[SuggestionsService] Error generating suggestions, returning none:', error);
      return { suggestions: [] };
    }
  }

  private getCacheKey(params: SuggestionsParams & { tasks?: string[]; repos: string[] }): string {
    // Sort repos and tasks to ensure consistent cache keys
    const normalizedParams = {
      message: params.message || '',
      repos: [...params.repos].sort(),
      tasks: params.tasks ? [...params.tasks].sort() : [],
      framework: params.framework || '',
    };

    return crypto.createHash('sha256').update(JSON.stringify(normalizedParams)).digest('hex');
  }

  private cleanupCache() {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp >= this.CACHE_TTL) {
        console.log(
          '[SuggestionsService] Removing stale cache entry:',
          key.substring(0, 8) + '...'
        );
        this.cache.delete(key);
      }
    }
  }
}
