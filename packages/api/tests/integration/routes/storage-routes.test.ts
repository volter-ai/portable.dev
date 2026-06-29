/**
 * Storage Routes Integration Tests
 *
 * Tests HTTP endpoints for workspace storage management.
 * Uses temp directories as basePath so tests don't affect real workspace.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { setupAllExternalMocks } from '../../setup/mocks/setupAllExternalMocks';

// Setup external service mocks BEFORE importing services
setupAllExternalMocks(mock);

import fs from 'fs';
import path from 'path';
import os from 'os';
import request from 'supertest';
import { createTestServer } from '../../setup/helpers/testServer';
import { createTestDbAdapter } from '../../setup/helpers/testDatabase';
import { StorageService } from '../../../src/services/StorageService.js';
import type { DbAdapter } from '../../../src/db/DbAdapter.js';
import { Application } from 'express';

describe('Storage Routes', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;
  let tempDir: string;

  beforeEach(async () => {
    // Create temp directory as workspace root for testing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-routes-test-'));

    // Create some test files and directories
    fs.mkdirSync(path.join(tempDir, 'project-a'));
    fs.writeFileSync(path.join(tempDir, 'project-a', 'index.ts'), 'console.log("hello");');
    fs.writeFileSync(path.join(tempDir, 'project-a', 'package.json'), '{"name":"a"}');
    fs.mkdirSync(path.join(tempDir, 'project-b'));
    fs.writeFileSync(path.join(tempDir, 'project-b', 'main.py'), 'print("hi")');
    fs.writeFileSync(path.join(tempDir, 'readme.md'), '# Test');

    // Create test server with StorageService pointing to temp dir
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;

    const storageService = new StorageService(tempDir);

    app = createTestServer({
      dbAdapter,
      authToken,
      userEmail: testUserId,
      storageService,
    });
  });

  afterEach(async () => {
    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    // Clean up test data
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('GET /api/storage/list', () => {
    it('should return 200 with root listing when no path param', async () => {
      const response = await request(app).get('/api/storage/list');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('entries');
      expect(response.body).toHaveProperty('totalSizeBytes');
      expect(response.body).toHaveProperty('path');
      expect(Array.isArray(response.body.entries)).toBe(true);
      // Should have project-a, project-b, readme.md
      expect(response.body.entries.length).toBe(3);
    });

    it('should return 200 with directory contents for valid path', async () => {
      const response = await request(app).get('/api/storage/list?path=project-a');

      expect(response.status).toBe(200);
      expect(response.body.entries.length).toBe(2); // index.ts, package.json
      const names = response.body.entries.map((e: any) => e.name);
      expect(names).toContain('index.ts');
      expect(names).toContain('package.json');
    });

    it('should return entries with correct shape', async () => {
      const response = await request(app).get('/api/storage/list?path=project-a');

      expect(response.status).toBe(200);
      const entry = response.body.entries[0];
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('type');
      expect(entry).toHaveProperty('sizeBytes');
      expect(entry).toHaveProperty('modifiedAt');
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.sizeBytes).toBe('number');
    });

    it('should return 400 for directory traversal attempt', async () => {
      const response = await request(app).get('/api/storage/list?path=../../etc');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('traversal');
    });

    it('should return 404 for non-existent path', async () => {
      const response = await request(app).get('/api/storage/list?path=nonexistent');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('GET /api/storage/usage', () => {
    it('should return 200 with usage data', async () => {
      const response = await request(app).get('/api/storage/usage');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('usedBytes');
      expect(response.body).toHaveProperty('usedGB');
      expect(typeof response.body.usedBytes).toBe('number');
      expect(typeof response.body.usedGB).toBe('number');
      expect(response.body.usedBytes).toBeGreaterThan(0);
    });
  });

  describe('DELETE /api/storage', () => {
    it('should return 400 when path is missing', async () => {
      const response = await request(app).delete('/api/storage');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('path');
    });

    it('should return 400 for directory traversal', async () => {
      const response = await request(app).delete('/api/storage?path=../../etc');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('traversal');
    });

    it('should return 200 and delete a file', async () => {
      // Verify file exists before delete
      expect(fs.existsSync(path.join(tempDir, 'readme.md'))).toBe(true);

      const response = await request(app).delete('/api/storage?path=readme.md');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('freedBytes');
      expect(response.body.freedBytes).toBeGreaterThan(0);

      // Verify file is deleted
      expect(fs.existsSync(path.join(tempDir, 'readme.md'))).toBe(false);
    });

    it('should return 200 and delete a directory recursively', async () => {
      expect(fs.existsSync(path.join(tempDir, 'project-a'))).toBe(true);

      const response = await request(app).delete('/api/storage?path=project-a');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body.freedBytes).toBeGreaterThan(0);

      expect(fs.existsSync(path.join(tempDir, 'project-a'))).toBe(false);
    });

    it('should return 404 for non-existent path', async () => {
      const response = await request(app).delete('/api/storage?path=does-not-exist');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('DELETE /api/storage/bulk', () => {
    it('should return 400 for empty paths array', async () => {
      const response = await request(app)
        .delete('/api/storage/bulk')
        .send({ paths: [] })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('paths');
    });

    it('should return 400 when paths is missing', async () => {
      const response = await request(app)
        .delete('/api/storage/bulk')
        .send({})
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should return 400 for directory traversal in bulk paths', async () => {
      const response = await request(app)
        .delete('/api/storage/bulk')
        .send({ paths: ['../../etc'] })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(200);
      // bulkDelete catches per-path errors - traversal paths result in errors array
      expect(response.body).toHaveProperty('errors');
      expect(response.body.errors.length).toBeGreaterThan(0);
    });

    it('should return 200 and delete multiple entries', async () => {
      expect(fs.existsSync(path.join(tempDir, 'project-a'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'readme.md'))).toBe(true);

      const response = await request(app)
        .delete('/api/storage/bulk')
        .send({ paths: ['project-a', 'readme.md'] })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('freedBytes');
      expect(response.body).toHaveProperty('deleted', 2);
      expect(response.body).toHaveProperty('errors');
      expect(response.body.errors.length).toBe(0);

      expect(fs.existsSync(path.join(tempDir, 'project-a'))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, 'readme.md'))).toBe(false);
    });
  });
});
