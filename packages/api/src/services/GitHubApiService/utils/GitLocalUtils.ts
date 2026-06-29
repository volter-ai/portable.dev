import { exec } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';

import ignore from 'ignore';

const execAsync = promisify(exec);

// POSIX (`exec` → /bin/sh) supports `2>/dev/null` (suppress stderr) and `|| echo …`
// (shell fallback). Windows (`exec` → cmd.exe) does NOT: it treats `/dev/null` as a
// path and FAILS the whole command, so the real git output was lost. We therefore
// keep the EXACT original POSIX commands and only DROP those shell constructs on
// Windows — `execAsync` returns `{ stdout, stderr }` separately (stderr is ignored)
// and each function's try/catch supplies the default on a non-zero exit. This keeps
// macOS/Linux behaviour byte-for-byte unchanged while fixing Windows.
const IS_WINDOWS = process.platform === 'win32';
/** Append POSIX `2>/dev/null` (no-op on Windows). */
const q = (cmd: string): string => (IS_WINDOWS ? cmd : `${cmd} 2>/dev/null`);

/**
 * Load and parse .gitignore file from repo root
 */
export async function loadGitignore(repoPath: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore();
  const gitignorePath = path.join(repoPath, '.gitignore');

  try {
    const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
    ig.add(gitignoreContent);
  } catch (err) {
    // .gitignore doesn't exist or can't be read, that's fine
  }

  return ig;
}

/**
 * Get unpushed commits count for a local repository
 */
export async function getUnpushedCommitsCount(localPath: string): Promise<number> {
  try {
    const { stdout } = await execAsync(q('git log --branches --not --remotes --oneline'), {
      cwd: localPath,
    });
    const lines = stdout
      .trim()
      .split('\n')
      .filter((l) => l);
    return lines.length;
  } catch (err) {
    console.warn('[GitLocalUtils] Failed to get unpushed commits for', localPath, err);
    return 0;
  }
}

/**
 * Get current branch name
 */
export async function getCurrentBranch(localPath: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
      cwd: localPath,
    });
    return stdout.trim();
  } catch (err) {
    console.error('[GitLocalUtils] Error getting current branch:', err);
    return null;
  }
}

/**
 * Get remote tracking branch
 */
export async function getRemoteBranch(localPath: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(q('git rev-parse --abbrev-ref --symbolic-full-name @{u}'), {
      cwd: localPath,
    });
    return stdout.trim() || null;
  } catch (err) {
    console.debug('[GitLocalUtils] No remote tracking branch for', localPath, err);
    return null;
  }
}

/**
 * Get ahead/behind info relative to upstream
 */
export async function getAheadBehind(
  localPath: string
): Promise<{ ahead: number; behind: number } | null> {
  try {
    const { stdout } = await execAsync(
      // POSIX keeps the original suppress + `|| echo "0\t0"` (→ {0,0} when there's
      // no upstream). On Windows the bare command fails on no-upstream → the catch
      // returns null, which the caller treats the same as {0,0} (no ahead/behind).
      IS_WINDOWS
        ? 'git rev-list --left-right --count HEAD...@{u}'
        : 'git rev-list --left-right --count HEAD...@{u} 2>/dev/null || echo "0\t0"',
      { cwd: localPath }
    );
    const [ahead, behind] = stdout
      .trim()
      .split(/\s+/)
      .map((n) => parseInt(n) || 0);
    return { ahead, behind };
  } catch (err) {
    console.error('[GitLocalUtils] Error getting ahead/behind:', err);
    return null;
  }
}

/**
 * Get unpushed commits with details
 */
export async function getUnpushedCommits(
  localPath: string
): Promise<Array<{ sha: string; message: string; author: string; date: string }>> {
  try {
    // Try to use upstream branch first (more reliable)
    const gitLogCommand = q('git log @{u}..HEAD --format="%H|%s|%an|%ai"');
    try {
      const { stdout } = await execAsync(gitLogCommand, { cwd: localPath });
      if (stdout.trim()) {
        const lines = stdout
          .trim()
          .split('\n')
          .filter((l) => l);
        return lines.map((line) => {
          const [sha, message, author, date] = line.split('|');
          return { sha: sha.substring(0, 7), message, author, date };
        });
      }
    } catch (upstreamErr) {
      console.debug(
        '[GitLocalUtils] Upstream branch not found, falling back to --not --remotes:',
        upstreamErr
      );
      // Fallback to --not --remotes if upstream branch doesn't exist
      const { stdout } = await execAsync(
        q('git log HEAD --not --remotes --format="%H|%s|%an|%ai"'),
        { cwd: localPath }
      );
      if (stdout.trim()) {
        const lines = stdout
          .trim()
          .split('\n')
          .filter((l) => l);
        return lines.map((line) => {
          const [sha, message, author, date] = line.split('|');
          return { sha: sha.substring(0, 7), message, author, date };
        });
      }
    }
  } catch (err) {
    console.error('[GitLocalUtils] Error getting unpushed commits:', err);
  }
  return [];
}

/**
 * Get git status (porcelain format)
 */
export async function getGitStatus(
  localPath: string
): Promise<Array<{ path: string; status: string }>> {
  try {
    const { stdout } = await execAsync('git status --porcelain', { cwd: localPath });
    if (!stdout.trim()) {
      return [];
    }

    const lines = stdout.trim().split('\n');
    return lines.map((line) => {
      const statusCode = line.substring(0, 2);
      const filePath = line.substring(3);
      let status = 'modified';

      // Parse status codes (first char is staged, second is unstaged)
      const staged = statusCode[0];
      const unstaged = statusCode[1];

      if (unstaged === '?' || staged === '?') status = 'untracked';
      else if (staged === 'A' || unstaged === 'A') status = 'added';
      else if (staged === 'D' || unstaged === 'D') status = 'deleted';
      else if (staged === 'M' || unstaged === 'M') status = 'modified';
      else if (staged === 'R' || unstaged === 'R') status = 'renamed';

      return { path: filePath, status };
    });
  } catch (err) {
    console.error('[GitLocalUtils] Error getting git status:', err);
    return [];
  }
}

/**
 * Check if a path is a git repository
 */
export async function isGitRepository(repoPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(repoPath, '.git'));
    return true;
  } catch {
    return false;
  }
}
