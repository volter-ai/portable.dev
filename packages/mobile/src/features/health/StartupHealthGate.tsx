/**
 * StartupHealthGate — cold-start loading gate (local-first).
 *
 * Wraps the authenticated app on cold launch and shows a LOADING state (never an
 * error) while the relay routes to the PC's backend, driven by
 * {@link useStartupHealthCheck} / {@link useStartupHealthStore}:
 *
 *   - `checking` → full-screen spinner ("Connecting to your PC…").
 *   - `ready`    → render `children` (the app).
 *   - `failed`   → a minimal fallback; the durable recovery + "Connect PC" re-scan
 *                  exit is the `ConnectionFailedScreen` the app-shell routes to via
 *                  `onUnhealthy` (this static screen only flashes before that).
 *
 * The budget is SHORT (~11.5s — it only rides out a cloudflared tunnel rotation,
 * NOT a remote container cold boot, which no longer exists). Mount this ABOVE the
 * screens that need the PC. The check is aborted on unmount (navigate away / sign
 * out) by the hook's cleanup.
 */

import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useStartupHealthCheck, type UseStartupHealthCheckDeps } from './useStartupHealthCheck';
import { LoadingSplash } from '../../components/LoadingSplash';
import { useAppTheme } from '../../theme';

export interface StartupHealthGateProps {
  /** App content rendered once the sandbox is healthy. */
  children: ReactNode;
  /** Injectable check seams (tests; production uses the defaults). */
  deps?: UseStartupHealthCheckDeps;
  /**
   * Fired once when the boot budget is exhausted — the app-shell wires the
   * sandbox-death handler so a never-booting sandbox re-provisions
   * (guard-capped); the static failed render below is the boundary-less
   * fallback (and flashes briefly before the remount).
   */
  onUnhealthy?: () => void;
}

export function StartupHealthGate({ children, deps, onUnhealthy }: StartupHealthGateProps) {
  const { phase } = useStartupHealthCheck(onUnhealthy ? { ...deps, onUnhealthy } : deps);
  const { theme } = useAppTheme();

  if (phase === 'ready') return <>{children}</>;

  if (phase === 'failed') {
    return (
      <View
        style={[styles.container, { backgroundColor: theme.colors.background }]}
        testID="startup-health-failed"
      >
        <Text style={[styles.title, { color: theme.colors.text }]}>
          Couldn&apos;t reach your PC
        </Text>
        <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
          We&apos;ll get you reconnected.
        </Text>
      </View>
    );
  }

  // `checking` — the cold-start loading state (branded splash).
  return (
    <LoadingSplash
      testID="startup-health-loading"
      message="Connecting to your PC…"
      messageTestID="startup-health-loading-text"
    />
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
  title: { fontSize: 18, fontWeight: '600' },
  subtitle: { fontSize: 14 },
});
