/**
 * PcConnectModal + Settings "Connect PC" entry (rev6 QR re-scan).
 *
 * The reusable in-app re-pair flow (replaced the misleading repos-error "Connect
 * GitHub" button + backs the always-on Settings entry). Drives the modal's state
 * machine with INJECTED seams (`link`/`connect`/`renderScanner`) so no native module
 * loads — the default scanner's `expo-camera` is never pulled into the Jest graph.
 */

// PcConnectModal's graph (connectToPc → connectedPcStore/deviceTokenStore) reaches
// expo-secure-store at module load.
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    getItemAsync: jest.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
    deleteItemAsync: jest.fn(async (k: string) => void store.delete(k)),
  };
});

// react-native-mmkv backs the theme store (useAppTheme) + devModeStore (gatewayConfig).
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string) => store.set(k, v),
    getString: (k: string) => store.get(k) ?? undefined,
    remove: (k: string) => store.delete(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { QrLinkPayload } from '@vgit2/shared/types';

import { ConnectionFailedScreen } from '../src/features/health/ConnectionFailedScreen';
import { getConnectedPcId, saveConnectedPcId } from '../src/features/pc-connect/connectedPcStore';
import {
  getDeviceToken,
  getE2eKey,
  saveDeviceToken,
  saveE2eKey,
} from '../src/features/pc-connect/deviceTokenStore';
import {
  PcConnectModal,
  type PcConnectModalProps,
} from '../src/features/pc-connect/PcConnectModal';
import { SettingsConnectPc } from '../src/features/settings/SettingsConnectPc';

const secureStore = jest.requireMock('expo-secure-store') as { __store: Map<string, string> };
// New tests below write to (mocked) SecureStore — wipe it so the stale-pairing
// fixtures never leak between cases.
afterEach(() => secureStore.__store.clear());

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const PAYLOAD: QrLinkPayload = {
  gatewayBase: 'https://app.portable.dev',
  pcId: 'pc_x',
  token: 'pc-minted-jwt',
  e2eKey: 'psk-base64',
};

/** A fake scanner that fires `onPayload(PAYLOAD)` when pressed (no camera). */
function fakeScanner({ onPayload }: { onPayload: (p: QrLinkPayload) => void }) {
  return (
    <Pressable testID="fake-scan" onPress={() => onPayload(PAYLOAD)}>
      <Text>scan</Text>
    </Pressable>
  );
}

/** A fake scanner exposing BOTH a scan and a back-out (cancel) affordance. */
function fakeScannerCancellable({
  onPayload,
  onCancel,
}: {
  onPayload: (p: QrLinkPayload) => void;
  onCancel: () => void;
}) {
  return (
    <>
      <Pressable testID="fake-scan" onPress={() => onPayload(PAYLOAD)}>
        <Text>scan</Text>
      </Pressable>
      <Pressable testID="fake-cancel" onPress={onCancel}>
        <Text>cancel</Text>
      </Pressable>
    </>
  );
}

function renderModal(props: Partial<PcConnectModalProps> = {}) {
  const onDismiss = props.onDismiss ?? jest.fn();
  const onConnected = props.onConnected ?? jest.fn();
  render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <PcConnectModal
        visible
        onDismiss={onDismiss}
        onConnected={onConnected}
        renderScanner={fakeScanner}
        {...props}
      />
    </SafeAreaProvider>
  );
  return { onDismiss, onConnected };
}

describe('PcConnectModal', () => {
  it('renders null when not visible', () => {
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <PcConnectModal visible={false} onDismiss={jest.fn()} renderScanner={fakeScanner} />
      </SafeAreaProvider>
    );
    expect(screen.queryByTestId('pc-connect-modal')).toBeNull();
  });

  it('scan → link + connect (ready) → fires onConnected and dismisses', async () => {
    const link = jest.fn(async () => {});
    const connect = jest.fn(async () => ({ ready: true as const, deviceToken: 'jwt' }));
    const { onDismiss, onConnected } = renderModal({ link, connect });

    expect(screen.getByTestId('fake-scan')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('fake-scan'));
      await Promise.resolve();
    });

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(link).toHaveBeenCalledWith(PAYLOAD);
    expect(connect).toHaveBeenCalledWith('pc_x');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('DEFAULT link (no seam): clears the stale pairing then saves the fresh JWT + E2E key', async () => {
    // Seed a stale pairing — an old PC whose JWT + E2E key are now useless.
    await saveConnectedPcId('pc_old');
    await saveDeviceToken('pc_old', 'old-jwt');
    await saveE2eKey('pc_old', 'old-psk');

    // NO `link` injected → the modal runs its real resetAndLinkPc default. `connect`
    // is a spy so it never touches the network / re-saves the connected pcId.
    const connect = jest.fn(async () => ({ ready: true as const, deviceToken: 'jwt' }));
    const { onConnected } = renderModal({ connect });

    await act(async () => {
      fireEvent.press(screen.getByTestId('fake-scan'));
      await Promise.resolve();
    });

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(connect).toHaveBeenCalledWith('pc_x');
    // Stale pairing fully wiped; the fresh QR's JWT AND E2E key persisted for pc_x —
    // the E2E key is the half the old `saveDeviceToken`-only default dropped.
    expect(await getConnectedPcId()).toBeNull();
    expect(await getDeviceToken('pc_old')).toBeNull();
    expect(await getE2eKey('pc_old')).toBeNull();
    expect(await getDeviceToken('pc_x')).toBe('pc-minted-jwt');
    expect(await getE2eKey('pc_x')).toBe('psk-base64');
  });

  it('scan → connect (unhealthy) → shows the error, then retry re-arms the scanner', async () => {
    const connect = jest.fn(async () => ({
      ready: false as const,
      deviceToken: 'jwt',
      reason: 'unhealthy' as const,
    }));
    const { onConnected, onDismiss } = renderModal({ link: jest.fn(async () => {}), connect });

    await act(async () => {
      fireEvent.press(screen.getByTestId('fake-scan'));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('pc-connect-error')).toBeTruthy());
    expect(screen.getByTestId('pc-connect-error')).toHaveTextContent(/portable start/);
    expect(onConnected).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();

    // Retry returns to the scanner (a fresh scan can be attempted).
    fireEvent.press(screen.getByTestId('pc-connect-retry'));
    await waitFor(() => expect(screen.getByTestId('fake-scan')).toBeTruthy());
    expect(screen.queryByTestId('pc-connect-error')).toBeNull();
  });

  it('scan → connect throws → shows the error (never crashes)', async () => {
    const connect = jest.fn(async () => {
      throw new Error('boom');
    });
    renderModal({ link: jest.fn(async () => {}), connect });

    await act(async () => {
      fireEvent.press(screen.getByTestId('fake-scan'));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('pc-connect-error')).toBeTruthy());
  });

  it('cancel (scanner back-out) fires onCancel AND onDismiss', () => {
    const onCancel = jest.fn();
    const onDismiss = jest.fn();
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <PcConnectModal
          visible
          onDismiss={onDismiss}
          onCancel={onCancel}
          renderScanner={fakeScannerCancellable}
        />
      </SafeAreaProvider>
    );

    fireEvent.press(screen.getByTestId('fake-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a SUCCESSFUL connect never fires onCancel (only onConnected + onDismiss)', async () => {
    const onCancel = jest.fn();
    const connect = jest.fn(async () => ({ ready: true as const, deviceToken: 'jwt' }));
    const { onConnected, onDismiss } = renderModal({
      onCancel,
      link: jest.fn(async () => {}),
      connect,
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('fake-scan'));
      await Promise.resolve();
    });

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(onCancel).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsConnectPc (always-on Connect PC entry)', () => {
  it('shows the connected pcId and opens the re-scan modal', async () => {
    const link = jest.fn(async () => {});
    const connect = jest.fn(async () => ({ ready: true as const, deviceToken: 'jwt' }));
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <SettingsConnectPc
          getPcId={async () => 'pc_abcdef0123456789'}
          pcConnect={{ link, connect, renderScanner: fakeScanner }}
        />
      </SafeAreaProvider>
    );

    await waitFor(() =>
      expect(screen.getByTestId('settings-connect-pc-status')).toHaveTextContent(/Connected: pc_/)
    );

    // The entry opens the modal; a successful re-scan closes it.
    fireEvent.press(screen.getByTestId('settings-connect-pc'));
    await waitFor(() => expect(screen.getByTestId('fake-scan')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('fake-scan'));
      await Promise.resolve();
    });
    expect(connect).toHaveBeenCalledWith('pc_x');
    await waitFor(() => expect(screen.queryByTestId('pc-connect-modal')).toBeNull());
  });

  it('shows "Not connected" when no PC is linked', async () => {
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <SettingsConnectPc getPcId={async () => null} />
      </SafeAreaProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId('settings-connect-pc-status')).toHaveTextContent(/Not connected/)
    );
  });
});

describe('ConnectionFailedScreen — "Connect PC" boot-stuck exit', () => {
  it('pc-down: Connect PC opens the re-scan; a successful re-pair re-enters (onTryAgain)', async () => {
    const onTryAgain = jest.fn();
    const connect = jest.fn(async () => ({ ready: true as const, deviceToken: 'jwt' }));
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ConnectionFailedScreen
          reason="pc-down"
          onTryAgain={onTryAgain}
          pcConnect={{ link: jest.fn(async () => {}), connect, renderScanner: fakeScanner }}
        />
      </SafeAreaProvider>
    );

    fireEvent.press(screen.getByTestId('connection-failed-connect-pc'));
    await waitFor(() => expect(screen.getByTestId('fake-scan')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('fake-scan'));
      await Promise.resolve();
    });
    expect(connect).toHaveBeenCalledWith('pc_x');
    await waitFor(() => expect(onTryAgain).toHaveBeenCalledTimes(1));
  });

  it('offline: no "Connect PC" (re-scanning needs the network)', () => {
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ConnectionFailedScreen reason="offline" onTryAgain={jest.fn()} />
      </SafeAreaProvider>
    );
    expect(screen.queryByTestId('connection-failed-connect-pc')).toBeNull();
  });

  it('pc-down: cancelling the re-scan disconnects (clears stale pairing + returns to landing)', async () => {
    const onDisconnect = jest.fn();
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ConnectionFailedScreen
          reason="pc-down"
          onTryAgain={jest.fn()}
          onDisconnect={onDisconnect}
          pcConnect={{ renderScanner: fakeScannerCancellable }}
        />
      </SafeAreaProvider>
    );

    fireEvent.press(screen.getByTestId('connection-failed-connect-pc'));
    await waitFor(() => expect(screen.getByTestId('fake-cancel')).toBeTruthy());
    fireEvent.press(screen.getByTestId('fake-cancel'));

    // Giving up on the dead PC forgets the pairing + returns to the connect landing,
    // instead of bouncing back here with the same rejected credentials.
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('pc-down: re-scanning clears the stale pairing FIRST, then saves the fresh QR token + E2E key', async () => {
    // Seed a stale pairing — a now-dead PC whose JWT the relay rejects, plus its
    // (now-mismatched) E2E key.
    await saveConnectedPcId('pc_old');
    await saveDeviceToken('pc_old', 'old-rejected-jwt');
    await saveE2eKey('pc_old', 'old-mismatched-psk');

    // No `link` injected → the screen uses the shared resetAndLinkPc default via the
    // modal; `connect` is a spy so it never reaches the network (and never re-saves
    // the connected pcId).
    const connect = jest.fn(async () => ({ ready: true as const, deviceToken: 'jwt' }));
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ConnectionFailedScreen
          reason="pc-down"
          onTryAgain={jest.fn()}
          pcConnect={{ connect, renderScanner: fakeScanner }}
        />
      </SafeAreaProvider>
    );

    fireEvent.press(screen.getByTestId('connection-failed-connect-pc'));
    await waitFor(() => expect(screen.getByTestId('fake-scan')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('fake-scan'));
      await Promise.resolve();
    });

    await waitFor(() => expect(connect).toHaveBeenCalledWith('pc_x'));
    // The stale pairing is wiped (pcId + the rejected token + the mismatched key);
    // the fresh QR's JWT AND E2E key survive, keyed by the newly-scanned pcId — so a
    // recovery re-pair never dead-ends on "No E2E key" again.
    expect(await getConnectedPcId()).toBeNull();
    expect(await getDeviceToken('pc_old')).toBeNull();
    expect(await getE2eKey('pc_old')).toBeNull();
    expect(await getDeviceToken('pc_x')).toBe('pc-minted-jwt');
    expect(await getE2eKey('pc_x')).toBe('psk-base64');
  });

  it('pc-down: "Log out" runs the injected logout seam (wipe + sign-in)', () => {
    const onLogout = jest.fn();
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ConnectionFailedScreen reason="pc-down" onTryAgain={jest.fn()} onLogout={onLogout} />
      </SafeAreaProvider>
    );

    fireEvent.press(screen.getByTestId('connection-failed-logout'));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('offline: "Log out" is available too (works offline, clears local data)', () => {
    const onLogout = jest.fn();
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ConnectionFailedScreen reason="offline" onTryAgain={jest.fn()} onLogout={onLogout} />
      </SafeAreaProvider>
    );

    fireEvent.press(screen.getByTestId('connection-failed-logout'));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
