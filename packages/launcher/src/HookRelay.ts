/**
 * `portable hook-relay` — the Claude Code lifecycle-hook relay (rev12, PRD D53).
 *
 * Installed by {@link installClaudeHooks} as the command for the global
 * SessionStart / UserPromptSubmit / Stop / StopFailure / SessionEnd hooks in the
 * user's `~/.claude/settings.json`. Claude Code spawns it per hook event with
 * the event payload as JSON on stdin (`session_id`, `transcript_path`, `cwd`,
 * `hook_event_name`, …). It augments the payload with best-effort process
 * ancestry (so the api can associate a PID with the session) and POSTs it to
 * the api's loopback internal endpoint discovered via the bridge file.
 *
 * HARD RULES (a broken hook degrades the user's own terminal `claude`):
 * - NEVER write to stdout — Claude Code injects SessionStart hook stdout into
 *   the model context, and non-JSON stdout can trip hook output parsing.
 * - ALWAYS exit 0, fast: bounded stdin read, bounded fetch, everything
 *   best-effort. Portable being off is the NORMAL case, not an error.
 */
import { spawnSync } from 'child_process';

import { readBridgeFromFile, readInternalBridge, type InternalBridge } from './InternalBridge.js';

/** Header carrying the per-boot internal secret (see InternalBridge). */
export const INTERNAL_SECRET_HEADER = 'x-portable-internal-secret';

/** One process-tree ancestor of the hook process (best-effort, POSIX only). */
export interface ProcessAncestor {
  pid: number;
  /** The ancestor's comm/command name (e.g. `claude`, `zsh`, `node`). */
  command: string;
}

/**
 * Walk up the process tree from `startPid` (the hook process's parent) via
 * `ps`, up to `depth` levels. Claude Code runs hook commands through a shell,
 * and whether the shell `exec`s the command (making our parent the `claude`
 * process directly) is shell-dependent — so the api gets the whole short chain
 * and picks the claude-looking entry. Windows has no `ps`: returns []. Any
 * failure returns what was collected so far (never throws).
 */
export function readProcessAncestors(startPid: number, depth = 3): ProcessAncestor[] {
  const ancestors: ProcessAncestor[] = [];
  if (process.platform === 'win32') return ancestors;
  let pid = startPid;
  for (let i = 0; i < depth && pid > 1; i++) {
    try {
      const out = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 300,
      });
      if (out.status !== 0 || !out.stdout) break;
      const line = out.stdout.trim();
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) break;
      const ppid = Number(match[1]);
      const command = match[2].trim();
      // The `ps -p <pid>` line gives <pid>'s OWN comm plus its ppid — record
      // pid with its command, then step up.
      ancestors.push({ pid, command });
      pid = ppid;
    } catch {
      break;
    }
  }
  return ancestors;
}

export interface RunHookRelayOptions {
  /** Injectable stdin reader (tests). Defaults to a bounded read of process.stdin. */
  readStdin?: () => Promise<string>;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Absolute path to `internal-bridge.json`, embedded by the launcher into the
   * installed hook command (`--bridge <path>`). When set the relay reads THAT
   * file directly instead of re-resolving DATA_DIR (which a project `.env` can
   * point elsewhere — B2). Falls back to the DATA_DIR default when absent.
   */
  bridgePath?: string;
  /** Injectable bridge reader (tests). Overrides bridgePath/default. */
  readBridge?: () => InternalBridge | null;
  /** Injectable ancestry reader (tests). Defaults to {@link readProcessAncestors}. */
  readAncestors?: (startPid: number) => ProcessAncestor[];
  /** The hook process's parent pid. Defaults to process.ppid. */
  ppid?: number;
  /** Max ms to wait for stdin before relaying without a payload. */
  stdinTimeoutMs?: number;
  /** Max ms for the loopback POST. */
  fetchTimeoutMs?: number;
}

/** Bounded stdin read: resolves with whatever arrived by EOF or the timeout. */
function readStdinBounded(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => {
        // Hook payloads are small; cap defensively so a runaway pipe can't balloon.
        if (data.length < 256 * 1024) data += chunk;
      });
      process.stdin.on('end', () => {
        clearTimeout(timer);
        finish();
      });
      process.stdin.on('error', () => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

/**
 * Relay one hook event to the api. Never throws, never writes stdout, and the
 * caller must exit 0 regardless. Returns true when the POST got a 2xx (tests).
 */
export async function runHookRelay(options: RunHookRelayOptions = {}): Promise<boolean> {
  const {
    readStdin = () => readStdinBounded(options.stdinTimeoutMs ?? 400),
    fetchImpl = fetch,
    readBridge = () =>
      options.bridgePath ? readBridgeFromFile(options.bridgePath) : readInternalBridge(),
    readAncestors = (pid: number) => readProcessAncestors(pid),
    ppid = process.ppid,
    fetchTimeoutMs = 900,
  } = options;

  try {
    const bridge = readBridge();
    if (!bridge) return false; // Portable is off — the normal quiet case.

    const raw = await readStdin();
    let payload: Record<string, unknown> = {};
    try {
      payload = raw.trim().length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      // Unparseable stdin — relay nothing rather than garbage.
      return false;
    }

    const body = JSON.stringify({
      ...payload,
      portable: { ppid, ancestors: readAncestors(ppid) },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      const res = await fetchImpl(`http://127.0.0.1:${bridge.port}/api/internal/claude-hook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [INTERNAL_SECRET_HEADER]: bridge.secret,
        },
        body,
        signal: controller.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
