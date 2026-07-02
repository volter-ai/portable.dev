/**
 * ClaudeHooksInstaller — ensure the Portable lifecycle hooks in the user's
 * REAL `~/.claude/settings.json` (rev12, PRD D53).
 *
 * Installs `portable hook-relay` as the command for the five global lifecycle
 * hooks (SessionStart / UserPromptSubmit / Stop / StopFailure / SessionEnd) so
 * every terminal `claude` session on this PC reports presence to the local api.
 *
 * Contract (all three matter — this file edits the user's own Claude config):
 * - **Additive**: user-authored hooks are NEVER touched; we only manage matcher
 *   groups whose commands contain the `hook-relay` marker.
 * - **Idempotent + self-upgrading**: stale Portable entries (an old install
 *   path) are replaced; a byte-identical config is not rewritten.
 * - **Fail-safe**: an unparseable settings.json is left EXACTLY as-is (status
 *   `failed`) — never risk clobbering the user's file; writes are atomic
 *   (tmp+rename). Respects the LOCKED `~/.claude`-sharing invariant: we write
 *   INTO the shared config, we never redirect it (no CLAUDE_CONFIG_DIR/HOME
 *   games).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

/** The lifecycle hook events Portable listens to (PRD D53). */
export const PORTABLE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const;
export type PortableHookEvent = (typeof PORTABLE_HOOK_EVENTS)[number];

/**
 * Marker identifying a hook command as Portable-managed. `hook-relay` is our
 * subcommand name — a user's own hooks won't contain it, and matching on it
 * (not on an exact command string) lets a fresh install replace entries left
 * behind by an older install at a different path.
 */
export const HOOK_COMMAND_MARKER = 'hook-relay';

/** Hook command timeout (seconds — the hooks config unit). The relay itself
 * bounds its work well under 2s; this is just the CLI-side hard stop. */
const HOOK_TIMEOUT_SECONDS = 10;

/** Default path of the user's global Claude Code settings. */
export function defaultClaudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * The hook command that re-enters THIS install:
 * `"<runtime>" "<cli>" hook-relay [--bridge "<path>"]`.
 * `process.execPath` is the bun/node binary and `process.argv[1]` the cli
 * entry — correct for both dev-from-source (bun + cli.ts) and the packaged
 * artifact (cli.js). Paths are quoted (spaces on macOS/Windows).
 *
 * `bridgePath` (the launcher's absolute `internal-bridge.json`) is embedded so
 * the claude-spawned relay never re-resolves DATA_DIR from the project env (B2).
 */
export function buildHookRelayCommand(
  execPath: string = process.execPath,
  cliEntry: string = process.argv[1] ?? '',
  bridgePath?: string
): string {
  const base = `"${execPath}" "${cliEntry}" ${HOOK_COMMAND_MARKER}`;
  return bridgePath ? `${base} --bridge "${bridgePath}"` : base;
}

interface HookCommandEntry {
  type: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}

interface HookMatcherGroup {
  matcher?: string;
  hooks?: HookCommandEntry[];
  [key: string]: unknown;
}

export interface InstallClaudeHooksResult {
  status: 'installed' | 'unchanged' | 'failed';
  /** Human detail for logs/TUI (e.g. the failure reason). */
  detail?: string;
  /** The settings file that was (or would have been) edited. */
  settingsPath: string;
}

function isPortableGroup(group: HookMatcherGroup): boolean {
  return (
    Array.isArray(group.hooks) &&
    group.hooks.some(
      (h) => typeof h?.command === 'string' && h.command.includes(HOOK_COMMAND_MARKER)
    )
  );
}

/**
 * Pure merge: returns the new settings object plus whether anything changed.
 * Exported for tests — {@link installClaudeHooks} wraps it with the file I/O.
 */
export function mergePortableHooks(
  settings: Record<string, unknown>,
  command: string
): { next: Record<string, unknown>; changed: boolean } {
  const next: Record<string, unknown> = { ...settings };
  const hooks: Record<string, unknown> =
    next.hooks && typeof next.hooks === 'object' && !Array.isArray(next.hooks)
      ? { ...(next.hooks as Record<string, unknown>) }
      : {};
  let changed = false;

  for (const event of PORTABLE_HOOK_EVENTS) {
    const raw = hooks[event];
    const groups: HookMatcherGroup[] = Array.isArray(raw) ? [...(raw as HookMatcherGroup[])] : [];

    const desired: HookMatcherGroup = {
      hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }],
    };

    const ours = groups.filter(isPortableGroup);
    const theirs = groups.filter((g) => !isPortableGroup(g));
    const alreadyCurrent =
      ours.length === 1 &&
      ours[0].hooks?.length === 1 &&
      ours[0].hooks[0].command === command &&
      ours[0].hooks[0].timeout === HOOK_TIMEOUT_SECONDS &&
      ours[0].matcher === undefined;

    if (alreadyCurrent) {
      hooks[event] = [...theirs, ours[0]];
      continue;
    }
    hooks[event] = [...theirs, desired];
    changed = true;
  }

  next.hooks = hooks;
  return { next, changed };
}

/**
 * Ensure the Portable hooks in `settingsPath` (default: the user's real
 * `~/.claude/settings.json`). Never throws.
 */
export function installClaudeHooks(
  options: {
    settingsPath?: string;
    command?: string;
    /** Absolute bridge path embedded into the default command (B2). */
    bridgePath?: string;
    log?: (line: string) => void;
  } = {}
): InstallClaudeHooksResult {
  const settingsPath = options.settingsPath ?? defaultClaudeSettingsPath();
  const command =
    options.command ??
    buildHookRelayCommand(process.execPath, process.argv[1] ?? '', options.bridgePath);
  const log = options.log ?? (() => {});

  let settings: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // A non-object settings file is not ours to fix — leave it alone.
      return {
        status: 'failed',
        detail: 'settings.json is not a JSON object — left untouched',
        settingsPath,
      };
    }
    settings = parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      // Exists but unreadable/unparseable → NEVER rewrite the user's file.
      return {
        status: 'failed',
        detail: `settings.json unreadable/unparseable — left untouched (${
          err instanceof Error ? err.message : String(err)
        })`,
        settingsPath,
      };
    }
    // Missing file: we create it with just our hooks.
  }

  const { next, changed } = mergePortableHooks(settings, command);
  if (!changed) {
    return { status: 'unchanged', settingsPath };
  }

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const tmp = `${settingsPath}.portable-tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, settingsPath);
    log(`[hooks] Portable lifecycle hooks installed in ${settingsPath}`);
    return { status: 'installed', settingsPath };
  } catch (err) {
    return {
      status: 'failed',
      detail: `could not write settings.json (${err instanceof Error ? err.message : String(err)})`,
      settingsPath,
    };
  }
}
