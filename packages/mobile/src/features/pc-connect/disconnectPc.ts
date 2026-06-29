/**
 * disconnectPc — forget this device's PC pairing and return to the QR scanner.
 *
 * The Runtime tab's "Disconnect" action calls this. It is the inverse of a connect
 * ({@link connectToPc}):
 *
 *   1. CLEAR the stored credentials — the connected pcId (the relay routing key) and
 *      that PC's per-PC data-path JWT (the scanned QR's token) — so the device no
 *      longer auto-reconnects and MUST scan a (new) QR to pair again.
 *   2. CLEAR the legacy sandbox URL too (parity with `requestReprovision`; a no-op
 *      here, where it is never set).
 *   3. SIGNAL {@link usePcConnectionStore} so `PcConnectGateHost` flips back to the
 *      scanner — that is what "moves the user to the connection page again".
 *
 * Steps 1+2 are the reusable {@link clearPcPairing} core (used WITHOUT the signal by
 * the "Can't reach your PC" recovery re-scan, so a fresh scan can never keep reusing
 * the stale, rejected credentials); `disconnectPc` is that core PLUS the gate signal.
 *
 * Clear-BEFORE-signal is deliberate: the gate renders the scanner regardless, but
 * clearing first guarantees that an immediate re-scan (which calls `saveConnectedPcId`)
 * can never be wiped by a late-arriving clear. Every step is best-effort (never
 * throws) — the UI must return to the connection page even if a keychain delete
 * fails. All I/O is injectable for tests.
 */

import { clearConnectedPcId, getConnectedPcId } from './connectedPcStore';
import { clearDeviceToken } from './deviceTokenStore';
import { usePcConnectionStore } from './pcConnectionStore';

/**
 * Clear the legacy sandbox URL via a LAZY require (the `sandboxSessionStore`
 * pattern): keep `../api/relayUrlStore` — and its `gatewayConfig` → `devModeStore`
 * (MMKV) graph — out of `disconnectPc`'s STATIC import graph, so the Runtime screen
 * can pull this helper in by file without dragging that graph along.
 */
function clearLegacySandboxUrl(): Promise<void> {
  try {
    const { clearRelayUrl } =
      require('../api/relayUrlStore') as typeof import('../api/relayUrlStore');
    return clearRelayUrl();
  } catch {
    // The legacy URL is a dead fallback — never block disconnect on it.
    return Promise.resolve();
  }
}

export interface ClearPcPairingDeps {
  /** Read the currently-connected pcId. Default: {@link getConnectedPcId}. */
  getPcId?: () => Promise<string | null>;
  /** Drop the per-PC data-path JWT. Default: {@link clearDeviceToken}. */
  clearToken?: (pcId: string) => Promise<void>;
  /** Drop the connected pcId (the relay routing key). Default: {@link clearConnectedPcId}. */
  clearPcId?: () => Promise<void>;
  /** Drop the legacy sandbox URL. Default: lazy `clearRelayUrl`. */
  clearLegacyUrl?: () => Promise<void>;
}

export interface DisconnectPcDeps extends ClearPcPairingDeps {
  /** Signal the PC-connect gate back to the scanner. Default: the store action. */
  signal?: () => void;
}

/**
 * Wipe the stored PC pairing — the currently-connected PC's data-path JWT, the
 * connected pcId (the relay routing key), and the legacy sandbox URL — WITHOUT
 * signalling the connect gate.
 *
 * This is the credential-clearing half of {@link disconnectPc}, exposed on its own so
 * the "Can't reach your PC" recovery can drop the stale, rejected pairing as part of a
 * re-scan (the app must never keep reusing invalid credentials) while STAYING on the
 * scanner — there is no "return to the connection landing" yet, that is the explicit
 * disconnect/cancel. Each step is isolated + best-effort; never throws.
 */
export async function clearPcPairing(deps: ClearPcPairingDeps = {}): Promise<void> {
  const getPcId = deps.getPcId ?? getConnectedPcId;
  const clearToken = deps.clearToken ?? clearDeviceToken;
  const clearPcId = deps.clearPcId ?? clearConnectedPcId;
  const clearLegacyUrl = deps.clearLegacyUrl ?? clearLegacySandboxUrl;

  // 1. Drop the per-PC JWT for the currently-connected PC (best-effort).
  try {
    const pcId = await getPcId();
    if (pcId) await clearToken(pcId);
  } catch {
    /* never block on a keychain read/delete */
  }
  // 2. Drop the routing key + the legacy URL (each isolated).
  try {
    await clearPcId();
  } catch {
    /* ignore */
  }
  try {
    await clearLegacyUrl();
  } catch {
    /* ignore */
  }
}

/**
 * Forget the current PC pairing (token + pcId + legacy URL), then signal the
 * PC-connect gate back to the QR scanner. Best-effort; never throws.
 */
export async function disconnectPc(deps: DisconnectPcDeps = {}): Promise<void> {
  const signal = deps.signal ?? (() => usePcConnectionStore.getState().signalDisconnected());
  // 1+2. Clear the stored credentials (the reusable core).
  await clearPcPairing(deps);
  // 3. Return to the scanner (clear-BEFORE-signal — see the file docstring).
  signal();
}
