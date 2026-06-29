import { buildAnalysisPrompt } from '../prompts/intentAnalysis.js';

import type { LocalAiHelper } from './ai/LocalAiHelper.js';
import type { GitHubApiService } from './GitHubApiService.js';
import type { Request } from 'express';

export type IntentType = 'simple-task' | 'new-repo' | 'existing-repo';

export interface IntentAnalysis {
  reasoning: string; // explanation FIRST to encourage thinking before deciding
  intentType: IntentType; // 'simple-task' | 'new-repo' | 'existing-repo'
  suggestedName?: string; // folder name for ANY task (e.g., "ai-redesign", "my-blog", "question-123")
  suggestedFramework?: string; // only for 'new-repo', defaults to 'bun'
  useExistingRepo?: {
    // only for 'existing-repo' type
    owner: string;
    repo: string;
  };
  confidence: number; // 0-1 score
}

/**
 * IntentAnalysisService — classifies a chat message (simple-task / new-repo /
 * existing-repo) and suggests a folder name.
 *
 * Local-first: this runs a one-shot Claude (Haiku) call against the
 * user's OWN Anthropic credential via {@link LocalAiHelper}.
 * When no local credential is configured (or the AI call fails), it falls back to a
 * safe heuristic so the new-chat / repo-creation flow can NEVER hard-fail on it.
 */
export class IntentAnalysisService {
  private githubApiService: GitHubApiService;
  private localAiHelper?: LocalAiHelper;

  constructor(githubApiService: GitHubApiService, localAiHelper?: LocalAiHelper) {
    this.githubApiService = githubApiService;
    this.localAiHelper = localAiHelper;
    console.log('[IntentAnalysisService] Initialized with GitHubApiService');
  }

  async analyzeIntent(
    req: Request,
    message: string,
    pageContext: any = {}
  ): Promise<IntentAnalysis> {
    // Fetch user's repos internally
    const existingRepos = await this.githubApiService.getSimpleReposList(req);
    console.log(
      `[IntentAnalysisService] Fetched ${existingRepos.length} repos from GitHubApiService`
    );

    // Local-first: AI runs on the user's OWN Anthropic credential. If none is
    // configured, degrade to a heuristic rather than throwing (the new-chat flow
    // depends on this call succeeding).
    if (!this.localAiHelper?.isAvailable()) {
      console.warn(
        '[IntentAnalysisService] No local Anthropic credential available — using heuristic fallback'
      );
      return this.fallbackIntent(message);
    }

    const prompt = buildAnalysisPrompt(message, existingRepos, pageContext);

    try {
      const analysis = await this.localAiHelper.completeJson<IntentAnalysis>(prompt, {
        temperature: 0.3,
        maxTokens: 1024,
      });

      console.log('[IntentAnalysisService] Raw analysis:', analysis);

      // Validate and sanitize the response (fall back to a derived name if missing)
      return {
        reasoning: analysis.reasoning || 'No reasoning provided',
        intentType: analysis.intentType || 'simple-task',
        suggestedName:
          this.sanitizeName(analysis.suggestedName) || this.deriveFallbackName(message),
        suggestedFramework: analysis.suggestedFramework || undefined,
        useExistingRepo: analysis.useExistingRepo || undefined,
        confidence: Math.max(0, Math.min(1, analysis.confidence || 0.5)),
      };
    } catch (error) {
      console.error(
        '[IntentAnalysisService] Local AI intent analysis failed, using heuristic fallback:',
        error
      );
      return this.fallbackIntent(message);
    }
  }

  /**
   * Safe default when the AI call can't run: treat the message as a simple task
   * (least-destructive — creates a local folder, not a GitHub repo) with a name
   * derived from the message text.
   */
  private fallbackIntent(message: string): IntentAnalysis {
    return {
      reasoning: 'Local heuristic fallback (no AI intent classification available).',
      intentType: 'simple-task',
      suggestedName: this.deriveFallbackName(message),
      confidence: 0.3,
    };
  }

  /** Derive a kebab-case folder name from the first few words of the message. */
  private deriveFallbackName(message: string): string {
    const slug = this.sanitizeName(message.split(/\s+/).slice(0, 6).join('-'));
    return slug || 'new-task';
  }

  private sanitizeName(name?: string): string | undefined {
    if (!name) return undefined;

    // Convert to kebab-case and remove special characters
    const sanitized = name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50); // Limit length

    return sanitized || undefined;
  }
}
