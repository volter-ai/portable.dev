/**
 * rev6 QR pairing — QR-connect gate (RNTL).
 *
 * Covers the device-deferred gate's Jest-testable surface (the live camera scan
 * is the deferred on-device pass; `expo-camera` is lazily loaded so it never
 * enters this graph). rev6 makes connection QR-ONLY — the `/my-pcs` picker is
 * dropped (D19), so the gate goes straight to the scanner (scan-ONLY — there is no
 * manual-entry field; the camera reader is mocked here, the real scan is the
 * deferred on-device pass):
 *
 *   - parseQrPayload: valid JSON `{ gatewayBase, pcId, token }` → payload;
 *     malformed / missing-field / bad-base → null.
 *   - QRScannerGate: a valid scanned payload → `onPayload`; a malformed one →
 *     `qr-scanner-error` + `qr-scanner-retry`.
 *   - PcConnectGate: a valid scanned QR → `onLink` (save the JWT) → `onConnected`.
 */

// useAppTheme → themeStore → MMKV (native nitro module): in-memory mock.
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

// In-memory keychain for deviceTokenStore (expo-secure-store).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    getItemAsync: jest.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
    deleteItemAsync: jest.fn(async (k: string) => void store.delete(k)),
  };
});

// The live camera is DEVICE-ONLY (expo-camera). Mock the lazily-loaded reader so the
// test can drive a "scan" by invoking the captured `onScan` with a raw QR string — the
// real camera scan is the deferred on-device pass.
let mockOnScan: ((raw: string) => void) | undefined;
let mockOnClose: (() => void) | undefined;
jest.mock('../src/features/pc-connect/QrCameraScanner', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: ({ onScan, onClose }: { onScan: (raw: string) => void; onClose: () => void }) => {
      mockOnScan = onScan;
      mockOnClose = onClose;
      return React.createElement(View, { testID: 'qr-camera' });
    },
  };
});

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

import { PcConnectGate, QRScannerGate, parseQrPayload } from '../src/features/pc-connect';

const VALID_QR = JSON.stringify({
  gatewayBase: 'https://app.portable.dev',
  pcId: 'pc_charlie',
  token: 'pc-minted-jwt',
  e2eKey: 'psk-base64',
});

describe('parseQrPayload', () => {
  it('parses a well-formed payload', () => {
    expect(parseQrPayload(VALID_QR)).toEqual({
      gatewayBase: 'https://app.portable.dev',
      pcId: 'pc_charlie',
      token: 'pc-minted-jwt',
      e2eKey: 'psk-base64',
    });
  });

  it('rejects a pre-E2E payload without e2eKey (portable.dev#13 hard cutover)', () => {
    expect(
      parseQrPayload(JSON.stringify({ gatewayBase: 'https://x.dev', pcId: 'p', token: 't' }))
    ).toBeNull();
  });

  it('rejects non-JSON', () => {
    expect(parseQrPayload('not json')).toBeNull();
  });

  it('rejects a missing field', () => {
    expect(parseQrPayload(JSON.stringify({ gatewayBase: 'https://x.dev', pcId: 'p' }))).toBeNull();
  });

  it('rejects a non-http gatewayBase', () => {
    expect(
      parseQrPayload(JSON.stringify({ gatewayBase: 'ftp://x', pcId: 'p', token: 't', e2eKey: 'k' }))
    ).toBeNull();
  });

  it('rejects an empty token', () => {
    expect(
      parseQrPayload(
        JSON.stringify({ gatewayBase: 'https://x.dev', pcId: 'p', token: '', e2eKey: 'k' })
      )
    ).toBeNull();
  });

  it('rejects empty input', () => {
    expect(parseQrPayload('')).toBeNull();
  });
});

describe('QRScannerGate', () => {
  beforeEach(() => {
    mockOnScan = undefined;
    mockOnClose = undefined;
  });

  it('hands a valid scanned payload up via onPayload', async () => {
    const onPayload = jest.fn();
    const { findByTestId } = render(<QRScannerGate onPayload={onPayload} onCancel={jest.fn()} />);
    await findByTestId('qr-camera'); // lazy camera resolved
    act(() => mockOnScan!(VALID_QR));
    expect(onPayload).toHaveBeenCalledWith({
      gatewayBase: 'https://app.portable.dev',
      pcId: 'pc_charlie',
      token: 'pc-minted-jwt',
      e2eKey: 'psk-base64',
    });
  });

  it('shows error + retry for a malformed scan and never calls onPayload', async () => {
    const onPayload = jest.fn();
    const { findByTestId, getByTestId, queryByTestId } = render(
      <QRScannerGate onPayload={onPayload} onCancel={jest.fn()} />
    );
    await findByTestId('qr-camera');
    act(() => mockOnScan!('garbage'));
    expect(onPayload).not.toHaveBeenCalled();
    expect(getByTestId('qr-scanner-error')).toBeTruthy();
    // retry clears the error and returns to the camera
    fireEvent.press(getByTestId('qr-scanner-retry'));
    expect(queryByTestId('qr-scanner-error')).toBeNull();
    await findByTestId('qr-camera');
  });

  it('cancelling the camera invokes onCancel', async () => {
    const onCancel = jest.fn();
    const { findByTestId } = render(<QRScannerGate onPayload={jest.fn()} onCancel={onCancel} />);
    await findByTestId('qr-camera');
    act(() => mockOnClose!());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('PcConnectGate', () => {
  beforeEach(() => {
    mockOnScan = undefined;
  });

  it('lands on the connect intro first; tapping Scan opens the camera, then links + connects (rev6)', async () => {
    const onLink = jest.fn().mockResolvedValue(undefined);
    const onConnected = jest.fn();
    const { getByTestId, queryByTestId, findByTestId } = render(
      <PcConnectGate onLink={onLink} onConnected={onConnected} />
    );

    // Landing-first: the "Connect your PC" intro shows; the camera is NOT mounted yet.
    expect(getByTestId('pc-connect-landing')).toBeTruthy();
    expect(queryByTestId('qr-camera')).toBeNull();

    // Tap "Scan QR code" → the live camera opens.
    fireEvent.press(getByTestId('pc-connect-landing-scan'));
    await findByTestId('qr-camera');

    act(() => mockOnScan!(VALID_QR));
    await waitFor(() =>
      expect(onLink).toHaveBeenCalledWith({
        gatewayBase: 'https://app.portable.dev',
        pcId: 'pc_charlie',
        token: 'pc-minted-jwt',
        e2eKey: 'psk-base64',
      })
    );
    // After the JWT is saved, the host is told to connect this pcId.
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith('pc_charlie'));
  });

  it('the landing exposes a tappable GitHub link that opens the repo', () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const { getByTestId } = render(<PcConnectGate onLink={jest.fn()} onConnected={jest.fn()} />);
    fireEvent.press(getByTestId('pc-connect-landing-github'));
    expect(openURL).toHaveBeenCalledWith('https://github.com/volter-ai/portable.dev/');
    openURL.mockRestore();
  });
});
