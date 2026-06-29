/**
 * GitLocalService — large output handling
 *
 * THE STORY: A repo has a diff bigger than 1 MB (generated lockfile, large asset,
 * big refactor). The user opens the changes view.
 *
 * REGRESSION GUARD: The old implementation ran `git diff` via promisified
 * `execFile`, which buffers stdout against a 1 MB default `maxBuffer`. Any diff
 * larger than that killed the child and threw "stdout maxBuffer length exceeded",
 * so the entire diff view failed. After switching to `spawn` + streamed
 * accumulation there is no buffer ceiling and the full diff is returned.
 *
 * This test uses REAL git (no child_process mock) so it exercises the real
 * buffering behavior. It does not require a database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { GitLocalService } from '../../../src/services/GitLocalService';

describe('GitLocalService — large diff output', () => {
  let gitLocalService: GitLocalService;
  let repoPath: string;
  let largeDiffBytes = 0;

  beforeEach(async () => {
    gitLocalService = new GitLocalService();

    // Real temp git repo (outside the user workspace)
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitlocal-large-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' });

    git(['init']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test User']);
    git(['config', 'commit.gpgsign', 'false']);

    // Commit an empty tracked file...
    const filePath = path.join(repoPath, 'big.txt');
    await fs.writeFile(filePath, '');
    git(['add', 'big.txt']);
    git(['commit', '-m', 'add empty big.txt']);

    // ...then fill it with ~2.4 MB of content so the unstaged diff exceeds the
    // 1 MB execFile maxBuffer default by a wide margin.
    let content = '';
    for (let i = 0; i < 60000; i++) {
      content += `line ${i} ${'x'.repeat(30)}\n`;
    }
    largeDiffBytes = Buffer.byteLength(content);
    await fs.writeFile(filePath, content);
  });

  afterEach(async () => {
    try {
      await fs.rm(repoPath, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('returns a diff larger than the 1 MB execFile maxBuffer without failing', async () => {
    // Sanity: the generated diff is well above 1 MB
    expect(largeDiffBytes).toBeGreaterThan(1024 * 1024);

    const diff = await gitLocalService.getUnifiedDiff(repoPath);

    expect(typeof diff).toBe('string');
    // The full diff must come back (additions for every line), proving no
    // maxBuffer truncation/failure occurred.
    expect(diff.length).toBeGreaterThan(1024 * 1024);
    expect(diff).toContain('line 0 ');
    expect(diff).toContain('line 59999 ');
  }, 20000);
});
