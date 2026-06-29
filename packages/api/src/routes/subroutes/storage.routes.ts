import { Router } from 'express';

import type { StorageService } from '../../services/StorageService.js';
import type {
  StorageListResponse,
  StorageUsageResponse,
  StorageDeleteResponse,
  StorageBulkDeleteResponse,
} from '@vgit2/shared/types';

/**
 * Storage management routes for workspace file browsing and cleanup
 */
export function createStorageRoutes(storageService: StorageService): Router {
  const router = Router();

  // List directory contents
  router.get('/list', async (req, res) => {
    try {
      const relativePath = (req.query.path as string) || '';
      const result: StorageListResponse = await storageService.listDirectory(relativePath);
      res.status(200).json(result);
    } catch (error: any) {
      const statusCode = error.statusCode || 500;
      res.status(statusCode).json({ error: error.message });
    }
  });

  // Get workspace usage
  router.get('/usage', async (_req, res) => {
    try {
      const result: StorageUsageResponse = await storageService.getUsage();
      res.status(200).json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Delete a single entry
  router.delete('/', async (req, res) => {
    try {
      const relativePath = req.query.path as string;
      if (!relativePath) {
        return res.status(400).json({ error: 'path query parameter is required' });
      }
      const result: StorageDeleteResponse = await storageService.deleteEntry(relativePath);
      res.status(200).json(result);
    } catch (error: any) {
      const statusCode = error.statusCode || 500;
      res.status(statusCode).json({ error: error.message });
    }
  });

  // Bulk delete multiple entries
  router.delete('/bulk', async (req, res) => {
    try {
      const { paths } = req.body as { paths: string[] };
      if (!paths || !Array.isArray(paths) || paths.length === 0) {
        return res.status(400).json({ error: 'paths array is required and must not be empty' });
      }
      const result: StorageBulkDeleteResponse = await storageService.bulkDelete(paths);
      res.status(200).json(result);
    } catch (error: any) {
      const statusCode = error.statusCode || 500;
      res.status(statusCode).json({ error: error.message });
    }
  });

  return router;
}
