/**
 * Idle & shutdown warnings (socket-driven).
 *
 * Drives the native Socket.IO provider with a mocked Socket.IO server and asserts
 * the lifecycle behaviour layered on top of the prior warnings:
 *
 *   1. `system:idle_warning` renders the countdown from `timeRemaining`, and the
 *      "I'm still here" dismiss EXTENDS the session (calls the extend-session
 *      action) and clears the warning;
 *   2. `system:idle_warning_cleared` clears the warning;
 *   3. `system:idle_shutdown` AND `session:expired` route to the re-provision /
 *      loading state and invoke `onReprovision` (the recovery hand-off);
 *   4. `system:shutdown_warning` (~60s pre-SIGUSR1) is IGNORED — the RN client
 *      has no pending-shutdown banner (recovered transparently);
 *   5. nothing navigates via `window.location.href` (RN has no DOM).
 *
 * Plus a unit check that the default `extendSession` pings the sandbox activity
 * endpoint that resets the idle timer.
 */

// Hoisted above imports: route `createSocket()`'s `io()` to our mock socket.
jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});

// The socket barrel transitively imports the MMKV-backed offline queue store and
// (via extendSession) expo-secure-store. Mock both native modules so importing
// the barrel doesn't load a JSI / keychain module.
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

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: async (key: string, value: string) => void store.set(key, value),
    getItemAsync: async (key: string) => (store.has(key) ? store.get(key)! : null),
    deleteItemAsync: async (key: string) => void store.delete(key),
  };
});

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { SERVER_EVENTS } from '@vgit2/shared/socket';

import { extendSession, SocketProvider, useSocketStore } from '../src/features/socket';
import type { AppStateLike, NetInfoLike, AppStateStatus } from '../src/features/socket';
// FILE import (not the health barrel) — keeps the mock graph slim.
import { useConnectionFailedStore } from '../src/features/health/connectionFailedStore';
import { type MockSocketIoModule } from '../src/test';

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

describe('idle & shutdown warnings (socket-driven)', () => {
  let appCtl: ReturnType<typeof createAppStateController>;
  let netCtl: ReturnType<typeof createNetInfoController>;
  let onExtendSession: jest.Mock;
  let onReprovision: jest.Mock;
  let hrefSetter: jest.Mock;

  async function mountProvider(): Promise<void> {
    render(
      <SocketProvider
        getAuthToken={async () => 'token-abc'}
        getRelayUrl={async () => 'https://sandbox.portable.test'}
        appState={appCtl.appState}
        netInfo={netCtl.netInfo}
        onExtendSession={onExtendSession}
        onReprovision={onReprovision}
      >
        <Text testID="child">app</Text>
      </SocketProvider>
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    appCtl = createAppStateController();
    netCtl = createNetInfoController();
    onExtendSession = jest.fn();
    onReprovision = jest.fn();
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
      useConnectionFailedStore.setState({
        visible: false,
        reason: 'pc-down',
      });
    });
    controller.reset();
    const g = globalThis as { window?: { location?: unknown } };
    if (g.window) delete g.window.location;
  });

  it('renders the idle countdown from timeRemaining; "I\'m still here" extends + clears', async () => {
    await mountProvider();

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.SYSTEM_IDLE_WARNING, {
        message: 'Are you still there?',
        timeRemaining: 90,
      });
    });
    expect(screen.queryByTestId('system-idle-warning-modal')).not.toBeNull();
    expect(screen.getByTestId('system-idle-warning-countdown').props.children).toBe(
      '90s remaining'
    );

    // "I'm still here" EXTENDS the session (activity ping) AND dismisses the modal.
    act(() => {
      fireEvent.press(screen.getByTestId('system-idle-warning-dismiss'));
    });
    expect(onExtendSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('system-idle-warning-modal')).toBeNull();
    expect(onReprovision).not.toHaveBeenCalled();
    expect(hrefSetter).not.toHaveBeenCalled();
  });

  it('clears the idle warning on system:idle_warning_cleared', async () => {
    await mountProvider();

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.SYSTEM_IDLE_WARNING, {
        message: 'Are you still there?',
        timeRemaining: 30,
      });
    });
    expect(screen.queryByTestId('system-idle-warning-modal')).not.toBeNull();

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.SYSTEM_IDLE_WARNING_CLEARED);
    });
    expect(screen.queryByTestId('system-idle-warning-modal')).toBeNull();
    expect(onReprovision).not.toHaveBeenCalled();
  });

  it('routes system:idle_shutdown to the re-provision/loading state', async () => {
    await mountProvider();

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.SYSTEM_IDLE_WARNING, {
        message: 'Are you still there?',
        timeRemaining: 5,
      });
    });
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.SYSTEM_IDLE_SHUTDOWN, {
        message: 'Session ending due to inactivity.',
      });
    });

    expect(screen.queryByTestId('system-idle-warning-modal')).toBeNull();
    expect(screen.queryByTestId('system-reprovisioning')).not.toBeNull();
    expect(onReprovision).toHaveBeenCalledTimes(1);
    expect(hrefSetter).not.toHaveBeenCalled();
  });

  it('routes session:expired to the re-provision/loading state', async () => {
    await mountProvider();

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.SESSION_EXPIRED, {
        reason: 'Idle for more than 5 minutes',
      });
    });

    expect(screen.queryByTestId('system-reprovisioning')).not.toBeNull();
    expect(screen.getByTestId('system-reprovisioning-message').props.children).toBe(
      'Idle for more than 5 minutes'
    );
    expect(onReprovision).toHaveBeenCalledTimes(1);
    expect(hrefSetter).not.toHaveBeenCalled();
  });

  it('a successful (re)connect clears the re-provision overlay', async () => {
    await mountProvider();

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.SESSION_EXPIRED, {
        reason: 'Idle for more than 5 minutes',
      });
    });
    expect(screen.queryByTestId('system-reprovisioning')).not.toBeNull();

    // Recovery re-points the socket and it connects — the session is live again,
    // so the overlay must drop (nothing else ever clears `sessionEnded`).
    act(() => {
      controller.setConnected(true);
    });
    expect(screen.queryByTestId('system-reprovisioning')).toBeNull();
  });

  it('the re-provision overlay yields to the terminal ConnectionFailed state', async () => {
    await mountProvider();

    act(() => {
      useConnectionFailedStore.getState().show('pc-down');
      controller.emitServerEvent(SERVER_EVENTS.SESSION_EXPIRED, {
        reason: 'Idle for more than 5 minutes',
      });
    });

    // The full-screen overlay must not cover the ConnectionFailed screen's
    // "Try again" — the terminal state wins.
    expect(screen.queryByTestId('system-reprovisioning')).toBeNull();
  });

  it('ignores system:shutdown_warning (no banner, no re-provision, no redirect)', async () => {
    await mountProvider();

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.SYSTEM_SHUTDOWN_WARNING, {
        message: 'Sandbox restarting for updates',
        redirect_url: 'https://gateway.portable.test/',
      });
    });

    // The RN client renders NO pending-shutdown banner (removed on purpose) —
    // sandbox death is recovered transparently by the health monitor.
    expect(screen.queryByTestId('system-shutdown-banner')).toBeNull();
    expect(screen.queryByTestId('system-reprovisioning')).toBeNull();
    expect(onReprovision).not.toHaveBeenCalled();
    expect(hrefSetter).not.toHaveBeenCalled();
  });

  it('default extendSession pings the sandbox activity endpoint (resets the idle timer)', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 204 }) as Response);
    const sent = await extendSession({
      fetchImpl: fetchImpl as never,
      resolveSandboxUrl: async () => 'https://sandbox.portable.test/',
    });

    expect(sent).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://sandbox.portable.test/api/activity/ping');
    expect(init.method).toBe('POST');
  });

  it('extendSession is a no-op when no sandbox URL is provisioned yet', async () => {
    const fetchImpl = jest.fn();
    const sent = await extendSession({
      fetchImpl: fetchImpl as never,
      resolveSandboxUrl: async () => null,
    });
    expect(sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
