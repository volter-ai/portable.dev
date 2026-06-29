/**
 * DevicePresence unit tests — the live "which mobile devices are connected" file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DevicePresenceStore } from '../src/secrets/DevicePresence.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-presence-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('DevicePresenceStore', () => {
  it('reads {devices:[]} when the file is missing', () => {
    expect(new DevicePresenceStore({ dataDir: tmpDir }).read()).toEqual({ devices: [] });
  });

  it('reads {devices:[]} on a corrupt file (never throws)', () => {
    const store = new DevicePresenceStore({ dataDir: tmpDir });
    fs.writeFileSync(store.filePath, 'not json');
    expect(store.read().devices).toEqual([]);
  });

  it('round-trips the connected device list + stamps updatedAt', () => {
    const store = new DevicePresenceStore({ dataDir: tmpDir });
    const now = new Date('2026-06-27T10:00:00.000Z');
    store.write(
      [
        { id: 'sock1', appVersion: '1.0.27', connectedAt: '2026-06-27T09:58:00.000Z' },
        { id: 'sock2', connectedAt: '2026-06-27T09:59:00.000Z' },
      ],
      now
    );
    const data = store.read();
    expect(data.updatedAt).toBe(now.toISOString());
    expect(data.devices).toHaveLength(2);
    expect(data.devices[0]).toMatchObject({ id: 'sock1', appVersion: '1.0.27' });
  });

  it('overwrites with the full current set (e.g. back to empty on disconnect)', () => {
    const store = new DevicePresenceStore({ dataDir: tmpDir });
    store.write([{ id: 'sock1', connectedAt: 'x' }]);
    store.write([]);
    expect(store.read().devices).toEqual([]);
  });
});
