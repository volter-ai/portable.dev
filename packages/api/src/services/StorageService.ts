import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import type {
  StorageEntry,
  StorageListResponse,
  StorageUsageResponse,
  StorageDeleteResponse,
  StorageBulkDeleteResponse,
} from '@vgit2/shared/types';

const execFileAsync = promisify(execFile);
const DEFAULT_BASE_PATH = '/workspace/claude-workspace';
const USAGE_CACHE_TTL_MS = 60_000; // 60 seconds

export class StorageService {
  private basePath: string;
  private usageCache: { value: StorageUsageResponse; timestamp: number } | null = null;

  constructor(basePath?: string) {
    this.basePath = basePath ?? DEFAULT_BASE_PATH;
  }

  /**
   * Resolve a relative path against basePath and validate it doesn't escape.
   * Throws 400 for traversal attempts, 404 for non-existent paths.
   */
  private resolveSafePath(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, '/');
    const resolved = path.resolve(this.basePath, normalized);

    if (!resolved.startsWith(this.basePath)) {
      const err = new Error('Invalid path: directory traversal not allowed');
      (err as any).statusCode = 400;
      throw err;
    }

    return resolved;
  }

  /**
   * Get directory size using `find` (kernel-level, non-blocking).
   * Only counts file sizes (not directory entries) for consistency.
   * Falls back to synchronous JS traversal if the command fails.
   */
  private async getDirectorySizeBytesAsync(dirPath: string): Promise<number> {
    try {
      const { stdout } = await execFileAsync(
        'find',
        [dirPath, '-not', '-type', 'l', '-type', 'f', '-printf', '%s\\n'],
        { timeout: 20_000 }
      );
      if (!stdout.trim()) return 0;
      let total = 0;
      for (const line of stdout.trim().split('\n')) {
        total += parseInt(line, 10) || 0;
      }
      return total;
    } catch {
      // Fallback to sync traversal (e.g., in test environments without find)
      return this.getDirectorySizeBytesSync(dirPath);
    }
  }

  /**
   * Synchronous recursive size calculation (fallback only).
   * Skips symlinks to prevent traversal attacks.
   */
  private getDirectorySizeBytesSync(dirPath: string): number {
    let totalBytes = 0;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return 0;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        totalBytes += this.getDirectorySizeBytesSync(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          totalBytes += stat.size;
        } catch {
          // Skip inaccessible files
        }
      }
    }

    return totalBytes;
  }

  /**
   * List directory contents with sizes.
   * Returns entries for root when relativePath is empty or '/'.
   */
  async listDirectory(relativePath: string = ''): Promise<StorageListResponse> {
    const cleanPath = relativePath.trim() === '' || relativePath.trim() === '/' ? '' : relativePath;
    const resolved = cleanPath === '' ? this.basePath : this.resolveSafePath(cleanPath);

    if (!fs.existsSync(resolved)) {
      const err = new Error(`Path not found: ${relativePath}`);
      (err as any).statusCode = 404;
      throw err;
    }

    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      const err = new Error('Path is not a directory');
      (err as any).statusCode = 400;
      throw err;
    }

    const dirents = fs.readdirSync(resolved, { withFileTypes: true });
    const entries: StorageEntry[] = [];
    let totalSizeBytes = 0;

    // Calculate sizes concurrently for all directories
    const sizePromises: Promise<{ index: number; size: number }>[] = [];
    const entryData: {
      name: string;
      type: 'file' | 'directory';
      modifiedAt: string;
      sizeBytes: number;
    }[] = [];

    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue;

      const fullPath = path.join(resolved, dirent.name);
      let modifiedAt: string;
      let sizeBytes = 0;

      try {
        const entryStat = fs.statSync(fullPath);
        modifiedAt = entryStat.mtime.toISOString();

        if (dirent.isFile()) {
          sizeBytes = entryStat.size;
        }
      } catch {
        modifiedAt = new Date().toISOString();
      }

      const idx = entryData.length;
      entryData.push({
        name: dirent.name,
        type: dirent.isDirectory() ? 'directory' : 'file',
        modifiedAt,
        sizeBytes,
      });

      if (dirent.isDirectory()) {
        sizePromises.push(
          this.getDirectorySizeBytesAsync(fullPath).then((size) => ({ index: idx, size }))
        );
      }
    }

    // Wait for all directory size calculations
    const sizeResults = await Promise.all(sizePromises);
    for (const { index, size } of sizeResults) {
      entryData[index].sizeBytes = size;
    }

    for (const entry of entryData) {
      entries.push(entry);
      totalSizeBytes += entry.sizeBytes;
    }

    return {
      entries,
      totalSizeBytes,
      path: cleanPath || '/',
    };
  }

  /**
   * Delete a file or directory and return how many bytes were freed.
   * Cannot delete the base path itself.
   */
  async deleteEntry(relativePath: string): Promise<StorageDeleteResponse> {
    const cleanPath = relativePath.trim();

    if (cleanPath === '' || cleanPath === '/') {
      const err = new Error('Cannot delete the workspace root');
      (err as any).statusCode = 400;
      throw err;
    }

    const resolved = this.resolveSafePath(cleanPath);

    if (resolved === this.basePath) {
      const err = new Error('Cannot delete the workspace root');
      (err as any).statusCode = 400;
      throw err;
    }

    if (!fs.existsSync(resolved)) {
      const err = new Error(`Path not found: ${relativePath}`);
      (err as any).statusCode = 404;
      throw err;
    }

    const stat = fs.statSync(resolved);
    const sizeBytes = stat.isDirectory()
      ? await this.getDirectorySizeBytesAsync(resolved)
      : stat.size;

    fs.rmSync(resolved, { recursive: true, force: true });
    this.invalidateUsageCache();

    return { success: true, freedBytes: sizeBytes };
  }

  /**
   * Get total workspace usage in bytes and GB.
   * Uses `du -sb` for fast kernel-level calculation with 60s cache.
   */
  async getUsage(): Promise<StorageUsageResponse> {
    const now = Date.now();
    if (this.usageCache && now - this.usageCache.timestamp < USAGE_CACHE_TTL_MS) {
      return this.usageCache.value;
    }

    const usedBytes = await this.getDirectorySizeBytesAsync(this.basePath);
    const result: StorageUsageResponse = {
      usedBytes,
      usedGB: usedBytes / (1024 * 1024 * 1024),
    };

    this.usageCache = { value: result, timestamp: now };
    return result;
  }

  /** Invalidate the usage cache (e.g., after deletions). */
  invalidateUsageCache(): void {
    this.usageCache = null;
  }

  /**
   * Delete multiple entries and return aggregate results.
   * Validates all paths first, then deletes each, accumulating results.
   */
  async bulkDelete(relativePaths: string[]): Promise<StorageBulkDeleteResponse> {
    if (!relativePaths || relativePaths.length === 0) {
      const err = new Error('No paths provided for deletion');
      (err as any).statusCode = 400;
      throw err;
    }

    let freedBytes = 0;
    let deleted = 0;
    const errors: string[] = [];

    for (const relPath of relativePaths) {
      try {
        const result = await this.deleteEntry(relPath);
        freedBytes += result.freedBytes;
        deleted++;
      } catch (e: any) {
        errors.push(`${relPath}: ${e.message}`);
      }
    }

    return {
      success: errors.length === 0,
      freedBytes,
      deleted,
      errors,
    };
  }
}
