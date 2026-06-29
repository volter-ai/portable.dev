/**
 * Recovery-loop guard + ConnectionFailed UX.
 *
 * Two layers:
 *  1. The framework-free `RecoveryLoopGuard` sliding-window math (manual clock).
 *  2. The `useSandboxDeathHandler` + the REAL `SandboxSessionBoundary` (RNTL):
 *     a 4th death signal inside a 5-minute window is BLOCKED and the boundary
 *     REPLACES the subtree with the native ConnectionFailed screen; tapping
 *     "Try again" RESETS the counter and re-provisions (NO gateway pre-check —
 *     the gateway-authoritative provisioning pass IS the status check);
 *     the screen shows "sandbox down" vs "you're offline" copy per the
 *     (injected) NetInfo state; death signals while a re-provision is already
 *     in flight are muted (no guard slots); and a death through the DEFAULT
 *     re-provision action clears the sandbox URL and bumps the session epoch,
 *     remounting the boundary's children.
 *
 * "Mocked timers" = an injected manual clock on the guard (NOT jest fake
 * timers), so the async re-provision promises flush with real `await`.
 */

// ConnectionFailedScreen now consumes useAppTheme → themeStore → MMKV.
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string) => store.set(k, String(v)),
    getString: (k: string) => store.get(k),
    remove: (k: string) => store.delete(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

// The health barrel transitively imports secureAuthStore / relayUrlStore /
// authStore, which load expo-secure-store at module scope. Mock it (in-memory
// Map) so the import graph resolves without the native keychain.
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    getItemAsync: jest.fn(async (k: string) => (store.has(k) ? (store.get(k) as string) : null)),
    deleteItemAsync: jest.fn(async (k: string) => {
      store.delete(k);
    }),
  };
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';
import { Text } from 'react-native';

import {
  RecoveryLoopGuard,
  RECOVERY_WINDOW_MS,
  useConnectionFailedStore,
  useSandboxSessionStore,
} from '../src/features/health';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import {
  SandboxSessionBoundary,
  useSandboxDeath,
} from '../src/features/shell/SandboxSessionBoundary';
import { useAuthStore } from '../src/features/state/authStore';

import type { NetInfoLike } from '../src/features/socket/lifecycle';

interface SecureStoreMock {
  __store: Map<string, string>;
}
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

// --- A manual clock the guard reads, so the 5-minute window is deterministic. ---
function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// --- An injectable NetInfo controller (default: no event = connected/unknown). ---
function createNetInfoController() {
  let listener: ((s: { isConnected: boolean | null }) => void) | null = null;
  const netInfo: NetInfoLike = {
    addEventListener(l) {
      listener = l;
      return () => {
        listener = null;
      };
    },
  };
  return {
    netInfo,
    emit: (isConnected: boolean | null) =>
      act(() => {
        listener?.({ isConnected });
      }),
  };
}

/**
 * Probe child: captures the boundary's context death handler and counts its
 * own mounts (an epoch bump remounts it).
 */
function Probe({
  spy,
  mounts,
}: {
  spy: { onDeath: (() => void) | null };
  mounts: { count: number };
}) {
  spy.onDeath = useSandboxDeath();
  useEffect(() => {
    mounts.count += 1;
    // Count mounts only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <Text testID="app">app</Text>;
}

function renderBoundary(deps: {
  guard?: RecoveryLoopGuard;
  netInfo?: NetInfoLike;
  requestReprovision?: () => Promise<void>;
}) {
  const spy: { onDeath: (() => void) | null } = { onDeath: null };
  const mounts = { count: 0 };
  const utils = render(
    <SandboxSessionBoundary {...deps}>
      <Probe spy={spy} mounts={mounts} />
    </SandboxSessionBoundary>
  );
  const die = () =>
    act(() => {
      spy.onDeath?.();
    });
  return { spy, mounts, die, utils };
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  secureStore.__store.clear();
  act(() => {
    useConnectionFailedStore.setState({ visible: false, reason: 'pc-down' });
    useSandboxSessionStore.getState().reset();
  });
});

describe('RecoveryLoopGuard (sliding window)', () => {
  it('allows 3 recoveries then blocks the 4th in the same window', () => {
    const clock = makeClock();
    const guard = new RecoveryLoopGuard({ now: clock.now });

    expect(guard.tryConsume()).toBe(true); // 1
    clock.advance(5_000);
    expect(guard.tryConsume()).toBe(true); // 2
    clock.advance(5_000);
    expect(guard.tryConsume()).toBe(true); // 3
    expect(guard.recoveriesInWindow()).toBe(3);
    expect(guard.canRecover()).toBe(false);
    expect(guard.tryConsume()).toBe(false); // 4 — blocked
  });

  it('allows recovery again once the oldest attempt falls out of the window', () => {
    const clock = makeClock();
    const guard = new RecoveryLoopGuard({ now: clock.now });
    guard.tryConsume();
    guard.tryConsume();
    guard.tryConsume();
    expect(guard.canRecover()).toBe(false);

    // Slide past the window so all three expire.
    clock.advance(RECOVERY_WINDOW_MS + 1);
    expect(guard.recoveriesInWindow()).toBe(0);
    expect(guard.tryConsume()).toBe(true);
  });

  it('reset() clears the counter immediately (the manual "Try again")', () => {
    const clock = makeClock();
    const guard = new RecoveryLoopGuard({ now: clock.now });
    guard.tryConsume();
    guard.tryConsume();
    guard.tryConsume();
    expect(guard.canRecover()).toBe(false);
    guard.reset();
    expect(guard.recoveriesInWindow()).toBe(0);
    expect(guard.canRecover()).toBe(true);
  });
});

describe('useSandboxDeathHandler + SandboxSessionBoundary', () => {
  it('blocks the 4th death in the window: the boundary replaces the subtree with the ConnectionFailed screen', async () => {
    const clock = makeClock();
    const guard = new RecoveryLoopGuard({ now: clock.now });
    const requestReprovision = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const net = createNetInfoController();

    const { die } = renderBoundary({ guard, netInfo: net.netInfo, requestReprovision });

    // 3 allowed deaths — each re-provisions; the app stays mounted.
    for (let i = 0; i < 3; i++) {
      die();
      clock.advance(5_000);
    }
    await flush();
    expect(requestReprovision).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('app')).toBeTruthy();

    // 4th within the window → blocked → the subtree is REPLACED by the screen
    // (the dead socket would unmount with it).
    die();
    expect(requestReprovision).toHaveBeenCalledTimes(3); // not called again
    expect(screen.getByTestId('connection-failed-screen')).toBeTruthy();
    expect(screen.queryByTestId('app')).toBeNull();
  });

  it('shows "sandbox down" copy when the device is connected', async () => {
    const guard = new RecoveryLoopGuard({ now: makeClock().now });
    const requestReprovision = jest.fn().mockResolvedValue(undefined);
    const net = createNetInfoController();

    const { die } = renderBoundary({ guard, netInfo: net.netInfo, requestReprovision });

    // Exhaust: 3 consume the slots, the 4th trips the screen (default = connected).
    for (let i = 0; i < 4; i++) die();

    expect(screen.getByTestId('connection-failed-title').props.children).toBe(
      "Can't reach your PC"
    );
  });

  it('shows "you\'re offline" copy when NetInfo reports offline', async () => {
    const guard = new RecoveryLoopGuard({ now: makeClock().now });
    const requestReprovision = jest.fn().mockResolvedValue(undefined);
    const net = createNetInfoController();

    const { die } = renderBoundary({ guard, netInfo: net.netInfo, requestReprovision });

    // Device goes offline BEFORE the window is exhausted.
    await net.emit(false);

    for (let i = 0; i < 4; i++) die();

    expect(screen.getByTestId('connection-failed-title').props.children).toBe("You're offline");
  });

  it('"Try again" resets the counter, dismisses the screen, and re-provisions (NO gateway pre-check)', async () => {
    const clock = makeClock();
    const guard = new RecoveryLoopGuard({ now: clock.now });
    const requestReprovision = jest.fn().mockResolvedValue(undefined);
    const net = createNetInfoController();

    const { die } = renderBoundary({ guard, netInfo: net.netInfo, requestReprovision });

    // Exhaust the window (3 re-provisions + a blocked 4th → screen).
    for (let i = 0; i < 4; i++) die();
    expect(requestReprovision).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('connection-failed-screen')).toBeTruthy();

    // Tap "Try again": counter reset → re-provision (the gateway-authoritative
    // provisioning pass IS the status check — there is no pre-query).
    fireEvent.press(screen.getByTestId('connection-failed-try-again'));
    await flush();

    expect(requestReprovision).toHaveBeenCalledTimes(4);
    expect(guard.recoveriesInWindow()).toBe(0); // window re-armed
    await waitFor(() => expect(screen.queryByTestId('connection-failed-screen')).toBeNull());
    expect(screen.getByTestId('app')).toBeTruthy();
  });

  it('death signals while a re-provision is in flight are muted (no guard slots, single-flight)', async () => {
    const guard = new RecoveryLoopGuard({ now: makeClock().now });
    const requestReprovision = jest.fn().mockResolvedValue(undefined);
    const net = createNetInfoController();

    const { die } = renderBoundary({ guard, netInfo: net.netInfo, requestReprovision });

    // A re-provision is in flight (the session store's single-flight flag).
    act(() => {
      useSandboxSessionStore.setState({ reprovisioning: true });
    });

    // The monitor/coordinator keep firing death signals while the dead URL
    // fails — all muted: no slots consumed, no re-provision calls.
    for (let i = 0; i < 5; i++) die();
    expect(requestReprovision).not.toHaveBeenCalled();
    expect(guard.recoveriesInWindow()).toBe(0);
    expect(screen.getByTestId('app')).toBeTruthy();

    // Provisioning handed the tree back → death handling re-arms.
    act(() => {
      useSandboxSessionStore.getState().markSessionLive();
    });
    die();
    await flush();
    expect(requestReprovision).toHaveBeenCalledTimes(1);
    expect(guard.recoveriesInWindow()).toBe(1);
  });

  it('a death through the DEFAULT action clears the sandbox URL and remounts the subtree (epoch bump)', async () => {
    // No injected requestReprovision — the real session-store action runs:
    // clear the persisted URL (+ the authStore mirror) and bump the epoch.
    const guard = new RecoveryLoopGuard({ now: makeClock().now });
    const net = createNetInfoController();
    secureStore.__store.set(RELAY_URL_KEY, 'https://dead.example.modal.host');
    act(() => {
      useAuthStore.getState().setSandboxUrl('https://dead.example.modal.host');
    });

    const { die, mounts } = renderBoundary({ guard, netInfo: net.netInfo });
    expect(mounts.count).toBe(1);

    die();
    await flush();

    // The dead URL is GONE (SecureStore + mirror) and the keyed subtree
    // remounted — on the real shell this re-enters the provisioning gate.
    expect(secureStore.__store.has(RELAY_URL_KEY)).toBe(false);
    expect(useAuthStore.getState().sandboxUrl).toBeNull();
    expect(useSandboxSessionStore.getState().epoch).toBe(1);
    expect(useSandboxSessionStore.getState().reprovisioning).toBe(true);
    expect(mounts.count).toBe(2);
  });
});
