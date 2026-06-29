/**
 * TerminalUi tests (single-instance Ink, booting → ready → connected).
 *
 * The invariant: exactly ONE Ink `render()` for the whole session; every
 * transition (setStatus / ready / showConnected) is a `rerender` of the SAME
 * instance — never a second `render()`. We inject the Ink render seam so no real
 * TTY is touched, and assert render-vs-rerender counts.
 */
import { describe, expect, it } from 'bun:test';

import type { Instance } from 'ink';

import { formatRelativeTime, startLauncherUi, startStaticUi } from '../src/TerminalUi.js';

/** A fake Ink instance that records render/rerender/unmount calls. */
function fakeInk() {
  const calls = { render: 0, rerender: 0, unmount: 0 };
  const renderImpl = (() => {
    calls.render++;
    return {
      rerender: () => {
        calls.rerender++;
      },
      unmount: () => {
        calls.unmount++;
      },
    } as unknown as Instance;
  }) as typeof import('ink').render;
  return { calls, renderImpl };
}

const baseOpts = {
  endpoint: 'https://app.portable.dev/t/pc_ui',
  pcId: 'pc_ui',
  label: 'my-pc',
  onQuit: () => {},
};

describe('formatRelativeTime', () => {
  const now = new Date('2026-06-27T12:00:00.000Z');

  it('handles unknown / minutes / hours / days', () => {
    expect(formatRelativeTime(undefined, now)).toBe('unknown');
    expect(formatRelativeTime('not-a-date', now)).toBe('unknown');
    expect(formatRelativeTime('2026-06-27T11:59:30.000Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-06-27T11:30:00.000Z', now)).toBe('30m ago');
    expect(formatRelativeTime('2026-06-27T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-06-25T12:00:00.000Z', now)).toBe('2d ago');
  });
});

describe('startLauncherUi', () => {
  it('renders ONCE on mount; setStatus / ready / showConnected each rerender IN PLACE', async () => {
    const { calls, renderImpl } = fakeInk();

    const handle = await startLauncherUi({
      ...baseOpts,
      initialPhase: 'booting',
      status: 'Starting…',
      renderImpl,
    });

    expect(calls.render).toBe(1);
    expect(calls.rerender).toBe(0);

    handle.setStatus('Waiting for the api…'); // booting status update
    expect(calls.rerender).toBe(1);

    handle.ready({ qr: 'QR', phase: 'pairing', loopbackUrl: 'http://localhost:5555/' });
    expect(calls.rerender).toBe(2);

    handle.showConnected({ lastConnectedAt: '2026-06-27T10:00:00.000Z' });
    expect(calls.rerender).toBe(3);

    handle.setDevices([{ id: 's1', connectedAt: 'x' }]); // live device column update
    expect(calls.rerender).toBe(4);

    handle.setChats([{ id: 'c1', title: 'Fix bug' }]); // live chats column update
    expect(calls.rerender).toBe(5);

    // Still exactly ONE mount the whole time.
    expect(calls.render).toBe(1);

    handle.stop();
    expect(calls.unmount).toBe(1);
    // Idempotent + post-stop calls are no-ops (rerender count frozen at 4).
    handle.stop();
    handle.setStatus('x');
    handle.ready({ qr: 'QR', phase: 'pairing' });
    handle.setDevices([]);
    handle.setChats([]);
    expect(calls.rerender).toBe(5);
  });

  it('can mount directly into a steady phase (tests)', async () => {
    const { calls, renderImpl } = fakeInk();
    await startLauncherUi({ ...baseOpts, initialPhase: 'connected', qr: 'QR', renderImpl });
    expect(calls.render).toBe(1);
  });

  it('swallows a rerender error (non-TTY / torn down)', async () => {
    const renderImpl = (() =>
      ({
        rerender: () => {
          throw new Error('not a TTY');
        },
        unmount: () => {},
      }) as unknown as Instance) as typeof import('ink').render;

    const handle = await startLauncherUi({ ...baseOpts, initialPhase: 'booting', renderImpl });
    expect(() => handle.setStatus('x')).not.toThrow();
    expect(() => handle.ready({ qr: 'QR', phase: 'pairing' })).not.toThrow();
  });
});

describe('startStaticUi (--debug)', () => {
  it('logs each status line; ready() prints the QR block; showConnected/stop are safe', async () => {
    const out: string[] = [];
    const handle = await startStaticUi({
      ...baseOpts,
      initialPhase: 'booting',
      status: 'Starting…',
      loopbackUrl: 'http://localhost:5555/',
      log: (line) => out.push(line),
    });

    handle.setStatus('Opening a secure tunnel…');
    handle.ready({ qr: 'QR-PAYLOAD', phase: 'pairing', loopbackUrl: 'http://localhost:5555/' });

    const joined = out.join('\n');
    expect(joined).toContain('Starting…');
    expect(joined).toContain('Opening a secure tunnel…');
    expect(joined).toContain('QR-PAYLOAD');
    expect(joined).toContain('Relay endpoint: https://app.portable.dev/t/pc_ui');
    expect(joined).toContain('streaming api logs below');

    expect(() => {
      handle.showConnected({ lastConnectedAt: 'x' });
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });
});
