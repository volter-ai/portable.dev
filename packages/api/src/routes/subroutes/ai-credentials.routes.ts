import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';
import { ClaudeOAuthError } from '../../services/ClaudeOAuthService.js';

import type { ClaudeOAuthService } from '../../services/ClaudeOAuthService.js';
import type {
  AiCredentialsErrorResponse,
  AiCredentialsLoginCompleteResponse,
  AiCredentialsLoginStartResponse,
  AiCredentialsPasteTokenResponse,
  AiCredentialsSignOutResponse,
  AiCredentialsStatusResponse,
} from '@vgit2/shared/types';

/**
 * AI-credential management routes (portable.dev#18 — sign in with Claude from
 * the phone). Thin delegates over {@link ClaudeOAuthService}; token values
 * never leave the PC — the status payload is metadata only. Mounted under
 * `/api/ai-credentials` in the JWT-protected zone (E2E-sealed on the relay).
 */
export function createAiCredentialsRoutes(claudeOAuthService: ClaudeOAuthService): Router {
  const router = Router();

  /** Map a ClaudeOAuthError onto the typed 4xx/5xx body. */
  function sendOAuthError(res: any, error: unknown, fallback: string): void {
    if (error instanceof ClaudeOAuthError) {
      const status = error.code === 'exchange_failed' ? 502 : 400;
      const body: AiCredentialsErrorResponse = { error: error.message, code: error.code };
      res.status(status).json(body);
      return;
    }
    const body: AiCredentialsErrorResponse = {
      error: error instanceof Error ? error.message : fallback,
      code: 'invalid_request',
    };
    res.status(500).json(body);
  }

  // Current credential status (metadata only — never token values).
  router.get('/status', requireAuth, (_req, res) => {
    const response: AiCredentialsStatusResponse = claudeOAuthService.status();
    res.json(response);
  });

  // Start the phone-driven PKCE login → the authorize URL the phone browser opens.
  router.post('/login/start', requireAuth, (_req, res) => {
    const response: AiCredentialsLoginStartResponse = claudeOAuthService.startLogin();
    res.json(response);
  });

  // Complete the login with the user-pasted `CODE#STATE`.
  router.post('/login/complete', requireAuth, async (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    if (!code.trim()) {
      const body: AiCredentialsErrorResponse = {
        error: 'Body must include the pasted code',
        code: 'invalid_code',
      };
      return res.status(400).json(body);
    }
    try {
      const { email } = await claudeOAuthService.completeLogin(code);
      const response: AiCredentialsLoginCompleteResponse = {
        ok: true,
        ...(email ? { email } : {}),
      };
      res.json(response);
    } catch (error) {
      console.error('[API] /api/ai-credentials/login/complete error:', error);
      sendOAuthError(res, error, 'Failed to complete the Claude login');
    }
  });

  // Paste fallback: an sk-ant-oat… token or an sk-ant-api… key.
  router.post('/token', requireAuth, (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    try {
      const { mode } = claudeOAuthService.pasteToken(token);
      const response: AiCredentialsPasteTokenResponse = { ok: true, mode };
      res.json(response);
    } catch (error) {
      console.error('[API] /api/ai-credentials/token error:', error);
      sendOAuthError(res, error, 'Failed to store the pasted credential');
    }
  });

  // Sign out — clear every stored credential (an env ANTHROPIC_API_KEY remains).
  router.delete('/', requireAuth, (_req, res) => {
    const cleared = claudeOAuthService.signOut();
    const response: AiCredentialsSignOutResponse = { ok: true, cleared };
    res.json(response);
  });

  return router;
}
