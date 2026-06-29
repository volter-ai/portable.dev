/**
 * StorageService Lifecycle Tests
 *
 * Tests complete user flows through the StorageService directly (not HTTP).
 * Uses temp directories as basePath for deterministic, isolated assertions.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { setupAllExternalMocks } from '../../setup/mocks/setupAllExternalMocks';

// Setup external service mocks BEFORE importing services
setupAllExternalMocks(mock);

import fs from 'fs';
import path from 'path';
import os from 'os';
import { StorageService } from '../../../src/services/StorageService.js';

describe('StorageService Lifecycle', () => {
  let service: StorageService;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-lifecycle-'));
    service = new StorageService(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('User lists workspace root, navigates into a folder, lists contents', () => {
    it('should list root entries and then navigate into a subfolder', async () => {
      // Setup: create nested directory structure
      fs.mkdirSync(path.join(tempDir, 'my-project'));
      fs.writeFileSync(path.join(tempDir, 'my-project', 'index.ts'), 'export default 42;');
      fs.writeFileSync(path.join(tempDir, 'my-project', 'readme.md'), '# Hello');
      fs.mkdirSync(path.join(tempDir, 'other-project'));
      fs.writeFileSync(path.join(tempDir, 'other-project', 'main.py'), 'print("hi")');

      // Step 1: List root
      const root = await service.listDirectory('');
      expect(root.path).toBe('/');
      expect(root.entries).toHaveLength(2);
      expect(root.entries.map((e) => e.name).sort()).toEqual(['my-project', 'other-project']);
      expect(root.entries.every((e) => e.type === 'directory')).toBe(true);
      expect(root.totalSizeBytes).toBeGreaterThan(0);

      // Step 2: Navigate into my-project
      const subDir = await service.listDirectory('my-project');
      expect(subDir.path).toBe('my-project');
      expect(subDir.entries).toHaveLength(2);
      const names = subDir.entries.map((e) => e.name).sort();
      expect(names).toEqual(['index.ts', 'readme.md']);
      expect(subDir.entries.every((e) => e.type === 'file')).toBe(true);

      // Verify sizes match actual file sizes
      const indexEntry = subDir.entries.find((e) => e.name === 'index.ts')!;
      expect(indexEntry.sizeBytes).toBe(Buffer.from('export default 42;').length);

      // Verify modifiedAt is valid ISO date
      expect(new Date(indexEntry.modifiedAt).getTime()).not.toBeNaN();
    });
  });

  describe('User deletes a folder and sees freed space', () => {
    it('should delete a folder and return correct freedBytes', async () => {
      // Setup: create a directory with known content
      const content = 'A'.repeat(1024); // 1KB file
      fs.mkdirSync(path.join(tempDir, 'to-delete'));
      fs.writeFileSync(path.join(tempDir, 'to-delete', 'file1.txt'), content);
      fs.writeFileSync(path.join(tempDir, 'to-delete', 'file2.txt'), content);
      fs.mkdirSync(path.join(tempDir, 'to-delete', 'sub'));
      fs.writeFileSync(path.join(tempDir, 'to-delete', 'sub', 'file3.txt'), content);

      const expectedSize = content.length * 3; // 3 files of 1024 bytes each

      // Delete the folder
      const result = await service.deleteEntry('to-delete');
      expect(result.success).toBe(true);
      expect(result.freedBytes).toBe(expectedSize);

      // Verify directory no longer exists
      expect(fs.existsSync(path.join(tempDir, 'to-delete'))).toBe(false);
    });
  });

  describe('User bulk-deletes multiple folders', () => {
    it('should delete all folders and return aggregate results', async () => {
      // Setup: create 3 directories with known sizes
      const sizes = [512, 256, 128];
      for (let i = 0; i < 3; i++) {
        const dir = `dir-${i}`;
        fs.mkdirSync(path.join(tempDir, dir));
        fs.writeFileSync(path.join(tempDir, dir, 'data.bin'), 'X'.repeat(sizes[i]));
      }

      const totalExpectedSize = sizes.reduce((a, b) => a + b, 0);

      // Bulk delete all 3
      const result = await service.bulkDelete(['dir-0', 'dir-1', 'dir-2']);
      expect(result.success).toBe(true);
      expect(result.deleted).toBe(3);
      expect(result.freedBytes).toBe(totalExpectedSize);
      expect(result.errors).toHaveLength(0);

      // Verify all directories are gone
      expect(fs.existsSync(path.join(tempDir, 'dir-0'))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, 'dir-1'))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, 'dir-2'))).toBe(false);
    });
  });

  describe('Path traversal is blocked at service level', () => {
    it('should reject directory traversal in listDirectory', async () => {
      await expect(service.listDirectory('../../etc')).rejects.toThrow('directory traversal');
    });

    it('should reject directory traversal in deleteEntry', async () => {
      await expect(service.deleteEntry('../../../tmp')).rejects.toThrow('directory traversal');
    });

    it('should reject directory traversal in bulkDelete', async () => {
      const result = await service.bulkDelete(['../foo']);
      expect(result.success).toBe(false);
      expect(result.deleted).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('directory traversal');
    });
  });

  describe('Non-existent path returns 404', () => {
    it('should throw 404 for non-existent path in listDirectory', async () => {
      try {
        await service.listDirectory('this-does-not-exist');
        expect(true).toBe(false); // Should not reach here
      } catch (e: any) {
        expect(e.statusCode).toBe(404);
        expect(e.message).toContain('not found');
      }
    });
  });

  describe('Cannot delete base path itself', () => {
    it('should reject deletion of root path with empty string', async () => {
      try {
        await service.deleteEntry('');
        expect(true).toBe(false); // Should not reach here
      } catch (e: any) {
        expect(e.statusCode).toBe(400);
        expect(e.message).toContain('workspace root');
      }
    });

    it('should reject deletion of root path with slash', async () => {
      try {
        await service.deleteEntry('/');
        expect(true).toBe(false); // Should not reach here
      } catch (e: any) {
        expect(e.statusCode).toBe(400);
        expect(e.message).toContain('workspace root');
      }
    });
  });

  describe('getUsage returns correct workspace size', () => {
    it('should return usedBytes and usedGB matching workspace contents', async () => {
      // Setup: create known content
      const fileContent = 'B'.repeat(2048); // 2KB
      fs.writeFileSync(path.join(tempDir, 'file.dat'), fileContent);
      fs.mkdirSync(path.join(tempDir, 'subdir'));
      fs.writeFileSync(path.join(tempDir, 'subdir', 'nested.dat'), fileContent);

      const expectedBytes = 2048 * 2; // 2 files of 2KB

      const usage = await service.getUsage();
      expect(usage.usedBytes).toBe(expectedBytes);
      expect(typeof usage.usedBytes).toBe('number');
      expect(typeof usage.usedGB).toBe('number');
      expect(usage.usedGB).toBe(expectedBytes / (1024 * 1024 * 1024));
    });
  });
});
