/**
 * PairingState unit tests (connected-aware CLI marker).
 *
 * Covers:
 *  - read() on a missing/corrupt file → {} (never throws)
 *  - hasEverConnected() flips false → true on the first markConnected
 *  - markConnected sets firstConnectedAt once, advances lastConnectedAt + count
 *  - throttleMs skips churn after the first write, but the FIRST write always lands
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { PairingStateStore } from '../src/secrets/PairingState.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-pairing-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('PairingStateStore.read', () => {
  it('returns {} when the marker file is missing', () => {
    const store = new PairingStateStore({ dataDir: tmpDir });
    expect(store.read()).toEqual({});
    expect(store.hasEverConnected()).toBe(false);
  });

  it('returns {} on a corrupt marker file (never throws)', () => {
    const store = new PairingStateStore({ dataDir: tmpDir });
    fs.writeFileSync(store.filePath, 'not json {{{');
    expect(store.read()).toEqual({});
    expect(store.hasEverConnected()).toBe(false);
  });
});

describe('PairingStateStore.markConnected', () => {
  it('stamps firstConnectedAt + lastConnectedAt + count on the first connection', () => {
    const store = new PairingStateStore({ dataDir: tmpDir });
    const now = new Date('2026-06-27T10:00:00.000Z');

    const state = store.markConnected({ now });

    expect(state.firstConnectedAt).toBe(now.toISOString());
    expect(state.lastConnectedAt).toBe(now.toISOString());
    expect(state.connectionCount).toBe(1);
    // Persisted + visible to a fresh reader (the cross-process hand-off).
    expect(new PairingStateStore({ dataDir: tmpDir }).hasEverConnected()).toBe(true);
  });

  it('keeps firstConnectedAt but advances lastConnectedAt + count on later connections', () => {
    const store = new PairingStateStore({ dataDir: tmpDir });
    const first = new Date('2026-06-27T10:00:00.000Z');
    const later = new Date('2026-06-27T12:00:00.000Z');

    store.markConnected({ now: first });
    const state = store.markConnected({ now: later });

    expect(state.firstConnectedAt).toBe(first.toISOString());
    expect(state.lastConnectedAt).toBe(later.toISOString());
    expect(state.connectionCount).toBe(2);
  });

  it('throttles churn: a quick reconnect within throttleMs does not rewrite', () => {
    const store = new PairingStateStore({ dataDir: tmpDir });
    const t0 = new Date('2026-06-27T10:00:00.000Z');
    const t1 = new Date('2026-06-27T10:00:30.000Z'); // +30s, inside the 60s window

    const after1 = store.markConnected({ now: t0, throttleMs: 60_000 });
    const after2 = store.markConnected({ now: t1, throttleMs: 60_000 });

    // Unchanged — the throttled call returned the existing state, no count bump.
    expect(after2.connectionCount).toBe(1);
    expect(after2.lastConnectedAt).toBe(after1.lastConnectedAt);
  });

  it('the FIRST connection always writes even with throttleMs set', () => {
    const store = new PairingStateStore({ dataDir: tmpDir });
    const state = store.markConnected({ now: new Date(), throttleMs: 60_000 });
    expect(state.connectionCount).toBe(1);
    expect(store.hasEverConnected()).toBe(true);
  });

  it('writes again once throttleMs has elapsed', () => {
    const store = new PairingStateStore({ dataDir: tmpDir });
    const t0 = new Date('2026-06-27T10:00:00.000Z');
    const t2 = new Date('2026-06-27T10:02:00.000Z'); // +2m, past the 60s window

    store.markConnected({ now: t0, throttleMs: 60_000 });
    const state = store.markConnected({ now: t2, throttleMs: 60_000 });

    expect(state.connectionCount).toBe(2);
    expect(state.lastConnectedAt).toBe(t2.toISOString());
  });
});
