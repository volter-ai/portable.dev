/**
 * McpSidecarRegistrar — ensure the `portable-sidecar` MCP server in the user's
 * USER-SCOPE Claude Code config (rev12, PRD D58/D61).
 *
 * Registration is one entry in `~/.claude.json` `mcpServers`:
 *   "portable-sidecar": { command: <abs runtime>, args: [<abs cli>, "mcp-sidecar"] }
 * Absolute paths on purpose (GUI-terminal PATH divergence, Windows shims).
 *
 * Write strategy — `~/.claude.json` is Claude Code's own state file, rewritten
 * by the CLI itself, so a blind read-modify-write can race a live session:
 * 1. If the entry is already EXACTLY current → touch nothing (the common case,
 *    every boot after the first).
 * 2. Prefer `claude mcp add --scope user` (the CLI's own writer).
 * 3. Fall back to a direct atomic read-modify-write when the `claude` binary
 *    isn't available. The race window is accepted: the entry is re-ensured on
 *    every `portable start`, so a clobbered registration self-heals next boot.
 * An unparseable file is NEVER rewritten (status `failed`).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** The registered MCP server name. */
export const SIDECAR_SERVER_NAME = 'portable-sidecar';

export function defaultClaudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

export interface SidecarEntry {
  command: string;
  args: string[];
}

/**
 * The registration that re-enters THIS install. `bridgePath` (the launcher's
 * absolute `internal-bridge.json`) is appended as `--bridge <path>` so the
 * claude-spawned sidecar never re-resolves DATA_DIR from the project env (B2).
 */
export function desiredSidecarEntry(
  execPath: string = process.execPath,
  cliEntry: string = process.argv[1] ?? '',
  bridgePath?: string
): SidecarEntry {
  const args = ['mcp-sidecar'];
  if (bridgePath) args.push('--bridge', bridgePath);
  return { command: execPath, args: [cliEntry, ...args] };
}

export interface EnsureSidecarResult {
  status: 'registered' | 'unchanged' | 'failed';
  detail?: string;
}

export interface EnsureSidecarOptions {
  claudeJsonPath?: string;
  entry?: SidecarEntry;
  /** Absolute bridge path embedded into the default entry (B2). */
  bridgePath?: string;
  /**
   * Run `claude mcp add …` (the preferred writer). Throw to signal
   * unavailability (ENOENT / non-zero exit) → direct-edit fallback. Injected
   * for tests; defaults to a real execFileSync of the `claude` binary.
   */
  execClaudeMcpAdd?: (entry: SidecarEntry) => void;
  log?: (line: string) => void;
}

function defaultExecClaudeMcpAdd(entry: SidecarEntry): void {
  execFileSync(
    'claude',
    ['mcp', 'add', '--scope', 'user', SIDECAR_SERVER_NAME, entry.command, ...entry.args],
    { timeout: 15_000, stdio: 'ignore' }
  );
}

function entryMatches(existing: unknown, desired: SidecarEntry): boolean {
  if (!existing || typeof existing !== 'object') return false;
  const e = existing as { command?: unknown; args?: unknown };
  return (
    e.command === desired.command &&
    Array.isArray(e.args) &&
    e.args.length === desired.args.length &&
    e.args.every((a, i) => a === desired.args[i])
  );
}

export function ensureSidecarRegistration(options: EnsureSidecarOptions = {}): EnsureSidecarResult {
  const claudeJsonPath = options.claudeJsonPath ?? defaultClaudeJsonPath();
  const entry =
    options.entry ??
    desiredSidecarEntry(process.execPath, process.argv[1] ?? '', options.bridgePath);
  const execAdd = options.execClaudeMcpAdd ?? defaultExecClaudeMcpAdd;
  const log = options.log ?? (() => {});

  let config: Record<string, unknown> = {};
  let fileExists = true;
  try {
    const raw = fs.readFileSync(claudeJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'failed', detail: '~/.claude.json is not a JSON object — left untouched' };
    }
    config = parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      fileExists = false;
    } else {
      return {
        status: 'failed',
        detail: `~/.claude.json unreadable/unparseable — left untouched (${
          err instanceof Error ? err.message : String(err)
        })`,
      };
    }
  }

  const servers =
    config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
      ? (config.mcpServers as Record<string, unknown>)
      : {};
  if (entryMatches(servers[SIDECAR_SERVER_NAME], entry)) {
    return { status: 'unchanged' };
  }

  // Preferred: the CLI's own writer (no race with its state file).
  try {
    execAdd(entry);
    log(`[mcp] sidecar registered via \`claude mcp add\` (user scope)`);
    return { status: 'registered' };
  } catch {
    // claude binary unavailable — direct atomic edit (accepted race; self-heals
    // on the next `portable start`).
  }

  try {
    const next = {
      ...config,
      mcpServers: {
        ...servers,
        [SIDECAR_SERVER_NAME]: { command: entry.command, args: entry.args },
      },
    };
    fs.mkdirSync(path.dirname(claudeJsonPath), { recursive: true });
    const tmp = `${claudeJsonPath}.portable-tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, claudeJsonPath);
    log(
      `[mcp] sidecar registered by direct edit of ${claudeJsonPath}${fileExists ? '' : ' (created)'}`
    );
    return { status: 'registered' };
  } catch (err) {
    return {
      status: 'failed',
      detail: `could not register the sidecar (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}
