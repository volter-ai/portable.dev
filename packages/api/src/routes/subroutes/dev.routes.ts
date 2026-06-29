import fs from 'fs';
import path from 'path';

import * as Sentry from '@sentry/node';
import { NODE_ENV } from '@vgit2/shared/constants';
import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';

import type { GetConfigResponse, GetDevInfoResponse } from '@vgit2/shared/types';

/**
 * Development and debug routes
 */
export function createDevRoutes(): Router {
  const router = Router();

  // Configuration endpoint. `modalMode` is always null in the local-first runtime
  // (the remote sandbox was removed); the field is kept for client back-compat.
  router.get('/config', (req, res) => {
    const response: GetConfigResponse = {
      modalMode: null,
    };
    res.json(response);
  });

  // Dev mode info endpoint (build times, git info, diffs)
  router.get('/dev-info', (req, res) => {
    try {
      const metadataDir = path.join(process.cwd(), '../../.build-metadata');
      const frontendPath = path.join(metadataDir, 'frontend.json');
      const backendPath = path.join(metadataDir, 'backend.json');

      let frontend = null;
      let backend = null;

      // Read frontend metadata if exists
      if (fs.existsSync(frontendPath)) {
        const content = fs.readFileSync(frontendPath, 'utf-8');
        frontend = JSON.parse(content);
      }

      // Read backend metadata if exists
      if (fs.existsSync(backendPath)) {
        const content = fs.readFileSync(backendPath, 'utf-8');
        backend = JSON.parse(content);
      }

      const response: GetDevInfoResponse = {
        frontend,
        backend,
        serverUptime: process.uptime(),
        nodeVersion: process.version,
        environment: NODE_ENV,
      };
      res.json(response);
    } catch (error) {
      console.error('[API] Error reading dev-info:', error);
      res.status(500).json({ error: 'Failed to read dev info' });
    }
  });

  // Debug endpoint: Log when frontend page visibility changes (for PWA debugging)
  router.post('/debug/visibility', (req, res) => {
    const { event, data } = req.body;
    const userEmail = (req.session as any)?.passport?.user?.email || 'unknown';

    // Simplified to single line
    // console.log(`[API] [Visibility] ${event} - user: ${userEmail}, data: ${JSON.stringify(data)}`);

    res.status(200).json({ ok: true });
  });

  // Sentry test endpoint — explicitly captures a test error to verify Sentry receives events.
  router.get('/sentry-test', (req, res) => {
    const testError = new Error(
      `[Sentry Test] Backend captured error @ ${new Date().toISOString()}`
    );
    Sentry.captureException(testError);
    console.log('[Sentry] Test error sent. Check your Sentry dashboard.');
    res.json({ ok: true, message: 'Test error sent to Sentry (captureException)' });
  });

  // Sentry test endpoint — actually THROWS, exercising the global error handler path
  // (server.ts) which reports uncaught route errors to Sentry. Returns HTTP 500.
  router.get('/sentry-test/throw', () => {
    throw new Error(`[Sentry Test] Backend UNCAUGHT throw @ ${new Date().toISOString()}`);
  });

  return router;
}
