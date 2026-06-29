/**
 * SystemWarnings — system warnings + lifecycle routing.
 *
 * Renders the server's `system:*` / `session:expired` lifecycle events (folded
 * into `useSystemWarningsStore` by `useNativeSocket`) as NATIVE modals/banners.
 * Critically, it NEVER navigates via `window.location.href`.
 *
 *   - `system:idle_warning`          → "Are you still there?" modal w/ countdown.
 *                                       "I'm still here" EXTENDS the session
 *                                       (activity ping) and dismisses the modal.
 *   - `system:idle_warning_cleared`  → modal dismissed (store cleared).
 *   - `system:idle_shutdown`         → routes to the re-provision/loading overlay.
 *   - `session:expired`              → routes to the re-provision/loading overlay.
 *
 * `system:shutdown_warning` is deliberately IGNORED on RN (no red "restarting"
 * banner): sandbox death is detected and recovered transparently by the health
 * monitor + recovery layer, so the advisory banner adds nothing here.
 *
 * The re-provision/loading overlay is the lifecycle hand-off to the sandbox
 * death handler: when it appears it invokes `onReprovision` exactly once
 * (the app-shell wires the session boundary's death handler — clear the dead
 * sandbox URL, bump the session epoch, remount through the provisioning gate;
 * the remount resets this store, dropping the overlay). It is rendered HERE
 * (not as a second surface) so the warnings + loading state never double-render.
 *
 * Each surface is conditionally mounted (returns `null` when inactive) so tests
 * can assert presence deterministically with `queryByTestId`.
 */

import { useEffect, useRef } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { extendSession } from './extendSession';
import { useSystemWarningsStore, type SessionEnded } from './systemWarningsStore';
// FILE import (not the health barrel) — avoids a socket ↔ health barrel cycle.
import { useConnectionFailedStore } from '../health/connectionFailedStore';
import { useAppTheme } from '../../theme';

export interface SystemWarningsProps {
  /**
   * Extend the session ("I'm still here"). Default: ping the sandbox activity
   * endpoint. The idle warning is cleared regardless of the result.
   */
  onExtendSession?: () => void | Promise<void>;
  /**
   * Re-provision the sandbox after the session ended (idle shutdown / expiry).
   * Invoked once when the re-provision/loading overlay appears. Default: no-op —
   * the app-shell wires the session boundary's death handler.
   */
  onReprovision?: () => void;
}

/** "Are you still there?" modal with the server-provided countdown. */
function IdleWarningModal({ onExtendSession }: Pick<SystemWarningsProps, 'onExtendSession'>) {
  const idleWarning = useSystemWarningsStore((s) => s.idleWarning);
  const clearIdleWarning = useSystemWarningsStore((s) => s.clearIdleWarning);
  const { theme } = useAppTheme();
  if (!idleWarning) return null;

  // "I'm still here" must EXTEND the session, not just hide the modal. We clear
  // optimistically (the server's follow-up `idle_warning_cleared` is idempotent).
  const handleStillHere = () => {
    void (onExtendSession ?? extendSession)();
    clearIdleWarning();
  };

  return (
    <Modal animationType="fade" transparent visible onRequestClose={clearIdleWarning}>
      <View style={styles.backdrop} testID="system-idle-warning-modal">
        <View style={[styles.card, { backgroundColor: theme.colors.backgroundElevated }]}>
          <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Are you still there?</Text>
          <Text
            style={[styles.cardMessage, { color: theme.colors.textSecondary }]}
            testID="system-idle-warning-message"
          >
            {idleWarning.message}
          </Text>
          {idleWarning.timeRemaining > 0 ? (
            <Text
              style={[styles.cardCountdown, { color: theme.colors.warning }]}
              testID="system-idle-warning-countdown"
            >
              {`${idleWarning.timeRemaining}s remaining`}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={handleStillHere}
            style={[styles.primaryButton, { backgroundColor: theme.colors.primary }]}
            testID="system-idle-warning-dismiss"
          >
            <Text style={[styles.primaryButtonText, { color: theme.colors.textInverse }]}>
              I&apos;m still here
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/**
 * Terminal re-provision/loading overlay: the session is gone (idle shutdown /
 * expiry) so there is nothing to dismiss — we show a loading state and hand off
 * to the recovery layer, invoking `onReprovision` exactly once.
 */
function ReprovisioningOverlay({ onReprovision }: Pick<SystemWarningsProps, 'onReprovision'>) {
  const sessionEnded = useSystemWarningsStore((s) => s.sessionEnded);
  const connectionFailed = useConnectionFailedStore((s) => s.visible);
  const reprovisionedFor = useRef<SessionEnded | null>(null);
  const { theme } = useAppTheme();

  useEffect(() => {
    if (!sessionEnded) {
      reprovisionedFor.current = null;
      return;
    }
    // Fire once per entry into the ended state (don't re-fire on re-render).
    if (reprovisionedFor.current === sessionEnded) return;
    reprovisionedFor.current = sessionEnded;
    onReprovision?.();
  }, [sessionEnded, onReprovision]);

  // The terminal ConnectionFailed state wins: this full-screen Modal would
  // otherwise cover that screen's "Try again" for the one frame between the
  // guard-exhausted `show()` and the boundary unmounting this subtree (the epoch
  // remount replaces the whole tree with the provisioning gate, so there is no
  // in-place "recovery overlay" to yield to anymore).
  if (!sessionEnded || connectionFailed) return null;

  return (
    <Modal animationType="fade" transparent visible>
      <View style={styles.backdrop} testID="system-reprovisioning">
        <View style={[styles.card, { backgroundColor: theme.colors.backgroundElevated }]}>
          <ActivityIndicator color={theme.colors.primary} size="large" />
          <Text style={[styles.cardTitle, { color: theme.colors.text }]}>
            Reconnecting your workspace
          </Text>
          <Text
            style={[styles.cardMessage, { color: theme.colors.textSecondary }]}
            testID="system-reprovisioning-message"
          >
            {sessionEnded.message}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

/**
 * Renders all active system warnings + the lifecycle re-provision overlay. Mount
 * once inside the authenticated tree (the `SocketProvider` renders it so warnings
 * appear wherever the socket lives).
 */
export function SystemWarnings({ onExtendSession, onReprovision }: SystemWarningsProps = {}) {
  return (
    <>
      <IdleWarningModal onExtendSession={onExtendSession} />
      <ReprovisioningOverlay onReprovision={onReprovision} />
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 16,
    padding: 24,
    gap: 12,
    alignItems: 'center',
  },
  cardTitle: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  cardMessage: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  cardCountdown: { fontSize: 14, fontWeight: '600' },
  primaryButton: {
    marginTop: 8,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  primaryButtonText: { fontSize: 15, fontWeight: '600' },
});
