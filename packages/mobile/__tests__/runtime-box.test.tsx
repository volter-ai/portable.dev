/**
 * runtime port — RuntimeOverviewScreen (the `/runtime` tab hub).
 *
 * Drives the native Socket.IO provider with a mocked Socket.IO server and asserts
 * the overview end-to-end (Browser/Storage removed from the app, host
 * metrics revived, memory-watchdog dropped):
 *   1. renders the tunnels / background-tasks / Claude-session cards + counts from
 *      `user:runtime_state` (+ a defensive dedupe-by-id of background tasks).
 *   2. updates the host metrics card from `sandbox:metrics` (no watchdog banner).
 *   3. navigates to the detail/list routes on card / "View all" taps (Android);
 *      the iOS tunnel-card tap opens the SYSTEM browser directly.
 */

jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});

jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (key: string, value: string | number | boolean) => store.set(key, String(value)),
    getString: (key: string) => (store.has(key) ? store.get(key) : undefined),
    remove: (key: string) => store.delete(key),
    contains: (key: string) => store.has(key),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

jest.mock('react-native-markdown-display', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children?: unknown }) => <Text>{children}</Text>,
  };
});
jest.mock('expo-audio', () => require('../src/test/mockExpoAudio').createExpoAudioMock());

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    getItemAsync: async (k: string) => (store.has(k) ? store.get(k)! : null),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SERVER_EVENTS } from '@vgit2/shared/socket';
import type {
  ProcessData,
  RuntimeClaudeSessionPayload,
  SandboxMetrics,
  TunnelData,
} from '@vgit2/shared/types';

import { RuntimeOverviewScreen, type RuntimeOverviewProps } from '../src/features/runtime';
import { SocketProvider, useSocketStore } from '../src/features/socket';
import type { AppStateLike, NetInfoLike, AppStateStatus } from '../src/features/socket';
import { useRuntimeStore } from '../src/features/state/runtimeStore';
import type { MockSocketIoModule } from '../src/test';

const socketMock = jest.requireMock('socket.io-client') as MockSocketIoModule;
const controller = socketMock.__controller;

const CHAT_ID = 'chat-rt-1';
const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

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

const processes: ProcessData[] = [
  {
    id: 'proc-1',
    command: 'bun run dev',
    status: 'running',
    description: 'dev server',
    startedAt: 1,
    chatId: CHAT_ID,
  },
];

const tunnels: TunnelData[] = [
  { port: 3000, url: 'https://abc.trycloudflare.com', name: 'dev', createdAt: 1, active: true },
];

const metrics: SandboxMetrics = {
  cpuUsagePercent: 42,
  cpuCores: 0.84,
  cpuLimitCores: 2,
  memoryUsedMB: 512,
  memoryLimitMB: 2048,
  memoryPercent: 25,
  workspaceSizeGB: 1.2,
  uptimeSeconds: 120,
};

const claudeSessions: RuntimeClaudeSessionPayload[] = [
  {
    chatId: 'chat-a',
    repoPath: '/ws/acme/widget',
    status: 'idle',
    isProcessing: false,
    lastActivityAt: 1,
    idleMs: 200_000,
    resumable: true,
  },
  {
    chatId: 'chat-b',
    repoPath: '/ws/acme/api',
    status: 'running',
    isProcessing: true,
    lastActivityAt: 1,
    idleMs: 0,
    resumable: true,
  },
];

/** A `user:runtime_state` snapshot carrying only Claude sessions. */
function claudeSnapshot() {
  return {
    backgroundProcesses: [],
    tunnels: [],
    claudeSessions,
    claudeSessionIdleTtlMs: 600_000,
  };
}

async function mount(props?: Partial<RuntimeOverviewProps>): Promise<{ navigate: jest.Mock }> {
  const navigate = jest.fn();
  const appCtl = createAppStateController();
  const netCtl = createNetInfoController();
  render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <SocketProvider
        getAuthToken={async () => 'token-abc'}
        getRelayUrl={async () => 'https://sandbox.portable.test'}
        appState={appCtl.appState}
        netInfo={netCtl.netInfo}
      >
        <RuntimeOverviewScreen chatId={CHAT_ID} navigate={navigate} {...props} />
      </SocketProvider>
    </SafeAreaProvider>
  );
  await waitFor(() => {
    act(() => {
      controller.setConnected(true);
    });
    expect(useSocketStore.getState().connected).toBe(true);
  });
  return { navigate };
}

function emitServer(event: string, payload: unknown): void {
  act(() => {
    controller.emitServerEvent(event, payload);
  });
}

describe('runtime — RuntimeOverviewScreen', () => {
  afterEach(() => {
    act(() => {
      useSocketStore.getState().reset();
      useRuntimeStore.getState().reset();
    });
    controller.reset();
  });

  it('renders processes / tunnels cards + counts from user:runtime_state', async () => {
    await mount();

    expect(screen.getByTestId('runtime-processes-empty')).toBeTruthy();
    expect(screen.getByTestId('runtime-tunnels-empty')).toBeTruthy();

    emitServer(SERVER_EVENTS.USER_RUNTIME_STATE, {
      backgroundProcesses: processes,
      tunnels,
    });

    expect(screen.getByTestId('runtime-process-proc-1')).toBeTruthy();
    expect(screen.getByTestId('runtime-tunnel-3000')).toBeTruthy();
    expect(screen.getByTestId('runtime-processes-count')).toHaveTextContent('1');
    expect(screen.getByTestId('runtime-tunnels-count')).toHaveTextContent('1');
  });

  it('dedupes background tasks by id (defensive)', async () => {
    await mount();

    emitServer(SERVER_EVENTS.USER_RUNTIME_STATE, {
      backgroundProcesses: [processes[0], { ...processes[0] }],
      tunnels: [],
    });

    expect(screen.getAllByTestId('runtime-process-proc-1')).toHaveLength(1);
    expect(screen.getByTestId('runtime-processes-count')).toHaveTextContent('1');
  });

  it('updates the host metrics card from sandbox:metrics', async () => {
    await mount();

    expect(screen.getByTestId('runtime-metrics-empty')).toBeTruthy();

    emitServer(SERVER_EVENTS.SANDBOX_METRICS, metrics);
    expect(screen.getByTestId('runtime-metric-cpu')).toHaveTextContent(/42%/);
    expect(screen.getByTestId('runtime-metric-memory')).toHaveTextContent(/25%/);
    expect(screen.getByTestId('runtime-metric-uptime')).toHaveTextContent(/2m/);
  });

  it('navigates from tunnel / background-task cards and "View all"', async () => {
    const { navigate } = await mount({ platform: 'android' });

    emitServer(SERVER_EVENTS.USER_RUNTIME_STATE, {
      backgroundProcesses: processes,
      tunnels,
    });

    fireEvent.press(screen.getByTestId('runtime-tunnel-3000'));
    expect(navigate).toHaveBeenCalledWith('/runtime/tunnel/3000');

    fireEvent.press(screen.getByTestId('runtime-process-proc-1'));
    expect(navigate).toHaveBeenCalledWith('/runtime/process/proc-1');

    fireEvent.press(screen.getByTestId('runtime-tunnels-link'));
    expect(navigate).toHaveBeenCalledWith('/runtime/tunnels');
  });

  it('iOS: a tunnel-card tap opens the SYSTEM browser directly; processes still navigate', async () => {
    const openExternal = jest.fn();
    const { navigate } = await mount({ platform: 'ios', openExternal });

    emitServer(SERVER_EVENTS.USER_RUNTIME_STATE, {
      backgroundProcesses: processes,
      tunnels,
    });

    fireEvent.press(screen.getByTestId('runtime-tunnel-3000'));
    expect(openExternal).toHaveBeenCalledWith('https://abc.trycloudflare.com');
    expect(navigate).not.toHaveBeenCalledWith('/runtime/tunnel/3000');

    // Only USER-URL viewers bypass the detail hop — process detail (terminal
    // output, no web content) still navigates on iOS.
    fireEvent.press(screen.getByTestId('runtime-process-proc-1'));
    expect(navigate).toHaveBeenCalledWith('/runtime/process/proc-1');
  });

  // ── Claude sessions ──
  it('renders live Claude sessions + the idle-TTL caption from user:runtime_state', async () => {
    await mount();

    expect(screen.getByTestId('runtime-claude-sessions-empty')).toBeTruthy();

    emitServer(SERVER_EVENTS.USER_RUNTIME_STATE, claudeSnapshot());

    expect(screen.getByTestId('runtime-claude-session-chat-a')).toBeTruthy();
    expect(screen.getByTestId('runtime-claude-session-chat-b')).toBeTruthy();
    expect(screen.getByTestId('runtime-claude-sessions-count')).toHaveTextContent('2');
    // 600_000 ms → "10m"
    expect(screen.getByTestId('runtime-claude-ttl')).toHaveTextContent(/10m/);
  });

  it('Kill button emits chat:kill-session for that chat', async () => {
    await mount();
    emitServer(SERVER_EVENTS.USER_RUNTIME_STATE, claudeSnapshot());

    await act(async () => {
      fireEvent.press(screen.getByTestId('runtime-claude-session-chat-a-kill'));
      await Promise.resolve();
    });

    const kills = controller.emissions.filter((e) => e.event === 'chat:kill-session');
    expect(kills).toHaveLength(1);
    expect(kills[0].args[0]).toEqual({ chatId: 'chat-a' });
  });

  it('session:reaped drops the reaped session from the panel', async () => {
    await mount();
    emitServer(SERVER_EVENTS.USER_RUNTIME_STATE, claudeSnapshot());
    expect(screen.getByTestId('runtime-claude-session-chat-a')).toBeTruthy();

    emitServer(SERVER_EVENTS.SESSION_REAPED, {
      chatId: 'chat-a',
      reason: 'idle',
      idleMs: 700_000,
      timestamp: 1,
    });

    expect(screen.queryByTestId('runtime-claude-session-chat-a')).toBeNull();
    expect(screen.getByTestId('runtime-claude-session-chat-b')).toBeTruthy();
  });

  it('Disconnect entry opens a confirm modal; submit forgets the PC pairing', async () => {
    const onDisconnect = jest.fn().mockResolvedValue(undefined);
    await mount({ onDisconnect });

    // No confirm until the entry is pressed (Modal visible=false hides its testID).
    expect(screen.queryByTestId('runtime-disconnect-confirm')).toBeNull();

    fireEvent.press(screen.getByTestId('runtime-disconnect-entry'));
    expect(screen.getByTestId('runtime-disconnect-confirm')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('runtime-disconnect-submit'));
      await Promise.resolve();
    });

    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('Disconnect confirm Cancel closes the modal without disconnecting', async () => {
    const onDisconnect = jest.fn().mockResolvedValue(undefined);
    await mount({ onDisconnect });

    fireEvent.press(screen.getByTestId('runtime-disconnect-entry'));
    expect(screen.getByTestId('runtime-disconnect-confirm')).toBeTruthy();

    fireEvent.press(screen.getByTestId('runtime-disconnect-cancel'));

    expect(screen.queryByTestId('runtime-disconnect-confirm')).toBeNull();
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});

// NB: the "Restart sandbox" entry was REMOVED (no Modal sandbox to restart);
// the bottom danger entry is now "Disconnect PC" → forget the pairing + return to the
// QR scanner (the PC is the runtime; re-pairing is also "Connect PC" in
// Settings/Home/Repos).
