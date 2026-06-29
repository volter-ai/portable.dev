/**
 * LocalSecretStore unit tests.
 *
 * Covers the acceptance criteria:
 *  - encrypt -> decrypt round-trip
 *  - wrong key fails (GCM auth tag)
 *  - restricted file/dir permissions (0700 dir, 0600 key + store)
 *  - get/set/delete/list behavior over the on-disk store
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  LocalSecretStore,
  decryptValue,
  encryptValue,
  resolveDataDir,
} from '../src/secrets/LocalSecretStore.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-secrets-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('encryptValue / decryptValue', () => {
  const key = crypto.randomBytes(32);

  it('round-trips a plaintext string', () => {
    const envelope = encryptValue('hunter2', key);
    expect(envelope.startsWith('v1:')).toBe(true);
    expect(decryptValue(envelope, key)).toBe('hunter2');
  });

  it('produces a different IV/ciphertext each call (non-deterministic)', () => {
    expect(encryptValue('same', key)).not.toBe(encryptValue('same', key));
  });

  it('fails to decrypt with the wrong key', () => {
    const envelope = encryptValue('top-secret', key);
    const wrongKey = crypto.randomBytes(32);
    expect(() => decryptValue(envelope, wrongKey)).toThrow();
  });

  it('fails to decrypt a tampered envelope', () => {
    const envelope = encryptValue('top-secret', key);
    const parts = envelope.split(':');
    // Flip a byte in the ciphertext segment.
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] ^= 0xff;
    parts[3] = ct.toString('base64');
    expect(() => decryptValue(parts.join(':'), key)).toThrow();
  });

  it('rejects a non-32-byte key', () => {
    expect(() => encryptValue('x', crypto.randomBytes(16))).toThrow();
  });
});

describe('resolveDataDir', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('honors an explicit override', () => {
    expect(resolveDataDir('/custom/dir')).toBe('/custom/dir');
  });

  it('prefers PORTABLE_DATA_DIR over XDG_DATA_HOME', () => {
    process.env.PORTABLE_DATA_DIR = '/p';
    process.env.XDG_DATA_HOME = '/xdg';
    expect(resolveDataDir()).toBe('/p');
  });

  it('uses $XDG_DATA_HOME/portable when set', () => {
    delete process.env.PORTABLE_DATA_DIR;
    delete process.env.DATA_DIR;
    process.env.XDG_DATA_HOME = '/xdg';
    expect(resolveDataDir()).toBe(path.join('/xdg', 'portable'));
  });

  it('defaults to ~/.portable', () => {
    delete process.env.PORTABLE_DATA_DIR;
    delete process.env.DATA_DIR;
    delete process.env.XDG_DATA_HOME;
    expect(resolveDataDir()).toBe(path.join(os.homedir(), '.portable'));
  });
});

describe('LocalSecretStore', () => {
  it('round-trips set -> get', () => {
    const store = new LocalSecretStore({ dataDir: tmpDir });
    store.set('anthropic_api_key', 'sk-ant-123');
    expect(store.get('anthropic_api_key')).toBe('sk-ant-123');
  });

  it('returns undefined for an unknown secret', () => {
    const store = new LocalSecretStore({ dataDir: tmpDir });
    expect(store.get('nope')).toBeUndefined();
  });

  it('persists across instances (key reused, not regenerated)', () => {
    const a = new LocalSecretStore({ dataDir: tmpDir });
    a.set('device_token', 'dt-abc');
    const b = new LocalSecretStore({ dataDir: tmpDir });
    expect(b.get('device_token')).toBe('dt-abc');
  });

  it('overwrites an existing value', () => {
    const store = new LocalSecretStore({ dataDir: tmpDir });
    store.set('k', 'v1');
    store.set('k', 'v2');
    expect(store.get('k')).toBe('v2');
  });

  it('supports has / delete / list', () => {
    const store = new LocalSecretStore({ dataDir: tmpDir });
    store.set('a', '1');
    store.set('b', '2');
    expect(store.has('a')).toBe(true);
    expect(store.list().sort()).toEqual(['a', 'b']);
    expect(store.delete('a')).toBe(true);
    expect(store.delete('a')).toBe(false);
    expect(store.has('a')).toBe(false);
    expect(store.list()).toEqual(['b']);
  });

  it('round-trips JSON values', () => {
    const store = new LocalSecretStore({ dataDir: tmpDir });
    store.setJSON('clerk_identity', { token: 't', userId: 'u_1' });
    expect(store.getJSON('clerk_identity')).toEqual({ token: 't', userId: 'u_1' });
    expect(store.getJSON('absent')).toBeUndefined();
  });

  it('stores the value encrypted at rest (never plaintext)', () => {
    const store = new LocalSecretStore({ dataDir: tmpDir });
    store.set('secret', 'PLAINTEXT_MARKER');
    const onDisk = fs.readFileSync(path.join(tmpDir, 'secrets.json'), 'utf8');
    expect(onDisk).not.toContain('PLAINTEXT_MARKER');
  });

  it('applies restricted permissions to the dir, key, and store files', () => {
    const store = new LocalSecretStore({ dataDir: tmpDir });
    store.set('x', 'y');
    const dirMode = fs.statSync(tmpDir).mode & 0o777;
    const keyMode = fs.statSync(path.join(tmpDir, 'secret.key')).mode & 0o777;
    const storeMode = fs.statSync(path.join(tmpDir, 'secrets.json')).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(keyMode).toBe(0o600);
    expect(storeMode).toBe(0o600);
  });

  it('throws on a corrupt key file', () => {
    fs.writeFileSync(path.join(tmpDir, 'secret.key'), 'not-a-valid-hex-key', { mode: 0o600 });
    expect(() => new LocalSecretStore({ dataDir: tmpDir })).toThrow();
  });
});
