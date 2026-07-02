/**
 * InternalBridge — the loopback rendezvous file between the launcher-registered
 * Claude Code integrations (`portable hook-relay`, `portable mcp-sidecar`) and
 * the api child (rev12, PRD D53/D58).
 *
 * `portable start` writes `<DATA_DIR>/internal-bridge.json` on every boot:
 *   { port, secret, startedAt }
 * - `port`   — the api's loopback port (VGIT_PORT) the relays POST to.
 * - `secret` — a per-boot random secret. The SAME value is passed to the api
 *   child as `PORTABLE_HOOK_SECRET`, and `/api/internal/*` requires it in the
 *   `x-portable-internal-secret` header. This is the REAL gate, not
 *   defense-in-depth: the cloudflared tunnel process proxies public traffic to
 *   the same loopback port, so a loopback remote address does NOT prove local
 *   origin — only the secret (which never leaves this PC) does.
 *
 * The relays are spawned by the user's OWN `claude` sessions (hooks / MCP), so
 * they can't inherit env from the launcher — the file is how they discover the
 * endpoint. Everything here is best-effort and fail-silent: a missing/corrupt
 * bridge file just means "Portable isn't running", and the relays exit quietly.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { resolveDataDir } from '@vgit2/shared/secrets';

/** Bridge filename under DATA_DIR. */
export const INTERNAL_BRIDGE_FILE = 'internal-bridge.json';

export interface InternalBridge {
  /** The api's loopback port (VGIT_PORT). */
  port: number;
  /** Per-boot shared secret — also the api child's PORTABLE_HOOK_SECRET. */
  secret: string;
  /** ISO timestamp of the boot that wrote this file. */
  startedAt: string;
}

export function internalBridgePath(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, INTERNAL_BRIDGE_FILE);
}

/** Mint the per-boot internal secret (hex, 256-bit). */
export function mintInternalSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Write the bridge file (0600, atomic tmp+rename). Throws on FS errors — the
 * caller (launcher boot) decides whether that is fatal (it is not: hooks and
 * the sidecar simply stay dormant this boot).
 */
export function writeInternalBridge(
  bridge: InternalBridge,
  dataDir: string = resolveDataDir()
): string {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const target = internalBridgePath(dataDir);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(bridge, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return target;
}

/**
 * Read + validate the bridge file at an EXPLICIT path. Returns null on ANY
 * problem (missing file, bad JSON, missing fields). This is the path the
 * claude-spawned relays use (the launcher embeds the ABSOLUTE bridge path into
 * the hook command + sidecar args) so they never have to re-resolve `DATA_DIR`
 * from a project `.env` / `XDG_DATA_HOME` that may differ from the launcher's.
 */
export function readBridgeFromFile(filePath: string): InternalBridge | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<InternalBridge>;
    if (
      typeof parsed.port !== 'number' ||
      !Number.isFinite(parsed.port) ||
      parsed.port <= 0 ||
      typeof parsed.secret !== 'string' ||
      parsed.secret.length === 0
    ) {
      return null;
    }
    return {
      port: parsed.port,
      secret: parsed.secret,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    };
  } catch {
    return null;
  }
}

/**
 * Read + validate the bridge file from a DATA_DIR (back-compat default when no
 * explicit path was passed — e.g. a stale hook command installed before the
 * absolute-path fix). Prefer {@link readBridgeFromFile} with the embedded path.
 */
export function readInternalBridge(dataDir: string = resolveDataDir()): InternalBridge | null {
  try {
    const raw = fs.readFileSync(internalBridgePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<InternalBridge>;
    if (
      typeof parsed.port !== 'number' ||
      !Number.isFinite(parsed.port) ||
      parsed.port <= 0 ||
      typeof parsed.secret !== 'string' ||
      parsed.secret.length === 0
    ) {
      return null;
    }
    return {
      port: parsed.port,
      secret: parsed.secret,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    };
  } catch {
    return null;
  }
}
