/**
 * NotifyRunningInstance tests — the best-effort loopback nudge that tells a
 * RUNNING `portable` to rescan repos after `portable link`/`unlink`, so the
 * change shows up without a restart. The store points at a temp dir and `fetch`
 * is injected; no real network / no real ~/.portable write.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { LocalSecretStore } from '@vgit2/shared/secrets';

import { notifyRunningInstanceOfRepoChange } from '../src/NotifyRunningInstance.js';

let tmp: string;
let store: LocalSecretStore;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portable-notify-test-')));
  store = new LocalSecretStore({ dataDir: tmp });
  env = {
    JWT_SECRET: 'a'.repeat(64),
    PORTABLE_PC_ID: 'pc_test123',
    VGIT_PORT: '4321',
  } as NodeJS.ProcessEnv;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('notifyRunningInstanceOfRepoChange', () => {
  it('POSTs an authed rescan to the loopback api and returns true on 2xx', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return { ok: true } as Response;
    }) as unknown as typeof fetch;

    const ok = await notifyRunningInstanceOfRepoChange({ env, store, fetchImpl });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:4321/api/repos/rescan');
    expect(calls[0].init.method).toBe('POST');
    const auth = (calls[0].init.headers as Record<string, string>).Authorization;
    expect(auth).toMatch(/^Bearer .+\..+\..+$/); // a 3-part JWT
  });

  it('returns false when the api is not reachable (fetch throws)', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    }) as unknown as typeof fetch;

    const ok = await notifyRunningInstanceOfRepoChange({ env, store, fetchImpl });
    expect(ok).toBe(false);
  });

  it('returns false on a non-2xx response', async () => {
    const fetchImpl = (async () => ({ ok: false }) as Response) as unknown as typeof fetch;
    const ok = await notifyRunningInstanceOfRepoChange({ env, store, fetchImpl });
    expect(ok).toBe(false);
  });
});
