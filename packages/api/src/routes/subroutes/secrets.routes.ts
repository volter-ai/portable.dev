import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';
import { getAuthToken } from '../utils/route-helpers.js';

import type { ConnectionsService } from '../../services/ConnectionsService.js';
import type { GitLocalService } from '../../services/GitLocalService.js';
import type { SecretsService } from '../../services/SecretsService.js';
import type {
  GetUserSecretsResponse,
  CreateUserSecretResponse,
  CreateSecretFromEnvResponse,
  UpdateUserSecretResponse,
  DeleteUserSecretResponse,
  GetSavedSecretsResponse,
  GetSavedSecretResponse,
  SaveSecretResponse,
  DeleteSavedSecretResponse,
  SearchVaultResponse,
  InjectSecretsResponse,
} from '@vgit2/shared/types';

/**
 * User secrets and vault management routes
 */
export function createSecretsRoutes(
  userSecretsService: SecretsService,
  connectionsService: ConnectionsService,
  gitLocalService: GitLocalService
): Router {
  const router = Router();

  // ============================================================================
  // USER SECRETS ENDPOINTS
  // ============================================================================

  // User secrets endpoints
  router.get('/user/secrets', requireAuth, async (req, res) => {
    try {
      const authToken = getAuthToken(req);

      // Fetch vault secrets (manual, env_editor) from database
      const vaultSecrets = await userSecretsService.getSavedSecrets(
        req.session.userEmail!,
        authToken
      );

      // Fetch connection secrets
      const connectionSecrets = await connectionsService.getConnectionSecrets(
        req.session.userEmail!,
        authToken
      );

      // Format vault secrets (from database) to match Secret interface
      const vaultSecretsFormatted = vaultSecrets.map((vs) => ({
        key: vs.key,
        value: '••••••••', // Values are encrypted in vault, always masked in list
        source: 'manual' as const,
        description: 'Saved in vault',
        createdAt:
          vs.createdAt instanceof Date ? vs.createdAt.getTime() : new Date(vs.createdAt).getTime(),
        updatedAt:
          vs.updatedAt instanceof Date ? vs.updatedAt.getTime() : new Date(vs.updatedAt).getTime(),
      }));

      // Convert connection secrets to Secret format
      const connectionSecretsFormatted = connectionSecrets.map((cs) => ({
        key: cs.key,
        value: '••••••••', // Connection credentials are never exposed, always masked
        source: cs.source,
        sourceConnectionId: cs.sourceConnectionId,
        displayName: cs.displayName,
        description: `From ${cs.displayName} (${cs.service})`,
        createdAt: Date.now(), // Connection secrets don't have timestamps
        updatedAt: Date.now(),
      }));

      // Merge vault secrets and connection secrets
      const allSecrets = [...vaultSecretsFormatted, ...connectionSecretsFormatted];

      const response: GetUserSecretsResponse = { secrets: allSecrets };
      res.json(response);
    } catch (error: any) {
      console.error('[API] /api/user/secrets error:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch secrets' });
    }
  });

  router.post('/user/secrets', requireAuth, async (req, res) => {
    const { key, value, description, source, sourceConnectionId } = req.body;

    if (!key || !value) {
      return res.status(400).json({ error: 'Key and value are required' });
    }

    try {
      // Use vault-based storage with source tracking
      await userSecretsService.saveSecretToVault(
        req.session.userEmail!,
        key,
        value,
        source || 'manual',
        sourceConnectionId,
        req.session.authToken
      );

      // Get the saved secret to return
      const savedSecrets = await userSecretsService.getSavedSecrets(
        req.session.userEmail!,
        req.session.authToken
      );
      const secret = savedSecrets.find((s) => s.key === key);

      const response: CreateUserSecretResponse = { success: true, secret: secret as any };
      res.json(response);
    } catch (error: any) {
      console.error('[API] /api/user/secrets POST error:', error);
      res.status(400).json({ success: false, error: error.message || 'Failed to create secret' });
    }
  });

  // Convenience endpoint for saving secrets from env editor
  router.post('/user/secrets/from-env', requireAuth, async (req, res) => {
    const { key, value, description } = req.body;

    if (!key || !value) {
      return res.status(400).json({ error: 'Key and value are required' });
    }

    try {
      await userSecretsService.saveSecretToVault(
        req.session.userEmail!,
        key,
        value,
        'env_editor',
        undefined,
        req.session.authToken
      );

      // Get the saved secret to return
      const savedSecrets = await userSecretsService.getSavedSecrets(
        req.session.userEmail!,
        req.session.authToken
      );
      const secret = savedSecrets.find((s) => s.key === key);

      const response: CreateSecretFromEnvResponse = { success: true, secret: secret as any };
      res.json(response);
    } catch (error: any) {
      console.error('[API] /api/user/secrets/from-env POST error:', error);
      res
        .status(400)
        .json({ success: false, error: error.message || 'Failed to save secret from env editor' });
    }
  });

  router.patch('/user/secrets/:key', requireAuth, async (req, res) => {
    const { key } = req.params;
    const { value, description } = req.body;

    if (!value && description === undefined) {
      return res
        .status(400)
        .json({ error: 'At least one of value or description must be provided' });
    }

    try {
      // Check if secret exists in vault
      const exists = await userSecretsService.secretExistsInVault(
        req.session.userEmail!,
        key as string,
        req.session.authToken
      );

      if (!exists) {
        return res.status(404).json({ success: false, error: 'Secret not found' });
      }

      // Update secret in vault (upsert)
      await userSecretsService.saveSecretToVault(
        req.session.userEmail!,
        key as string,
        value,
        'manual',
        undefined,
        req.session.authToken
      );

      // Get the updated secret to return
      const savedSecrets = await userSecretsService.getSavedSecrets(
        req.session.userEmail!,
        req.session.authToken
      );
      const secret = savedSecrets.find((s) => s.key === key);

      const response: UpdateUserSecretResponse = { success: true, secret: secret as any };
      res.json(response);
    } catch (error: any) {
      console.error('[API] /api/user/secrets/:key PATCH error:', error);
      res.status(400).json({ success: false, error: error.message || 'Failed to update secret' });
    }
  });

  router.delete('/user/secrets/:key', requireAuth, async (req, res) => {
    const { key } = req.params;

    try {
      // Check if secret exists in vault
      const exists = await userSecretsService.secretExistsInVault(
        req.session.userEmail!,
        key as string,
        req.session.authToken
      );

      if (!exists) {
        return res.status(404).json({ success: false, error: 'Secret not found' });
      }

      // Delete from vault
      await userSecretsService.deleteSecretFromVault(
        req.session.userEmail!,
        key as string,
        req.session.authToken
      );

      const response: DeleteUserSecretResponse = { success: true };
      res.json(response);
    } catch (error: any) {
      console.error('[API] /api/user/secrets/:key DELETE error:', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to delete secret' });
    }
  });

  // ============================================================================
  // SECRETS VAULT ROUTES - Password-manager style saved secrets
  // ============================================================================

  // Get all saved secrets from vault (keys and metadata only, no values)
  router.get('/secrets/vault', requireAuth, async (req, res) => {
    try {
      const savedSecrets = await userSecretsService.getSavedSecrets(
        req.session.userEmail!,
        req.session.authToken
      );
      const response: GetSavedSecretsResponse = { savedSecrets: savedSecrets as any };
      res.json(response);
    } catch (error: any) {
      console.error('[API] /api/secrets/vault GET error:', error);
      if (error.message === 'Secrets vault is not configured') {
        res.status(503).json({ error: 'Secrets vault is not available' });
      } else {
        res.status(500).json({ error: error.message || 'Failed to fetch saved secrets' });
      }
    }
  });

  // Get a specific saved secret value from vault (decrypted)
  router.get('/secrets/vault/:key', requireAuth, async (req, res) => {
    const { key } = req.params;

    try {
      const value = await userSecretsService.getSavedSecretValue(
        req.session.userEmail!,
        key as string,
        req.session.authToken
      );

      if (value === null) {
        return res.status(404).json({ error: 'Secret not found' });
      }

      const response: GetSavedSecretResponse = { key: key as string, value };
      res.json(response);
    } catch (error: any) {
      console.error('[API] /api/secrets/vault/:key GET error:', error);
      if (error.message === 'Secrets vault is not configured') {
        res.status(503).json({ error: 'Secrets vault is not available' });
      } else {
        res.status(500).json({ error: error.message || 'Failed to fetch secret' });
      }
    }
  });

  // Save a secret to vault (create or update)
  router.post('/secrets/vault', requireAuth, async (req, res) => {
    const { key, value } = req.body;

    if (!key || !value) {
      return res.status(400).json({ error: 'Key and value are required' });
    }

    try {
      await userSecretsService.saveSecretToVault(
        req.session.userEmail!,
        key,
        value,
        'manual',
        undefined,
        req.session.authToken
      );
      const response: SaveSecretResponse = { success: true, message: 'Secret saved to vault' };
      res.json(response);
    } catch (error: any) {
      console.error('[API] /api/secrets/vault POST error:', error);
      if (error.message === 'Secrets vault is not configured') {
        res.status(503).json({ error: 'Secrets vault is not available' });
      } else {
        res.status(400).json({ error: error.message || 'Failed to save secret' });
      }
    }
  });

  // Delete a secret from vault
  router.delete('/secrets/vault/:key', requireAuth, async (req, res) => {
    const key = req.params.key as string;

    try {
      await userSecretsService.deleteSecretFromVault(
        req.session.userEmail!,
        key,
        req.session.authToken
      );
      const response: DeleteSavedSecretResponse = {
        success: true,
        message: 'Secret deleted from vault',
      };
      res.json(response);
    } catch (error: any) {
      console.error('[API] /api/secrets/vault/:key DELETE error:', error);
      if (error.message === 'Secrets vault is not configured') {
        res.status(503).json({ error: 'Secrets vault is not available' });
      } else {
        res.status(500).json({ error: error.message || 'Failed to delete secret' });
      }
    }
  });

  // Search vault for secrets (for autocomplete/suggestions)
  router.get('/secrets/vault/search', requireAuth, async (req, res) => {
    const query = req.query.q as string;

    if (!query) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    try {
      const results = await userSecretsService.searchVault(
        req.session.userEmail!,
        query,
        req.session.authToken
      );
      const response: SearchVaultResponse = { results: results as any };
      res.json(response);
    } catch (error: any) {
      console.error('[API] /api/secrets/vault/search GET error:', error);
      if (error.message === 'Secrets vault is not configured') {
        res.status(503).json({ error: 'Secrets vault is not available' });
      } else {
        res.status(500).json({ error: error.message || 'Failed to search vault' });
      }
    }
  });

  // Inject user secrets into a repository
  router.post('/repos/:owner/:repo/inject-secrets', requireAuth, async (req, res) => {
    const { owner, repo } = req.params;
    const { envFileName } = req.body; // Optional: default is .env

    try {
      // Get user secrets
      const userSecrets = await userSecretsService.getSecretsAsEnvVars(req.session.userEmail!);

      if (Object.keys(userSecrets).length === 0) {
        const response: InjectSecretsResponse = {
          success: true,
          added: 0,
          skipped: 0,
          total: 0,
          message: 'No user secrets to inject',
        };
        return res.json(response);
      }

      // Inject secrets into the repository
      const result = await gitLocalService.injectUserSecrets(
        owner as string,
        repo as string,
        req.session.userEmail!,
        userSecrets,
        envFileName || '.env'
      );

      const response: InjectSecretsResponse = {
        success: true,
        added: result.added,
        skipped: result.skipped,
        total: result.total,
        message: `Injected ${result.added} user secrets into ${envFileName || '.env'}`,
      };
      res.json(response);
    } catch (error: any) {
      console.error('[API] /api/repos/:owner/:repo/inject-secrets error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to inject user secrets',
      });
    }
  });

  return router;
}
