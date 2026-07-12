import { spawn } from 'child_process';

export interface RunGitOptions {
  cwd?: string;
  /** Kill the process after this many ms (0/undefined = no timeout). */
  timeoutMs?: number;
  /**
   * Kill the process once accumulated stdout exceeds this many bytes
   * (0/undefined = no ceiling). Bounds memory + parse cost when a command
   * such as `git status --porcelain` could emit a huge listing on a large repo.
   */
  maxOutputBytes?: number;
  /** Extra env vars merged over process.env. */
  env?: NodeJS.ProcessEnv;
  /** Called with each stderr chunk (git emits progress on stderr). */
  onProgress?: (chunk: string) => void;
  /**
   * Exit codes that resolve with stdout instead of rejecting. Defaults to `[0]`
   * (the historical behavior). Set e.g. `[0, 1]` for commands like
   * `git diff --no-index` that use exit 1 to signal "differences found" rather
   * than an error. Purely additive — an unset value preserves the exit-0-only
   * contract every existing caller relies on.
   */
  allowExitCodes?: number[];
}

/**
 * A git command was killed because it hit a resource ceiling (a timeout or the
 * stdout byte cap) rather than failing on its own. Callers use the `kind` to
 * distinguish "git is too slow/big on this repo, degrade gracefully" from a
 * genuine git error (bad repo, no commits) which should still surface as 500.
 *
 * Extends Error so existing `instanceof Error` / `.message` consumers keep
 * working; the timeout message text is preserved for clone-path logs/tests.
 */
export class GitResourceLimitError extends Error {
  constructor(
    message: string,
    public readonly kind: 'timeout' | 'output' | 'cooldown'
  ) {
    super(message);
    this.name = 'GitResourceLimitError';
  }
}

/**
 * Run a git command via `spawn`, streaming stdout into memory with NO maxBuffer
 * ceiling. Unlike promisified `execFile` (1 MB default maxBuffer), this never
 * fails on large outputs such as big diffs or verbose clone progress.
 *
 * Resolves with full stdout on exit code 0, rejects on non-zero exit, spawn
 * error, timeout, or exceeding `maxOutputBytes` (the child is SIGKILLed on the
 * latter two, which reject with {@link GitResourceLimitError}).
 */
export function runGit(args: string[], options: RunGitOptions = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        finish(() => {
          child.kill('SIGKILL');
          reject(
            new GitResourceLimitError(
              `git ${args[0]} timed out after ${options.timeoutMs}ms`,
              'timeout'
            )
          );
        });
      }, options.timeoutMs);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      if (options.maxOutputBytes && options.maxOutputBytes > 0) {
        stdoutBytes += chunk.length;
        if (stdoutBytes > options.maxOutputBytes) {
          finish(() => {
            child.kill('SIGKILL');
            reject(
              new GitResourceLimitError(
                `git ${args[0]} exceeded ${options.maxOutputBytes} bytes of output`,
                'output'
              )
            );
          });
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      if (options.onProgress) options.onProgress(chunk.toString());
    });

    // A stream 'error' with no listener (e.g. EPIPE when we SIGKILL on timeout)
    // would surface as an uncaughtException and, in production, crash the whole
    // process. Swallow stream errors here; the 'error'/'close' events on the
    // child drive the promise outcome.
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    child.on('error', (err) => finish(() => reject(err)));

    child.on('close', (code) => {
      finish(() => {
        const allowed = options.allowExitCodes ?? [0];
        if (code !== null && allowed.includes(code)) {
          resolve(Buffer.concat(stdoutChunks).toString());
        } else {
          const stderr = Buffer.concat(stderrChunks).toString().trim();
          reject(new Error(`git ${args.join(' ')} exited with code ${code}: ${stderr}`));
        }
      });
    });
  });
}
