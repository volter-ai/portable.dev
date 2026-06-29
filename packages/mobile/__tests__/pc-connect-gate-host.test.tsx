/**
 * PcConnectGateHost — the disconnect → connection-page wiring (rev6).
 *
 * The host renders the authenticated children when a PC is connected, and the QR
 * scanner when not. The Runtime "Disconnect" action drops the pairing and bumps
 * `pcConnectionStore`; this asserts the host then returns to the scanner — and, the
 * crux of the ref-vs-`>0` correctness, that a FRESH mount with a stale non-zero
 * signal still shows the app (it reacts to a CHANGE, not to a non-zero value).
 *
 * `QrCameraScanner` is mocked so the scanner renders without `expo-camera`.
 */

jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string | number | boolean) => store.set(k, String(v)),
    getString: (k: string) => (store.has(k) ? store.get(k) : undefined),
    remove: (k: string) => store.delete(k),
    contains: (k: string) => store.has(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    getItemAsync: async (k: string) => (store.has(k) ? store.get(k)! : null),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});

jest.mock('../src/features/pc-connect/QrCameraScanner', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View testID="qr-camera-stub" /> };
});

import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { PcConnectConfig } from '../src/features/pc-connect';
import { usePcConnectionStore } from '../src/features/pc-connect/pcConnectionStore';
import { PcConnectGateHost } from '../src/features/shell/PcConnectGateHost';

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function connectedConfig(): PcConnectConfig {
  return {
    getConnectedPcId: async () => 'pc-1',
    onConnect: async () => true,
    onLink: async () => {},
  };
}

function renderHost(config: PcConnectConfig) {
  return render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <PcConnectGateHost config={config}>
        <Text testID="app-marker">app</Text>
      </PcConnectGateHost>
    </SafeAreaProvider>
  );
}

afterEach(() => {
  act(() => usePcConnectionStore.getState().reset());
});

describe('PcConnectGateHost — disconnect', () => {
  it('renders the app when a PC is connected', async () => {
    renderHost(connectedConfig());
    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeTruthy());
    expect(screen.queryByTestId('qr-scanner')).toBeNull();
  });

  it('shows the connect landing (not the camera) when no PC is connected', async () => {
    renderHost({
      getConnectedPcId: async () => null,
      onConnect: async () => true,
      onLink: async () => {},
    });
    await waitFor(() => expect(screen.getByTestId('pc-connect-landing')).toBeTruthy());
    expect(screen.queryByTestId('app-marker')).toBeNull();
    // Landing-first: the live camera is NOT opened until the user taps Scan.
    expect(screen.queryByTestId('qr-scanner')).toBeNull();
  });

  it('returns to the connect landing when an explicit disconnect is signalled', async () => {
    renderHost(connectedConfig());
    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeTruthy());

    act(() => usePcConnectionStore.getState().signalDisconnected());

    await waitFor(() => expect(screen.getByTestId('pc-connect-landing')).toBeTruthy());
    expect(screen.queryByTestId('app-marker')).toBeNull();
    // Disconnect lands on the connect page — it does NOT auto-open the camera.
    expect(screen.queryByTestId('qr-scanner')).toBeNull();
  });

  it('does NOT return to connect on mount when a stale disconnect signal is already non-zero', async () => {
    // A prior session disconnected (signal already 1). A fresh host mount that
    // resolves a connected PC must show the app, never re-open the connect gate.
    act(() => usePcConnectionStore.getState().signalDisconnected());

    renderHost(connectedConfig());

    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeTruthy());
    expect(screen.queryByTestId('pc-connect-landing')).toBeNull();
  });
});

describe('PcConnectGateHost — Apple reviewer fast path (D40)', () => {
  const REVIEWER_TRIPLE = {
    gatewayBase: 'https://app.portable.dev',
    pcId: 'reviewer-pc',
    token: 'reviewer-jwt',
  };

  it('reviewer match: links + connects WITHOUT mounting the QR scanner', async () => {
    const onLink = jest.fn(async () => {});
    const onConnect = jest.fn(async () => true);
    const getReviewerCredentials = jest.fn(async () => REVIEWER_TRIPLE);

    renderHost({
      getConnectedPcId: async () => null,
      onConnect,
      onLink,
      getReviewerCredentials,
    });

    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeTruthy());
    expect(getReviewerCredentials).toHaveBeenCalledTimes(1);
    // Reuses the production seams verbatim: onLink (= linkPc save-only) then onConnect.
    expect(onLink).toHaveBeenCalledWith(REVIEWER_TRIPLE);
    expect(onConnect).toHaveBeenCalledWith('reviewer-pc');
    // The QR landing / scanner are skipped entirely.
    expect(screen.queryByTestId('pc-connect-landing')).toBeNull();
    expect(screen.queryByTestId('qr-scanner')).toBeNull();
  });

  it('non-reviewer (null / 403): falls through to the QR landing, no link/connect', async () => {
    const onLink = jest.fn(async () => {});
    const onConnect = jest.fn(async () => true);
    const getReviewerCredentials = jest.fn(async () => null);

    renderHost({
      getConnectedPcId: async () => null,
      onConnect,
      onLink,
      getReviewerCredentials,
    });

    await waitFor(() => expect(screen.getByTestId('pc-connect-landing')).toBeTruthy());
    expect(getReviewerCredentials).toHaveBeenCalledTimes(1);
    expect(onLink).not.toHaveBeenCalled();
    expect(onConnect).not.toHaveBeenCalled();
    expect(screen.queryByTestId('app-marker')).toBeNull();
  });

  it('reviewer endpoint error → QR landing (safe degradation)', async () => {
    const getReviewerCredentials = jest.fn(async () => {
      throw new Error('network');
    });

    renderHost({
      getConnectedPcId: async () => null,
      onConnect: async () => true,
      onLink: async () => {},
      getReviewerCredentials,
    });

    await waitFor(() => expect(screen.getByTestId('pc-connect-landing')).toBeTruthy());
  });

  it('reviewer match but the connect fails → falls through to the QR landing', async () => {
    const onConnect = jest.fn(async () => false);

    renderHost({
      getConnectedPcId: async () => null,
      onConnect,
      onLink: async () => {},
      getReviewerCredentials: async () => REVIEWER_TRIPLE,
    });

    await waitFor(() => expect(screen.getByTestId('pc-connect-landing')).toBeTruthy());
    expect(onConnect).toHaveBeenCalledWith('reviewer-pc');
  });

  it('a connected PC short-circuits BEFORE the reviewer check', async () => {
    const getReviewerCredentials = jest.fn(async () => null);

    renderHost({
      getConnectedPcId: async () => 'pc-1',
      onConnect: async () => true,
      onLink: async () => {},
      getReviewerCredentials,
    });

    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeTruthy());
    expect(getReviewerCredentials).not.toHaveBeenCalled();
  });
});
