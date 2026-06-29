/**
 * rev6 — disconnectPc: forget this device's PC pairing + signal the connection page.
 *
 * Covers the Runtime tab's "Disconnect" action:
 *   - clears the per-PC data-path JWT + the connected pcId + the legacy sandbox URL,
 *     THEN signals the PC-connect gate back to the scanner (clear-BEFORE-signal so an
 *     immediate re-scan can't be wiped by a late clear);
 *   - skips the token clear when no PC is connected;
 *   - is best-effort: a keychain failure still returns to the scanner;
 *   - integration: real SecureStore-backed clears + the real `pcConnectionStore` bump.
 *
 * Imports the FILES (not the pc-connect barrel) so the themed scanner/camera graph
 * never loads. `react-native-mmkv` is mocked because the default `clearLegacyUrl`
 * lazy-requires `relayUrlStore` → `gatewayConfig` → `devModeStore` (MMKV).
 */

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    getItemAsync: jest.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
    deleteItemAsync: jest.fn(async (k: string) => void store.delete(k)),
  };
});

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

import { clearPcPairing, disconnectPc } from '../src/features/pc-connect/disconnectPc';
import { usePcConnectionStore } from '../src/features/pc-connect/pcConnectionStore';
import { getConnectedPcId, saveConnectedPcId } from '../src/features/pc-connect/connectedPcStore';
import { getDeviceToken, saveDeviceToken } from '../src/features/pc-connect/deviceTokenStore';

const secureStore = jest.requireMock('expo-secure-store') as { __store: Map<string, string> };

afterEach(() => {
  secureStore.__store.clear();
  usePcConnectionStore.getState().reset();
});

describe('disconnectPc', () => {
  it('clears the per-PC token + pcId + legacy url, THEN signals disconnect', async () => {
    const getPcId = jest.fn().mockResolvedValue('pc-1');
    const clearToken = jest.fn().mockResolvedValue(undefined);
    const clearPcId = jest.fn().mockResolvedValue(undefined);
    const clearLegacyUrl = jest.fn().mockResolvedValue(undefined);
    const signal = jest.fn();

    await disconnectPc({ getPcId, clearToken, clearPcId, clearLegacyUrl, signal });

    expect(clearToken).toHaveBeenCalledWith('pc-1');
    expect(clearPcId).toHaveBeenCalledTimes(1);
    expect(clearLegacyUrl).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledTimes(1);
    // Clear BEFORE signal: the gate renders the scanner regardless, but clearing the
    // pcId first guarantees an immediate re-scan can't be wiped by a late clear.
    expect(signal.mock.invocationCallOrder[0]).toBeGreaterThan(
      clearPcId.mock.invocationCallOrder[0]
    );
  });

  it('skips the token clear when no PC is connected, but still signals', async () => {
    const clearToken = jest.fn();
    const signal = jest.fn();

    await disconnectPc({
      getPcId: jest.fn().mockResolvedValue(null),
      clearToken,
      clearPcId: jest.fn().mockResolvedValue(undefined),
      clearLegacyUrl: jest.fn().mockResolvedValue(undefined),
      signal,
    });

    expect(clearToken).not.toHaveBeenCalled();
    expect(signal).toHaveBeenCalledTimes(1);
  });

  it('still signals disconnect even if a clear throws (best-effort)', async () => {
    const signal = jest.fn();

    await expect(
      disconnectPc({
        getPcId: jest.fn().mockResolvedValue('pc-1'),
        clearToken: jest.fn().mockRejectedValue(new Error('keychain')),
        clearPcId: jest.fn().mockRejectedValue(new Error('keychain')),
        clearLegacyUrl: jest.fn().mockResolvedValue(undefined),
        signal,
      })
    ).resolves.toBeUndefined();

    expect(signal).toHaveBeenCalledTimes(1);
  });

  it('integration: real clears wipe the stored credentials + bump the store signal', async () => {
    await saveConnectedPcId('pc-1');
    await saveDeviceToken('pc-1', 'jwt-token');
    const before = usePcConnectionStore.getState().disconnectSignal;

    await disconnectPc();

    expect(await getConnectedPcId()).toBeNull();
    expect(await getDeviceToken('pc-1')).toBeNull();
    expect(usePcConnectionStore.getState().disconnectSignal).toBe(before + 1);
  });
});

describe('clearPcPairing (the no-signal core — stale-credential cleanup on re-scan)', () => {
  it('clears the per-PC token + pcId + legacy url, but does NOT signal the gate', async () => {
    await saveConnectedPcId('pc-1');
    await saveDeviceToken('pc-1', 'jwt-token');
    const before = usePcConnectionStore.getState().disconnectSignal;

    await clearPcPairing();

    // Same credential wipe as disconnectPc…
    expect(await getConnectedPcId()).toBeNull();
    expect(await getDeviceToken('pc-1')).toBeNull();
    // …but NO gate signal: the recovery re-scan stays on the scanner (it does not
    // bounce the user back to the connect landing — only an explicit cancel does).
    expect(usePcConnectionStore.getState().disconnectSignal).toBe(before);
  });

  it('skips the token clear when no PC is connected (best-effort, never throws)', async () => {
    const clearToken = jest.fn();

    await expect(
      clearPcPairing({
        getPcId: jest.fn().mockResolvedValue(null),
        clearToken,
        clearPcId: jest.fn().mockResolvedValue(undefined),
        clearLegacyUrl: jest.fn().mockResolvedValue(undefined),
      })
    ).resolves.toBeUndefined();

    expect(clearToken).not.toHaveBeenCalled();
  });
});
