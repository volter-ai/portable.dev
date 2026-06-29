/**
 * ConnectionFailedScreen — the terminal native ConnectionFailed UX.
 *
 * Shown when automatic recovery has been exhausted (3 retries in a 5-minute window
 * — see {@link RecoveryLoopGuard} / `useSandboxDeathHandler`). The app-shell's
 * `SandboxSessionBoundary` renders it IN PLACE of the authenticated subtree (the
 * dead socket unmounts with it).
 *
 * The copy distinguishes the two failure modes from the live NetInfo state:
 *   - `offline`      → "You're offline" (it's the device, not the PC).
 *   - `pc-down` → "Can't reach your PC" (the PC is unreachable via the relay).
 *
 * It is the DURABLE dead-end, so it owns the two exits:
 *   - "Try again" → the death handler's `retry` (reset the window + re-check the
 *     same relay endpoint).
 *   - "Connect PC" (pc-down only) → opens the {@link PcConnectModal} re-scan
 *     flow; a successful re-pair fires `onTryAgain` to re-enter the app. This is the
 *     escape hatch for the boot-stuck case (a lapsed gateway registration / a token
 *     rejected by the PC), since the "Connect PC" buttons on Home/Repos/Settings sit
 *     BELOW this gate and are unreachable while it is showing. (Offline has no
 *     "Connect PC" — re-scanning needs the network.)
 *
 * STALE-CREDENTIAL CLEANUP (the "stuck on invalid credentials" fix): when the PC is
 * unreachable because the stored pairing is REJECTED (the launcher restarted with a
 * different `JWT_SECRET`, the gateway registration lapsed, …), reusing it loops
 * forever — "Try again" re-checks the SAME dead pairing, and bouncing out of the
 * re-scan left the bad credentials in place. So the recovery flow drops them:
 *   - RE-SCANNING clears the stale pairing FIRST ({@link clearPcPairing}) then saves
 *     the fresh QR's JWT, so the app can never keep reusing the invalid credentials.
 *   - CANCELLING the re-scan does a full {@link disconnectPc} — clears the pairing AND
 *     signals the gate back to the "Connect your PC" landing, instead of returning to
 *     this same dead screen with the same bad credentials.
 *
 * Near-presentational: it reads no store; the only local state is the re-scan
 * modal's open flag, so it still renders deterministically under RNTL. The two
 * cleanup actions are injectable seams (`pcConnect.link` / `onDisconnect`).
 */

import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { QrLinkPayload } from '@vgit2/shared/types';

import { Icon, useAppTheme } from '../../theme';
import { saveDeviceToken } from '../pc-connect/deviceTokenStore';
import { clearPcPairing, disconnectPc } from '../pc-connect/disconnectPc';
import { PcConnectModal, type PcConnectModalProps } from '../pc-connect/PcConnectModal';

import type { ConnectionFailedReason } from './connectionFailedStore';

export interface ConnectionFailedScreenProps {
  /** Failure reason — selects the copy. */
  reason: ConnectionFailedReason;
  /** The "Try again" action (resets the guard + re-checks the relay). Also fired
   * after a successful "Connect PC" re-pair to re-enter the app. */
  onTryAgain: () => void;
  /** Whether the re-check / recovery is in flight (disables the buttons + spins). */
  retrying?: boolean;
  /** Seams forwarded to the "Connect PC" re-scan modal (tests inject fakes). */
  pcConnect?: Pick<PcConnectModalProps, 'link' | 'connect' | 'renderScanner'>;
  /**
   * Seam: drop the stale pairing AND return to the connect landing when the user
   * cancels the re-scan (gives up on this PC). Default: {@link disconnectPc} (clears
   * the connected pcId + its rejected JWT, then signals `PcConnectGateHost`).
   */
  onDisconnect?: () => void;
}

const COPY: Record<ConnectionFailedReason, { title: string; body: string }> = {
  offline: {
    title: "You're offline",
    body: "We can't reach your PC because your device is offline. Check your connection and try again.",
  },
  'pc-down': {
    title: "Can't reach your PC",
    body: 'Your PC is unreachable right now — make sure `portable start` is running on it. Tap "Try again" to reconnect, or "Connect PC" to scan the pairing QR again.',
  },
};

export function ConnectionFailedScreen({
  reason,
  onTryAgain,
  retrying = false,
  pcConnect,
  onDisconnect,
}: ConnectionFailedScreenProps) {
  const { title, body } = COPY[reason];
  const { theme } = useAppTheme();
  const [connectPcOpen, setConnectPcOpen] = useState(false);

  // Cancel = give up on this (dead) PC: drop the stale pairing AND return to the
  // connect landing (vs. bouncing back to this same screen with bad credentials).
  const doDisconnect = onDisconnect ?? (() => void disconnectPc());

  // Re-scan from this stuck screen DROPS the stale, rejected pairing first, then
  // saves the fresh QR's JWT — so "scanning again" can never keep reusing the
  // invalid credentials. (Tests inject `pcConnect.link` to bypass the real clear.)
  const linkClearingStale = async (payload: QrLinkPayload) => {
    await clearPcPairing();
    await saveDeviceToken(payload.pcId, payload.token);
  };

  return (
    <View
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      testID="connection-failed-screen"
    >
      <View style={styles.iconWrap}>
        <Icon name="warning" size={44} color={theme.colors.warning} />
      </View>
      <Text style={[styles.title, { color: theme.colors.text }]} testID="connection-failed-title">
        {title}
      </Text>
      <Text
        style={[styles.body, { color: theme.colors.textSecondary }]}
        testID="connection-failed-body"
      >
        {body}
      </Text>

      <Pressable
        testID="connection-failed-try-again"
        accessibilityRole="button"
        style={[
          styles.button,
          { backgroundColor: theme.colors.primary },
          retrying && styles.buttonDisabled,
        ]}
        disabled={retrying}
        onPress={onTryAgain}
      >
        <Text style={[styles.buttonText, { color: theme.colors.textInverse }]}>Try again</Text>
      </Pressable>

      {reason === 'pc-down' && (
        <Pressable
          testID="connection-failed-connect-pc"
          accessibilityRole="button"
          style={[
            styles.secondaryButton,
            { borderColor: theme.colors.primary },
            retrying && styles.buttonDisabled,
          ]}
          disabled={retrying}
          onPress={() => setConnectPcOpen(true)}
        >
          <Text style={[styles.secondaryText, { color: theme.colors.primary }]}>Connect PC</Text>
        </Pressable>
      )}

      {retrying && (
        <ActivityIndicator
          testID="connection-failed-retrying"
          color={theme.colors.primary}
          style={styles.spinner}
        />
      )}

      <PcConnectModal
        visible={connectPcOpen}
        link={pcConnect?.link ?? linkClearingStale}
        connect={pcConnect?.connect}
        renderScanner={pcConnect?.renderScanner}
        onConnected={() => {
          // Re-paired → re-enter the app (reset the guard + re-check the relay).
          setConnectPcOpen(false);
          onTryAgain();
        }}
        onCancel={() => {
          // Gave up on the re-scan → forget the dead pairing + return to the
          // connect landing (the gate above this screen flips on the disconnect
          // signal), instead of bouncing back here with the same bad credentials.
          setConnectPcOpen(false);
          doDisconnect();
        }}
        onDismiss={() => setConnectPcOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  iconWrap: { marginBottom: 4 },
  title: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 15, textAlign: 'center', marginBottom: 8 },
  button: {
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  secondaryButton: {
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  secondaryText: { fontSize: 15, fontWeight: '600' },
  buttonDisabled: { opacity: 0.5 },
  spinner: { marginTop: 4 },
});
