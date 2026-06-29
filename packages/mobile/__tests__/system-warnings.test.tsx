/**
 * System warnings + resume indicator.
 *
 * Drives the native Socket.IO provider with a mocked Socket.IO server and asserts:
 *
 *   1. `system:idle_warning` renders the native "Are you still there?" modal,
 *      and `system:idle_warning_cleared` dismisses it;
 *   2. `system:idle_shutdown` renders the final shutdown modal;
 *   3. `system:shutdown_warning` is IGNORED (the RN client has no pending-shutdown
 *      banner — recovery handles a dead sandbox transparently);
 *   4. none of the above trigger a `window.location.href` redirect (RN has no DOM);
 *   5. the persistent "reconnecting" banner shows while the socket is down on
 *      resume (after a first connect) and CLEARS on the next `connect` event,
 *      with no arbitrary timeout.
 */

// Hoisted above imports: route `createSocket()`'s `io()` to our mock socket.
jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});

// The socket barrel transitively imports the MMKV-backed offline queue store.
// MMKV is a native nitro module — mock it so importing the barrel
// doesn't load the JSI module.
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (key: string, value: string | number | boolean) => store.set(key, String(value)),
    getString: (key: string) => (store.has(key) ? store.get(key) : undefined),
    remove: (key: string) => store.delete(key),
    contains: (key: string) => store.has(key),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance };
});

import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { SERVER_EVENTS } from '@vgit2/shared/socket';

import { SocketProvider, useSocketStore } from '../src/features/socket';
import type { AppStateLike, NetInfoLike, AppStateStatus } from '../src/features/socket';
import { type MockSocketIoModule } from '../src/test';

/** The controller backing the single socket the mocked `io()` hands out. */
const socketMock = jest.requireMock('socket.io-client') as MockSocketIoModule;
const controller = socketMock.__controller;

/** Inert AppState mock (no transitions needed for these assertions). */
function createAppStateController(): { appState: AppStateLike; emit: (s: AppStateStatus) => void } {
  let listener: ((s: AppStateStatus) => void) | null = null;
  return {
    appState: {
      currentState: 'active',
      addEventListener: (_type, l) => {
        listener = l;
        return { remove: () => (listener = null) };
      },
    },
    emit: (s) => listener?.(s),
  };
}

/** Inert NetInfo mock. */
function createNetInfoController(): { netInfo: NetInfoLike; emit: (isConnected: boolean) => void } {
  let listener: ((s: { isConnected: boolean | null }) => void) | null = null;
  return {
    netInfo: {
      addEventListener: (l) => {
        listener = l;
        return () => (listener = null);
      },
    },
    emit: (isConnected) => listener?.({ isConnected }),
  };
}

describe('system warnings + resume indicator', () => {
  let appCtl: ReturnType<typeof createAppStateController>;
  let netCtl: ReturnType<typeof createNetInfoController>;
  /** Spy on the (web-only) redirect path to PROVE RN never navigates. */
  let hrefSetter: jest.Mock;

  async function mountProvider(): Promise<void> {
    render(
      <SocketProvider
        getAuthToken={async () => 'token-abc'}
        getRelayUrl={async () => 'https://sandbox.portable.test'}
        appState={appCtl.appState}
        netInfo={netCtl.netInfo}
      >
        <Text testID="child">app</Text>
      </SocketProvider>
    );
    // Flush the async socket-creation effect (resolves token + sandbox URL, binds handlers).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    appCtl = createAppStateController();
    netCtl = createNetInfoController();
    // Trap `window.location.href = …` to PROVE the RN code never redirects.
    hrefSetter = jest.fn();
    const g = globalThis as { window?: { location?: unknown } };
    if (!g.window) g.window = {};
    Object.defineProperty(g.window, 'location', {
      configurable: true,
      value: {
        get href() {
          return '';
        },
        set href(v: string) {
          hrefSetter(v);
        },
      },
    });
  });

  afterEach(() => {
    act(() => {
      useSocketStore.getState().reset();
    });
    controller.reset();
    const g = globalThis as { window?: { location?: unknown } };
    if (g.window) delete g.window.location;
  });

  it('renders the idle-warning modal and clears it on idle_warning_cleared', async () => {
    await mountProvider();

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.SYSTEM_IDLE_WARNING, {
        message: 'Are you still there?',
        timeRemaining: 42,
      });
    });
    expect(screen.queryByTestId('system-idle-warning-modal')).not.toBeNull();
    expect(screen.getByTestId('system-idle-warning-countdown').props.children).toBe(
      '42s remaining'
    );

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.SYSTEM_IDLE_WARNING_CLEARED);
    });
    expect(screen.queryByTestId('system-idle-warning-modal')).toBeNull();
    expect(hrefSetter).not.toHaveBeenCalled();
  });

  it('routes idle_shutdown to the re-provision/loading overlay (superseding the idle warning)', async () => {
    await mountProvider();

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.SYSTEM_IDLE_WARNING, {
        message: 'Are you still there?',
        timeRemaining: 10,
      });
    });
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.SYSTEM_IDLE_SHUTDOWN, {
        message: 'Session ending due to inactivity.',
      });
    });

    // The "are you still there?" warning is replaced by the terminal loading state
    // (the session is gone → route to re-provision/loading).
    expect(screen.queryByTestId('system-idle-warning-modal')).toBeNull();
    expect(screen.queryByTestId('system-reprovisioning')).not.toBeNull();
    expect(screen.getByTestId('system-reprovisioning-message').props.children).toBe(
      'Session ending due to inactivity.'
    );
    expect(hrefSetter).not.toHaveBeenCalled();
  });

  it('ignores system:shutdown_warning (no banner, no window.location.href redirect)', async () => {
    await mountProvider();

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.SYSTEM_SHUTDOWN_WARNING, {
        message: 'Sandbox restarting for updates',
        redirect_url: 'https://gateway.portable.test/',
      });
    });

    // The RN client renders NO pending-shutdown banner (removed on purpose) and
    // never enters the re-provision state from this advisory event.
    expect(screen.queryByTestId('system-shutdown-banner')).toBeNull();
    expect(screen.queryByTestId('system-reprovisioning')).toBeNull();
    // RN must NOT navigate via window.location.href even though a redirect_url was sent.
    expect(hrefSetter).not.toHaveBeenCalled();
  });

  it('shows the reconnecting banner while down on resume and clears it on connect', async () => {
    await mountProvider();

    // No banner before the first connection (initial connect is "connecting", not "reconnecting").
    expect(screen.queryByTestId('reconnecting-banner')).toBeNull();

    // First successful connection.
    act(() => {
      controller.setConnected(true);
    });
    expect(screen.queryByTestId('reconnecting-banner')).toBeNull();

    // Socket drops (e.g. OS tore it down while backgrounded; now resuming) → persistent banner.
    act(() => {
      controller.setConnected(false);
    });
    expect(screen.queryByTestId('reconnecting-banner')).not.toBeNull();

    // Reconnect → banner clears immediately on the `connect` event (no arbitrary timeout).
    act(() => {
      controller.setConnected(true);
    });
    expect(screen.queryByTestId('reconnecting-banner')).toBeNull();
  });
});
