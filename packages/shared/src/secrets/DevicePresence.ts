/**
 * DevicePresence — a tiny, LIVE "which mobile devices are connected right now?"
 * file, written by the api and read by the launcher to drive the connected menu's
 * right-hand status column.
 *
 * Like {@link PairingStateStore} this is the cross-process hand-off between the two
 * separate processes: the api owns the Socket.IO connections (the ground truth for
 * "a phone is connected"), the launcher renders the terminal UI. The api rewrites
 * this file on every connect/disconnect; the launcher polls it (~1.5s) and updates
 * the box. NOT a secret — plain JSON at `<DATA_DIR>/device-presence.json`, every op
 * best-effort (missing/corrupt → empty), never blocks a connection or the UI.
 */
import fs from 'fs';
import path from 'path';

import { resolveDataDir } from './LocalSecretStore.js';

/** One connected mobile device (a live Socket.IO connection). */
export interface DeviceInfo {
  /** The socket id (ephemeral) — used to dedupe/key, not shown verbatim. */
  id: string;
  /** A human-readable device make/model the app self-reports (e.g. "Apple iPhone 15 Pro"). */
  name?: string;
  /** The client app version from the handshake, if it sent one. */
  appVersion?: string;
  /** ISO timestamp when this connection was established. */
  connectedAt: string;
}

/** The persisted live-presence snapshot. */
export interface DevicePresenceData {
  devices: DeviceInfo[];
  /** ISO timestamp of the last write. */
  updatedAt?: string;
}

export interface DevicePresenceStoreOptions {
  dataDir?: string;
}

const FILE_NAME = 'device-presence.json';

/** Reads/writes `<DATA_DIR>/device-presence.json`. Side-effect-free to construct. */
export class DevicePresenceStore {
  readonly filePath: string;
  private readonly dataDir: string;

  constructor(options: DevicePresenceStoreOptions = {}) {
    this.dataDir = resolveDataDir(options.dataDir);
    this.filePath = path.join(this.dataDir, FILE_NAME);
  }

  /** Read the live presence. Never throws — missing/corrupt yields `{ devices: [] }`. */
  read(): DevicePresenceData {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as DevicePresenceData;
      if (parsed && Array.isArray(parsed.devices)) return parsed;
      return { devices: [] };
    } catch {
      return { devices: [] };
    }
  }

  /** Rewrite the full set of currently-connected devices. Best-effort (swallows fs errors). */
  write(devices: DeviceInfo[], now: Date = new Date()): void {
    const data: DevicePresenceData = { devices, updatedAt: now.toISOString() };
    try {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Presence is best-effort — never block on persistence.
    }
  }
}
