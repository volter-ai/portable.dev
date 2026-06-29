/**
 * StorageService Security Tests - Path Traversal Prevention
 *
 * Dedicated security tests to ensure path traversal attacks are blocked
 * at every layer (service and HTTP route level).
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { setupAllExternalMocks } from '../../setup/mocks/setupAllExternalMocks';

// Setup external service mocks BEFORE importing services
setupAllExternalMocks(mock);

import fs from 'fs';
import path from 'path';
import os from 'os';
import request from 'supertest';
import { StorageService } from '../../../src/services/StorageService.js';
import { createTestServer } from '../../setup/helpers/testServer';
import { createTestDbAdapter } from '../../setup/helpers/testDatabase';
import type { DbAdapter } from '../../../src/db/DbAdapter.js';
import { Application } from 'express';

describe('StorageService Security - Path Traversal Prevention', () => {
  let service: StorageService;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-security-'));
    // Create a valid subdirectory for testing
    fs.mkdirSync(path.join(tempDir, 'safe-folder'));
    fs.writeFileSync(path.join(tempDir, 'safe-folder', 'data.txt'), 'safe content');
    fs.writeFileSync(path.join(tempDir, 'root-file.txt'), 'root content');
    service = new StorageService(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Service-level path traversal variants', () => {
    const traversalPaths = [
      '../',
      '../../',
      '../../../etc/passwd',
      '..\\..\\',
      'foo/../../../etc',
      'safe-folder/../../etc/passwd',
      '..',
      'safe-folder/../..',
    ];

    for (const maliciousPath of traversalPaths) {
      it(`listDirectory rejects: "${maliciousPath}"`, async () => {
        try {
          await service.listDirectory(maliciousPath);
          expect(true).toBe(false); // Should not reach here
        } catch (e: any) {
          expect(e.statusCode).toBe(400);
          expect(e.message).toContain('traversal');
        }
      });

      it(`deleteEntry rejects: "${maliciousPath}"`, async () => {
        try {
          await service.deleteEntry(maliciousPath);
          expect(true).toBe(false); // Should not reach here
        } catch (e: any) {
          // Either 400 (traversal) or 400 (workspace root for '..')
          expect(e.statusCode).toBe(400);
        }
      });
    }

    it('bulkDelete reports traversal errors for all malicious paths', async () => {
      const result = await service.bulkDelete(['../etc/passwd', '../../root', '../../../tmp']);
      expect(result.success).toBe(false);
      expect(result.deleted).toBe(0);
      expect(result.errors).toHaveLength(3);
      for (const error of result.errors) {
        expect(error).toContain('traversal');
      }
    });
  });

  describe('Absolute path injection', () => {
    it('listDirectory rejects /etc/passwd', async () => {
      try {
        await service.listDirectory('/etc/passwd');
        expect(true).toBe(false);
      } catch (e: any) {
        // path.resolve('/base', '/etc/passwd') = '/etc/passwd', which doesn't start with base
        expect(e.statusCode).toBe(400);
      }
    });

    it('deleteEntry rejects /root/.ssh', async () => {
      try {
        await service.deleteEntry('/root/.ssh');
        expect(true).toBe(false);
      } catch (e: any) {
        expect(e.statusCode).toBe(400);
      }
    });

    it('bulkDelete rejects absolute paths', async () => {
      const result = await service.bulkDelete(['/etc/passwd', '/root/.ssh']);
      expect(result.success).toBe(false);
      expect(result.deleted).toBe(0);
      expect(result.errors).toHaveLength(2);
    });
  });

  describe('Symlink traversal', () => {
    it('listDirectory does not include symlinks in entries', async () => {
      // Create a symlink inside base dir pointing outside
      const symlinkPath = path.join(tempDir, 'escape-link');
      try {
        fs.symlinkSync('/tmp', symlinkPath);
      } catch {
        // If symlink creation fails (permissions), skip test
        return;
      }

      const result = await service.listDirectory('');
      const names = result.entries.map((e) => e.name);
      // Symlinks should be skipped in listings
      expect(names).not.toContain('escape-link');
      // But real entries should still be present
      expect(names).toContain('safe-folder');
      expect(names).toContain('root-file.txt');
    });
  });

  describe('Empty and whitespace paths', () => {
    it('listDirectory with empty string returns root listing', async () => {
      const result = await service.listDirectory('');
      expect(result.path).toBe('/');
      expect(result.entries.length).toBeGreaterThan(0);
    });

    it('listDirectory with spaces returns root listing', async () => {
      const result = await service.listDirectory('   ');
      expect(result.path).toBe('/');
      expect(result.entries.length).toBeGreaterThan(0);
    });

    it('deleteEntry with empty string rejects as workspace root', async () => {
      try {
        await service.deleteEntry('');
        expect(true).toBe(false);
      } catch (e: any) {
        expect(e.statusCode).toBe(400);
        expect(e.message).toContain('workspace root');
      }
    });

    it('deleteEntry with whitespace-only rejects as workspace root', async () => {
      try {
        await service.deleteEntry('   ');
        expect(true).toBe(false);
      } catch (e: any) {
        expect(e.statusCode).toBe(400);
        expect(e.message).toContain('workspace root');
      }
    });
  });

  describe('Paths with special characters', () => {
    it('.hidden-folder is accessible (valid hidden directory)', async () => {
      fs.mkdirSync(path.join(tempDir, '.hidden-folder'));
      fs.writeFileSync(path.join(tempDir, '.hidden-folder', 'secret.txt'), 'hidden');

      const result = await service.listDirectory('.hidden-folder');
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('secret.txt');
    });

    it('folder names with spaces work correctly', async () => {
      fs.mkdirSync(path.join(tempDir, 'my folder'));
      fs.writeFileSync(path.join(tempDir, 'my folder', 'file.txt'), 'content');

      const result = await service.listDirectory('my folder');
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('file.txt');
    });

    it('folder names with dots (not traversal) work correctly', async () => {
      fs.mkdirSync(path.join(tempDir, 'v1.0.0'));
      fs.writeFileSync(path.join(tempDir, 'v1.0.0', 'release.txt'), 'notes');

      const result = await service.listDirectory('v1.0.0');
      expect(result.entries).toHaveLength(1);
    });
  });

  describe('HTTP-level path traversal (route tests)', () => {
    let app: Application;
    let dbAdapter: DbAdapter;
    let testUserId: string;
    let authToken: string;
    let httpTempDir: string;

    beforeEach(async () => {
      httpTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-security-http-'));
      fs.mkdirSync(path.join(httpTempDir, 'project'));
      fs.writeFileSync(path.join(httpTempDir, 'project', 'file.txt'), 'test');

      const storageService = new StorageService(httpTempDir);
      const { adapter, userId, authToken: token } = await createTestDbAdapter();
      dbAdapter = adapter;
      testUserId = userId;
      authToken = token;
      app = createTestServer({ dbAdapter, authToken, userEmail: testUserId, storageService });
    });

    afterEach(() => {
      fs.rmSync(httpTempDir, { recursive: true, force: true });
    });

    it('GET /api/storage/list rejects URL-encoded traversal (%2e%2e%2f)', async () => {
      // %2e%2e%2f = ../
      const res = await request(app).get('/api/storage/list?path=%2e%2e%2fetc');
      expect(res.status).toBe(400);
    });

    it('GET /api/storage/list rejects backslash traversal', async () => {
      const res = await request(app).get('/api/storage/list?path=..\\..\\etc');
      expect(res.status).toBe(400);
    });

    it('DELETE /api/storage rejects traversal path', async () => {
      const res = await request(app).delete('/api/storage?path=../../etc/passwd');
      expect(res.status).toBe(400);
    });

    it('DELETE /api/storage/bulk rejects traversal in paths array', async () => {
      const res = await request(app)
        .delete('/api/storage/bulk')
        .send({ paths: ['../etc/passwd', 'project'] });

      expect(res.status).toBe(200);
      // Partial success: traversal path fails, valid path succeeds
      expect(res.body.errors.length).toBeGreaterThan(0);
      expect(res.body.errors[0]).toContain('traversal');
    });
  });
});
