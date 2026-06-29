/**
 * PairingState — a tiny, durable "has this PC ever been connected?" marker.
 *
 * The launcher (`portable start`) and the api are SEPARATE processes that share
 * only `DATA_DIR` (see {@link resolveDataDir}). The api is the one that observes a
 * real device connecting (an authenticated Socket.IO handshake); the launcher is
 * the one that renders the terminal UI and needs to know — at boot — whether to
 * show the pairing QR (never connected) or the steady-state "connected" menu
 * (already connected). This marker is the cross-process hand-off.
 *
 * It is NOT a secret (just a timestamp + a count), so unlike {@link LocalSecretStore}
 * it is stored as PLAIN JSON at `<DATA_DIR>/pairing-state.json` — no encryption, no
 * key. Every operation is best-effort: a read on a missing/corrupt file returns
 * `{}`, and a write failure is swallowed. Detection must never block boot or a
 * device connection.
 *
 *   <DATA_DIR>/pairing-state.json   { firstConnectedAt, lastConnectedAt, connectionCount }
 */
import fs from 'fs';
import path from 'path';

import { resolveDataDir } from './LocalSecretStore.js';

/** The persisted marker. All fields are optional — an empty object means "never connected". */
export interface PairingStateData {
  /** ISO timestamp of the FIRST device connection ever observed. Presence === "ever connected". */
  firstConnectedAt?: string;
  /** ISO timestamp of the MOST RECENT device connection. */
  lastConnectedAt?: string;
  /** Total authenticated device connections observed (best-effort, throttled). */
  connectionCount?: number;
}

export interface PairingStateStoreOptions {
  /** Override the data directory (otherwise resolveDataDir() is used). */
  dataDir?: string;
}

export interface MarkConnectedOptions {
  /** Clock seam (tests). Defaults to `new Date()`. */
  now?: Date;
  /**
   * Skip the write when an EXISTING marker was updated within this many ms — avoids
   * disk churn on socket reconnects / multi-device. The FIRST connection always
   * writes (so detection flips immediately). 0/undefined === always write.
   */
  throttleMs?: number;
}

const FILE_NAME = 'pairing-state.json';

/**
 * Reads/writes the `<DATA_DIR>/pairing-state.json` marker. Construction is cheap
 * and side-effect-free (no fs touched until {@link read}/{@link markConnected}).
 */
export class PairingStateStore {
  readonly filePath: string;
  private readonly dataDir: string;

  constructor(options: PairingStateStoreOptions = {}) {
    this.dataDir = resolveDataDir(options.dataDir);
    this.filePath = path.join(this.dataDir, FILE_NAME);
  }

  /** Read the marker. Never throws — a missing or corrupt file yields `{}`. */
  read(): PairingStateData {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as PairingStateData;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** True once any device has ever connected (i.e. `firstConnectedAt` is set). */
  hasEverConnected(): boolean {
    return typeof this.read().firstConnectedAt === 'string';
  }

  /**
   * Record an authenticated device connection (producer = the api). Sets
   * `firstConnectedAt` once, always advances `lastConnectedAt` + the count, and
   * persists best-effort (a write failure is swallowed — never blocks a connect).
   * Honors {@link MarkConnectedOptions.throttleMs} to avoid churn on reconnects.
   * Returns the resulting (or unchanged, if throttled) state.
   */
  markConnected(options: MarkConnectedOptions = {}): PairingStateData {
    const now = options.now ?? new Date();
    const current = this.read();

    // Throttle reconnect churn — but the FIRST connection always writes.
    if (current.firstConnectedAt && options.throttleMs && options.throttleMs > 0) {
      const last = current.lastConnectedAt ? Date.parse(current.lastConnectedAt) : 0;
      if (Number.isFinite(last) && now.getTime() - last < options.throttleMs) {
        return current;
      }
    }

    const nowIso = now.toISOString();
    const next: PairingStateData = {
      firstConnectedAt: current.firstConnectedAt ?? nowIso,
      lastConnectedAt: nowIso,
      connectionCount: (current.connectionCount ?? 0) + 1,
    };
    this.write(next);
    return next;
  }

  /** Best-effort atomic write — swallows any fs error. */
  private write(state: PairingStateData): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Detection is best-effort — never block on persistence.
    }
  }
}
