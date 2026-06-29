import { shouldLog } from '@vgit2/shared/constants';
import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';
import { getAuthToken } from '../utils/route-helpers.js';

import type { AuthService } from '../../services/AuthService.js';
import type { ChatService } from '../../services/ChatService.js';
import type { PushNotificationService } from '../../services/PushNotificationService.js';
import type { ThemeService } from '../../services/ThemeService.js';
import type { UserSettings, GetAgentSetupsResponse } from '@vgit2/shared/types';

/**
 * Miscellaneous routes: user settings, MCP, agent setup, push notifications
 */
export function createMiscRoutes(
  themeService: ThemeService,
  chatService: ChatService,
  _authService: AuthService,
  pushNotificationService?: PushNotificationService
): Router {
  const router = Router();

  // Note: These endpoints use the existing user_themes table's theme_config JSONB column
  // to store both theme settings and onboarding settings. This allows for flexible
  // extensibility without database schema changes.

  /**
   * GET /api/user-settings
   * Fetch user settings (onboarding status and preferences)
   * Returns null if user has never completed onboarding
   */
  router.get('/user-settings', requireAuth, async (req, res) => {
    try {
      // Get user email from session (populated by JWT middleware)
      const userEmail = req.session?.userEmail;
      const authToken = getAuthToken(req);

      if (!userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      // Get theme_config which contains all user settings
      const themeConfig = await themeService.getTheme(userEmail, authToken);

      // Extract user settings from theme_config (if exists)
      const settings: UserSettings | null = themeConfig?.userSettings || null;

      res.json({
        success: true,
        settings,
        hasCompletedOnboarding: settings?.onboardingCompleted || false,
      });
    } catch (error: any) {
      console.error('[API] /api/user-settings GET error:', error);
      res.status(500).json({
        error: 'Failed to fetch user settings',
        details: error.message,
      });
    }
  });

  /**
   * POST /api/user-settings
   * Save user settings (onboarding completion and preferences)
   * Body: { settings: UserSettings }
   * Merges with existing theme_config to preserve theme settings
   */
  router.post('/user-settings', requireAuth, async (req, res) => {
    try {
      // Get user email from session (populated by JWT middleware)
      const userEmail = req.session?.userEmail;
      const authToken = getAuthToken(req);

      if (!userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { settings } = req.body;

      if (!settings) {
        return res.status(400).json({ error: 'settings is required in request body' });
      }

      // Get existing theme_config to preserve theme settings
      const existingConfig = (await themeService.getTheme(userEmail, authToken)) || {};

      // Merge user settings into theme_config
      const updatedConfig = {
        ...existingConfig,
        userSettings: settings,
      };

      await themeService.saveTheme(userEmail, updatedConfig, authToken);

      res.json({
        success: true,
        settings,
      });
    } catch (error: any) {
      console.error('[API] /api/user-settings POST error:', error);
      res.status(500).json({
        error: 'Failed to save user settings',
        details: error.message,
      });
    }
  });

  /**
   * POST /api/user-settings/complete-onboarding
   * Mark onboarding as completed for the current user
   * Convenience endpoint for onboarding flow
   */
  router.post('/user-settings/complete-onboarding', async (req, res) => {
    try {
      // Get user email from session (populated by JWT middleware)
      const userEmail = req.session?.userEmail;
      const authToken = getAuthToken(req);

      if (!userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      // Get existing settings
      const existingConfig = (await themeService.getTheme(userEmail, authToken)) || {};
      const existingSettings: UserSettings = existingConfig.userSettings || {};

      // Update onboarding completion
      const updatedSettings: UserSettings = {
        ...existingSettings,
        onboardingCompleted: true,
        onboardingCompletedAt: new Date().toISOString(),
      };

      // Merge back into theme_config
      const updatedConfig = {
        ...existingConfig,
        userSettings: updatedSettings,
      };

      await themeService.saveTheme(userEmail, updatedConfig, authToken);

      res.json({
        success: true,
        settings: updatedSettings,
      });
    } catch (error: any) {
      console.error('[API] /api/user-settings/complete-onboarding POST error:', error);
      res.status(500).json({
        error: 'Failed to mark onboarding as completed',
        details: error.message,
      });
    }
  });

  // ============================================================================
  // MCP (Model Context Protocol) ENDPOINTS
  // ============================================================================

  /**
   * GET /api/mcps/available
   * Get all available MCP servers with their status and configuration
   * Returns metadata from MCP_REGISTRY with availability based on local env
   * (Chromium). No MCP is token-gated.
   */
  router.get('/mcps/available', requireAuth, async (req, res) => {
    try {
      // Import from backend config (not shared)
      const { getAllMcps, checkMcpRequirements } = await import('../../config/McpRegistry.js');

      const allMcps = getAllMcps();

      // Compact log at INFO level
      console.log(`[API] /api/mcps/available → ${allMcps.length} MCPs`);

      // Verbose details at DEBUG level
      if (shouldLog('debug')) {
        console.log(
          '[API] MCPs:',
          allMcps.map((m) => m.id)
        );
      }

      // Check availability for each MCP (local env only — no MCP is token-gated)
      const mcpStatuses = allMcps.map((mcp) => {
        const { available, missingEnv } = checkMcpRequirements(mcp.id);

        // Determine status
        let status: 'available' | 'missing_token' | 'disabled';
        if (available) {
          status = 'available';
        } else if (missingEnv.length > 0) {
          status = 'missing_token';
        } else {
          status = 'disabled';
        }

        // Combine requirements
        const requirements = [...missingEnv];

        return {
          id: mcp.id,
          name: mcp.name,
          description: mcp.description,
          type: mcp.type,
          enabled: available,
          toolCount: mcp.toolCount,
          websiteUrl: mcp.websiteUrl,
          icon: mcp.icon,
          requirements,
          status,
          colorTheme: mcp.colorTheme,
          category: mcp.category,
        };
      });

      const response: { mcps: any[] } = { mcps: mcpStatuses };
      res.json(response);
    } catch (error: any) {
      console.error('[API] /api/mcps/available error:', error);
      res.status(500).json({
        error: 'Failed to fetch MCP status',
        details: error.message,
      });
    }
  });

  // ============================================================================
  // AGENT SETUP ENDPOINTS
  // ============================================================================

  /**
   * GET /api/agent-setups
   * Get all available agent setups
   * Returns agent setup configurations from registry
   */
  router.get('/agent-setups', requireAuth, async (req, res) => {
    try {
      // Import from backend config (not shared)
      const { getAvailableAgentSetups } = await import('../../config/agentRegistry.js');

      const agentSetups = getAvailableAgentSetups();

      // Explicitly typed response to prevent field name mismatches
      const response: GetAgentSetupsResponse = {
        agentSetups,
      };

      res.json(response);
    } catch (error: any) {
      console.error('[API] /api/agent-setups error:', error);
      res.status(500).json({
        error: 'Failed to fetch agent setups',
        details: error.message,
      });
    }
  });

  // ============================================================================
  // PUSH NOTIFICATION ROUTES
  // ============================================================================

  /**
   * GET /api/push/vapid-public-key
   * Get the VAPID public key needed for push subscriptions
   */
  router.get('/push/vapid-public-key', (req, res) => {
    if (!pushNotificationService || !pushNotificationService.isConfigured()) {
      return res.status(503).json({
        error: 'Push notifications not configured',
        details: 'VAPID keys are missing in server configuration',
      });
    }

    const publicKey = pushNotificationService.getVapidPublicKey();
    res.json({ publicKey });
  });

  /**
   * POST /api/push/subscribe
   * Subscribe to push notifications
   */
  router.post('/push/subscribe', requireAuth, async (req, res) => {
    try {
      const userId = req.session?.userEmail || req.session?.githubUser?.id?.toString();
      const authToken = getAuthToken(req);

      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      // Support both formats: nested subscription object or flat
      const subscriptionData = req.body.subscription || req.body;
      const { endpoint, keys, platform, fcmToken } = subscriptionData;
      const { deviceInfo } = req.body;

      // Native subscriptions (ios/android) don't need VAPID keys, only fcmToken
      const isNative = platform === 'ios' || platform === 'android';
      if (!endpoint) {
        return res.status(400).json({ error: 'endpoint is required' });
      }
      if (!isNative && (!keys || !keys.p256dh || !keys.auth)) {
        return res
          .status(400)
          .json({ error: 'Invalid subscription data: keys required for web push' });
      }

      if (!pushNotificationService) {
        return res.status(503).json({ error: 'Push notification service not available' });
      }

      const success = await pushNotificationService.saveSubscription(
        userId,
        { endpoint, keys, deviceInfo, platform, fcmToken },
        authToken
      );

      if (success) {
        res.json({ success: true });
      } else {
        res.status(500).json({ error: 'Failed to save push subscription' });
      }
    } catch (error: any) {
      console.error('[API] /api/push/subscribe POST error:', error);
      res.status(500).json({
        error: 'Failed to subscribe to push notifications',
        details: error.message,
      });
    }
  });

  /**
   * POST /api/push/unsubscribe
   * Unsubscribe from push notifications
   */
  router.post('/push/unsubscribe', requireAuth, async (req, res) => {
    try {
      const userId = req.session?.userEmail || req.session?.githubUser?.id?.toString();
      const authToken = getAuthToken(req);

      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { endpoint } = req.body;

      if (!endpoint) {
        return res.status(400).json({ error: 'Endpoint is required' });
      }

      if (!pushNotificationService) {
        return res.status(503).json({ error: 'Push notification service not available' });
      }

      const success = await pushNotificationService.removeSubscription(userId, endpoint, authToken);

      if (success) {
        res.json({ success: true });
      } else {
        res.status(500).json({ error: 'Failed to remove push subscription' });
      }
    } catch (error: any) {
      console.error('[API] /api/push/unsubscribe POST error:', error);
      res.status(500).json({
        error: 'Failed to unsubscribe from push notifications',
        details: error.message,
      });
    }
  });

  /**
   * GET /api/push/settings
   * Get notification settings for the authenticated user
   */
  router.get('/push/settings', requireAuth, async (req, res) => {
    try {
      if (!pushNotificationService) {
        return res.status(503).json({ error: 'Push notifications not configured' });
      }

      const userId = req.session?.userEmail || req.session?.githubUser?.id?.toString();
      const authToken = getAuthToken(req);

      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const settings = await pushNotificationService.getNotificationSettings(userId, authToken);
      res.json(settings);
    } catch (error: any) {
      console.error('[API] /api/push/settings GET error:', error);
      res.status(500).json({ error: 'Failed to get notification settings' });
    }
  });

  /**
   * PUT /api/push/settings
   * Update notification settings for the authenticated user
   */
  router.put('/push/settings', requireAuth, async (req, res) => {
    try {
      if (!pushNotificationService) {
        return res.status(503).json({ error: 'Push notifications not configured' });
      }

      const userId = req.session?.userEmail || req.session?.githubUser?.id?.toString();
      const authToken = getAuthToken(req);

      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { notifyWhen } = req.body;

      // Validate notifyWhen value
      if (notifyWhen && notifyWhen !== 'always' && notifyWhen !== 'offline') {
        return res.status(400).json({ error: 'notifyWhen must be "always" or "offline"' });
      }

      const success = await pushNotificationService.updateNotificationSettings(
        userId,
        req.body,
        authToken
      );
      if (!success) {
        return res.status(404).json({ error: 'No subscriptions found to update' });
      }

      const updated = await pushNotificationService.getNotificationSettings(userId, authToken);
      res.json({ success: true, settings: updated });
    } catch (error: any) {
      console.error('[API] /api/push/settings PUT error:', error);
      res.status(500).json({ error: 'Failed to update notification settings' });
    }
  });

  return router;
}
