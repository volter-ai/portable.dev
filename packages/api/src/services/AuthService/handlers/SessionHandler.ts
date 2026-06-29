import * as constants from '@vgit2/shared/constants';
import { Response } from 'express';

import type { OAuthRequest, HandlerDependencies } from '../types';

/**
 * SessionHandler - Manages user session lifecycle
 *
 * Responsibilities:
 * - Session logout
 * - Session cleanup
 */
export class SessionHandler {
  private dependencies: HandlerDependencies;

  constructor(dependencies: HandlerDependencies) {
    this.dependencies = dependencies;
    console.log('[SessionHandler] Initialized');
  }

  /**
   * Handle logout
   */
  handleLogout(req: OAuthRequest, res: Response): void {
    const GATEWAY_URL = constants.GATEWAY_URL || 'https://app.portable.dev';

    // If session exists and has destroy method, destroy it
    if (req.session?.destroy) {
      req.session.destroy((err) => {
        if (err) {
          res.status(500).json({
            error: 'Logout failed',
            redirectUrl: `${GATEWAY_URL}/?logout=true`,
          });
          return;
        }
        res.json({
          success: true,
          redirectUrl: `${GATEWAY_URL}/?logout=true`, // Landing page with logout param
        });
      });
    } else {
      // No session to destroy, just return success
      res.json({
        success: true,
        redirectUrl: `${GATEWAY_URL}/?logout=true`, // Landing page with logout param
      });
    }
  }
}
