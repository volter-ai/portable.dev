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

let mockOnScan: ((raw: string) => void) | undefined;
jest.mock('../src/features/pc-connect/QrCameraScanner', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: ({ onScan }: { onScan: (raw: string) => void }) => {
      mockOnScan = onScan;
      return <View testID="qr-camera-stub" />;
    },
  };
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { PcConnectConfig } from '../src/features/pc-connect';
import { usePcConnectionStore } from '../src/features/pc-connect/pcConnectionStore';
import { PcConnectGateHost } from '../src/features/shell/PcConnectGateHost';

const VALID_QR = JSON.stringify({
  gatewayBase: 'https://app.portable.dev',
  pcId: 'pc_charlie',
  token: 'pc-minted-jwt',
  e2eKey: 'psk-base64',
});

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function connectedConfig(): PcConnectConfig {
  return {
    getConnectedPcId: async () => 'pc-1',
    // A returning device renders the app only when it STILL holds the pcId's E2E
    // key; a missing key self-heals back to the scanner (portable.dev#13).
    getE2eKey: async () => 'psk-base64',
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
  mockOnScan = undefined;
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

describe('PcConnectGateHost — E2E-key self-heal (portable.dev#13)', () => {
  it('connected PC WITH an E2E key renders the app', async () => {
    const getE2eKey = jest.fn(async () => 'psk-base64');
    renderHost({
      getConnectedPcId: async () => 'pc-1',
      getE2eKey,
      onConnect: async () => true,
      onLink: async () => {},
    });

    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeTruthy());
    expect(getE2eKey).toHaveBeenCalledWith('pc-1');
    expect(screen.queryByTestId('pc-connect-landing')).toBeNull();
  });

  it('connected PC MISSING its E2E key (pre-E2E pairing) routes to the scanner, not the app', async () => {
    const getE2eKey = jest.fn(async () => null);
    renderHost({
      getConnectedPcId: async () => 'pc-legacy',
      getE2eKey,
      onConnect: async () => true,
      onLink: async () => {},
    });

    await waitFor(() => expect(screen.getByTestId('pc-connect-landing')).toBeTruthy());
    expect(getE2eKey).toHaveBeenCalledWith('pc-legacy');
    expect(screen.queryByTestId('app-marker')).toBeNull();
  });

  it('an unreadable keychain (getE2eKey throws) fails open to the scanner, not a wedged app', async () => {
    const getE2eKey = jest.fn(async () => {
      throw new Error('keychain unavailable');
    });
    renderHost({
      getConnectedPcId: async () => 'pc-1',
      getE2eKey,
      onConnect: async () => true,
      onLink: async () => {},
    });

    await waitFor(() => expect(screen.getByTestId('pc-connect-landing')).toBeTruthy());
    expect(screen.queryByTestId('app-marker')).toBeNull();
  });
});

describe('PcConnectGateHost — Apple reviewer fast path (D40)', () => {
  const REVIEWER_CREDS = {
    gatewayBase: 'https://app.portable.dev',
    pcId: 'reviewer-pc',
    token: 'reviewer-jwt',
    e2eKey: 'reviewer-psk-base64',
  };

  it('reviewer match: links (JWT + E2E key) + connects WITHOUT mounting the QR scanner', async () => {
    const onLink = jest.fn(async () => {});
    const onConnect = jest.fn(async () => true);
    const getReviewerCredentials = jest.fn(async () => REVIEWER_CREDS);

    renderHost({
      getConnectedPcId: async () => null,
      onConnect,
      onLink,
      getReviewerCredentials,
    });

    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeTruthy());
    expect(getReviewerCredentials).toHaveBeenCalledTimes(1);
    // Reuses the production seams verbatim: onLink (= linkPc save-only) then onConnect.
    // The E2E key rides along — mandatory E2E makes a keyless pairing unusable.
    expect(onLink).toHaveBeenCalledWith(REVIEWER_CREDS);
    expect(onConnect).toHaveBeenCalledWith('reviewer-pc');
    // The QR landing / scanner are skipped entirely.
    expect(screen.queryByTestId('pc-connect-landing')).toBeNull();
    expect(screen.queryByTestId('qr-scanner')).toBeNull();
  });

  it('reviewer creds WITHOUT an e2eKey abort the bypass → QR landing, nothing linked (portable.dev#15)', async () => {
    const onLink = jest.fn(async () => {});
    const onConnect = jest.fn(async () => true);
    // An outdated gateway / static-env fallback that still answers keyless: linking
    // it would strand the app on a pairing every /api/* call rejects (mandatory E2E).
    const getReviewerCredentials = jest.fn(async () => ({
      gatewayBase: 'https://app.portable.dev',
      pcId: 'reviewer-pc',
      token: 'reviewer-jwt',
    }));

    renderHost({
      getConnectedPcId: async () => null,
      onConnect,
      onLink,
      getReviewerCredentials,
    });

    await waitFor(() => expect(screen.getByTestId('pc-connect-landing')).toBeTruthy());
    expect(onLink).not.toHaveBeenCalled();
    expect(onConnect).not.toHaveBeenCalled();
    expect(screen.queryByTestId('app-marker')).toBeNull();
  });

  it('a stored pairing MISSING its E2E key self-heals through the reviewer fast path (no scanner)', async () => {
    // The review device paired before E2E existed: it holds the reviewer pcId +
    // JWT but no E2E key. The host must retry the fast path (which now republishes
    // the key) BEFORE dead-ending at the scanner (portable.dev#15).
    const onLink = jest.fn(async () => {});
    const onConnect = jest.fn(async () => true);
    const getReviewerCredentials = jest.fn(async () => REVIEWER_CREDS);

    renderHost({
      getConnectedPcId: async () => 'reviewer-pc',
      getE2eKey: async () => null,
      onConnect,
      onLink,
      getReviewerCredentials,
    });

    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeTruthy());
    expect(getReviewerCredentials).toHaveBeenCalledTimes(1);
    expect(onLink).toHaveBeenCalledWith(REVIEWER_CREDS);
    expect(onConnect).toHaveBeenCalledWith('reviewer-pc');
    expect(screen.queryByTestId('pc-connect-landing')).toBeNull();
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
      getReviewerCredentials: async () => REVIEWER_CREDS,
    });

    await waitFor(() => expect(screen.getByTestId('pc-connect-landing')).toBeTruthy());
    expect(onConnect).toHaveBeenCalledWith('reviewer-pc');
  });

  it('a connected PC short-circuits BEFORE the reviewer check', async () => {
    const getReviewerCredentials = jest.fn(async () => null);

    renderHost({
      getConnectedPcId: async () => 'pc-1',
      getE2eKey: async () => 'psk-base64',
      onConnect: async () => true,
      onLink: async () => {},
      getReviewerCredentials,
    });

    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeTruthy());
    expect(getReviewerCredentials).not.toHaveBeenCalled();
  });
});

describe('PcConnectGateHost — a scan that decodes but fails to link/connect', () => {
  async function openCamera() {
    await waitFor(() => expect(screen.getByTestId('pc-connect-landing')).toBeTruthy());
    fireEvent.press(screen.getByTestId('pc-connect-landing-scan'));
    await waitFor(() => expect(mockOnScan).toBeDefined());
  }

  it('onConnect resolves false → shows the error screen (not a stuck scanner)', async () => {
    const onConnect = jest.fn(async () => false);
    renderHost({ getConnectedPcId: async () => null, onConnect, onLink: async () => {} });

    await openCamera();
    act(() => mockOnScan!(VALID_QR));

    await waitFor(() => expect(screen.getByTestId('pc-connect-error')).toBeTruthy());
    expect(onConnect).toHaveBeenCalledWith('pc_charlie');
    expect(screen.queryByTestId('qr-camera-stub')).toBeNull();
  });

  it('onLink rejects → shows the error screen', async () => {
    const onConnect = jest.fn(async () => true);
    renderHost({
      getConnectedPcId: async () => null,
      onConnect,
      onLink: async () => {
        throw new Error('secure-store write failed');
      },
    });

    await openCamera();
    act(() => mockOnScan!(VALID_QR));

    await waitFor(() => expect(screen.getByTestId('pc-connect-error')).toBeTruthy());
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('"Try again" on the error screen returns to the connect landing for a fresh scan', async () => {
    renderHost({
      getConnectedPcId: async () => null,
      onConnect: async () => false,
      onLink: async () => {},
    });

    await openCamera();
    act(() => mockOnScan!(VALID_QR));
    await waitFor(() => expect(screen.getByTestId('pc-connect-error')).toBeTruthy());

    fireEvent.press(screen.getByTestId('pc-connect-error-retry'));

    await waitFor(() => expect(screen.getByTestId('pc-connect-landing')).toBeTruthy());
    expect(screen.queryByTestId('pc-connect-error')).toBeNull();
  });
});
