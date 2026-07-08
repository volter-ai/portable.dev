import Anthropic from '@anthropic-ai/sdk';
import { MODEL_IDS } from '@vgit2/shared/models';

import type { LocalAiCredentialsService } from '../LocalAiCredentialsService.js';

/**
 * LocalAiHelper — the auxiliary "AI helper" calls (intent analysis, project-name
 * generation, suggestions, chat summarization, follow-up action extraction).
 *
 * In local mode the PC has ONLY the user's OWN Anthropic credential (resolved by
 * {@link LocalAiCredentialsService} — Claude subscription OAuth OR a raw
 * `ANTHROPIC_API_KEY`, never a JWT claim, never a remote billing proxy).
 * Every call here is a one-shot, NON-streaming `messages.create` direct to
 * `https://api.anthropic.com` using the cheap helper model (Haiku).
 *
 * Auth differs by credential mode:
 *  - `api-key`     → `new Anthropic({ apiKey })` (sends `x-api-key`).
 *  - `claude-oauth`→ `new Anthropic({ authToken, defaultHeaders: { 'anthropic-beta' } })`
 *    (sends `Authorization: Bearer`). A Claude *subscription* OAuth token is only
 *    accepted by the API for Claude-Code-style requests, so in that mode the system
 *    prompt is led with the Claude Code identity and the OAuth beta header is set.
 *
 * Constructed ONLY in local mode (alongside LocalAiCredentialsService in server.ts).
 * Consumers treat it as optional and degrade gracefully when it is absent or
 * `isAvailable()` is false (no credential configured).
 */

/**
 * Claude subscription OAuth tokens are minted for Claude Code. The Anthropic API
 * rejects them for requests that don't present as Claude Code, so OAuth-mode calls
 * must lead the system prompt with this identity line.
 */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Anthropic beta flag that enables Claude subscription OAuth tokens on the Messages API. */
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

export interface LocalAiCompletionOptions {
  /** Max output tokens (default 1024). */
  maxTokens?: number;
  /** Sampling temperature (omitted when undefined). */
  temperature?: number;
  /** Optional system prompt (the Claude Code identity is prepended automatically in OAuth mode). */
  system?: string;
  /** Override the model id (defaults to the cheap helper model, Haiku). */
  model?: string;
}

export class LocalAiHelper {
  private readonly credentials: LocalAiCredentialsService;

  constructor(credentials: LocalAiCredentialsService) {
    this.credentials = credentials;
  }

  /**
   * True when a local Anthropic credential is configured and resolvable. Callers use
   * this to decide whether to attempt an AI call or fall back deterministically,
   * without catching the throw from {@link LocalAiCredentialsService.resolveCredential}.
   */
  isAvailable(): boolean {
    try {
      this.credentials.resolveCredential();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run a one-shot, non-streaming text completion against the user's own Anthropic
   * credential. Returns the first text block, trimmed (empty string if none).
   * Throws if no credential is configured or the API call fails — callers decide how
   * to degrade.
   */
  async complete(prompt: string, opts: LocalAiCompletionOptions = {}): Promise<string> {
    // Auto-refresh first (portable.dev#18) — never throws; a failed refresh
    // falls through to the stored token and this call's own auth error.
    await this.credentials.ensureFresh();
    const credential = this.credentials.resolveCredential();
    const isOAuth = credential.mode === 'claude-oauth';

    const client = isOAuth
      ? new Anthropic({
          authToken: credential.oauthToken,
          defaultHeaders: { 'anthropic-beta': OAUTH_BETA_HEADER },
        })
      : new Anthropic({ apiKey: credential.apiKey });

    const system = isOAuth
      ? [CLAUDE_CODE_IDENTITY, opts.system].filter(Boolean).join('\n\n')
      : opts.system;

    const response = await client.messages.create({
      model: opts.model ?? MODEL_IDS.haiku,
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    });

    const block = response.content[0];
    return block && block.type === 'text' ? block.text.trim() : '';
  }

  /**
   * Run {@link complete} and parse the first JSON object out of the response (the
   * models are prompted to emit JSON). Throws if no JSON object is found.
   */
  async completeJson<T = unknown>(prompt: string, opts: LocalAiCompletionOptions = {}): Promise<T> {
    const text = await this.complete(prompt, opts);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('[LocalAiHelper] No JSON object found in model response');
    }
    return JSON.parse(match[0]) as T;
  }
}
