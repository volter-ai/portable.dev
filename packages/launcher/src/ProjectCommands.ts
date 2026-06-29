import os from 'os';

import {
  notifyRunningInstanceOfRepoChange,
  type NotifyRepoChange,
} from './NotifyRunningInstance.js';
import {
  classifyDir,
  linkProject,
  resolveWorkspaceDir,
  unlinkProject,
  type LinkResult,
  type ProjectLinkFs,
  type UnlinkResult,
} from './ProjectLink.js';

/**
 * Command orchestration for `portable link` / `portable unlink` and the SILENT
 * auto-link that runs on bare `portable` / `portable connect`. Wraps the
 * filesystem primitives in {@link ProjectLink} with the user-facing policy:
 *
 *   - **auto-link** (connect path): link ONLY when the cwd is a git repo UNDER the
 *     home dir and not home itself — silent, never blocks. Anything else is skipped
 *     without a word (so `portable` in `~`, `/`, or `C:\WINDOWS\System32` does
 *     nothing).
 *   - **`portable link`** (explicit): refuses a filesystem/system dir outright;
 *     warns + CONFIRMS when the cwd is the home dir ("your home directory should
 *     probably not be loaded"); requires a git repo; otherwise links.
 *   - **`portable unlink`**: removes the junction + the repo-views entry.
 *
 * The confirm prompt + log sink are injectable for tests.
 */

/** Yes/no prompt seam (the home-dir confirmation). Defaults to a stdin reader. */
export type ConfirmFn = (question: string) => Promise<boolean>;

const realConfirm: ConfirmFn = (question) =>
  new Promise((resolve) => {
    try {
      process.stdout.write(`${question} [y/N] `);
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const onData = (chunk: Buffer) => {
      if (settled) return;
      settled = true;
      try {
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
      } catch {
        /* ignore */
      }
      const text = chunk.toString().trim().toLowerCase();
      resolve(text === 'y' || text === 'yes');
    };
    try {
      process.stdin.resume();
      process.stdin.once('data', onData);
    } catch {
      resolve(false);
    }
  });

export interface ProjectCommandDeps {
  /** The directory to act on. Defaults to `process.cwd()`. */
  dir?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  log?: (line: string) => void;
  confirm?: ConfirmFn;
  fsi?: ProjectLinkFs;
  /**
   * Best-effort "tell a running `portable` to rescan" seam (injected in tests).
   * Defaults to the real loopback notifier {@link notifyRunningInstanceOfRepoChange}.
   * Returns true when a running instance picked up the change (no restart needed).
   */
  notify?: NotifyRepoChange;
}

function resolveCommon(deps: ProjectCommandDeps) {
  const env = deps.env ?? process.env;
  const homedir = deps.homedir ?? os.homedir();
  return {
    env,
    homedir,
    dir: deps.dir ?? process.cwd(),
    log: deps.log ?? ((line: string) => console.log(line)),
    confirm: deps.confirm ?? realConfirm,
    fsi: deps.fsi,
    notify: deps.notify ?? (() => notifyRunningInstanceOfRepoChange({ env })),
    workspaceDir: resolveWorkspaceDir(env, homedir),
  };
}

/**
 * Tell the user the outcome of the link/unlink: try to nudge a RUNNING `portable`
 * to pick it up live; only fall back to "restart" when nothing is running (or the
 * nudge failed). `restartHint` is the action verb for the fallback line
 * ("see it in the app" / "update the app").
 */
async function announceRepoChange(
  c: { log: (line: string) => void; notify: NotifyRepoChange },
  restartHint: string
): Promise<void> {
  const notified = await c.notify();
  if (notified) {
    c.log('[portable] ✓ Updated the running app — no restart needed.');
  } else {
    c.log(`[portable] Restart \`portable\` (or start it) to ${restartHint}.`);
  }
}

/**
 * Silent auto-link for the connect path. Links the cwd IFF it's a git repo under
 * home (and not home/system/root). Returns the {@link LinkResult} when it linked,
 * or null when skipped (ineligible). Never throws — a link failure is logged but
 * never blocks boot.
 */
export function autoLinkIfEligible(deps: ProjectCommandDeps = {}): LinkResult | null {
  const c = resolveCommon(deps);
  let result: LinkResult | null = null;
  try {
    const cls = classifyDir(c.dir, { homedir: c.homedir, env: c.env, fsi: c.fsi });
    if (!cls.autoEligible) return null;
    result = linkProject({ dir: c.dir, workspaceDir: c.workspaceDir, fsi: c.fsi });
    if (result.ok && !result.alreadyLinked && !result.alreadyInWorkspace) {
      c.log(`[portable] linked this project (${result.fullName}) — it'll appear in the app.`);
    }
  } catch {
    // Auto-link is best-effort — never block the connect flow.
    return null;
  }
  return result;
}

/** A one-screen warning for linking the home directory. */
function homeWarning(dir: string): string {
  return [
    '',
    '  ⚠  You are about to link your HOME directory:',
    `       ${dir}`,
    '',
    '  This loads your entire home folder as a Portable project — usually a bad idea',
    '  (huge, full of unrelated files, and it buries your real projects). You almost',
    '  certainly want to run `portable link` inside a specific project folder instead.',
    '',
  ].join('\n');
}

/**
 * Explicit `portable link`. Applies the policy (system/home guards + git-repo
 * requirement), prompting to confirm a home-dir link. Returns the LinkResult, or a
 * synthetic `{ ok: false }` when refused/cancelled.
 */
export async function runLinkCommand(deps: ProjectCommandDeps = {}): Promise<LinkResult> {
  const c = resolveCommon(deps);
  const cls = classifyDir(c.dir, { homedir: c.homedir, env: c.env, fsi: c.fsi });

  if (cls.isProtected) {
    c.log(`[portable] Refusing to link a system / root directory: ${c.dir}`);
    return { ok: false, fullName: '', message: 'protected directory' };
  }
  if (!cls.isGitRepo) {
    c.log(`[portable] ${c.dir} is not a git repository — Portable only displays git projects.`);
    c.log('[portable] Run `git init` (and add a remote) here first, then `portable link`.');
    return { ok: false, fullName: '', message: 'not a git repository' };
  }
  if (cls.isHome) {
    c.log(homeWarning(c.dir));
    const proceed = await c.confirm('Link your home directory anyway?');
    if (!proceed) {
      c.log('[portable] Cancelled — home directory not linked.');
      return { ok: false, fullName: '', message: 'cancelled' };
    }
  }

  const result = linkProject({ dir: c.dir, workspaceDir: c.workspaceDir, fsi: c.fsi });
  if (result.ok) {
    c.log(`[portable] ${result.message}`);
    if (!result.alreadyLinked) {
      await announceRepoChange(c, 'see it in the app');
    }
  } else {
    c.log(`[portable] Could not link: ${result.message}`);
  }
  return result;
}

/** Explicit `portable unlink`. */
export async function runUnlinkCommand(deps: ProjectCommandDeps = {}): Promise<UnlinkResult> {
  const c = resolveCommon(deps);
  const result = unlinkProject({ dir: c.dir, workspaceDir: c.workspaceDir, fsi: c.fsi });
  c.log(`[portable] ${result.message}`);
  if (result.ok) {
    await announceRepoChange(c, 'update the app');
  }
  return result;
}
