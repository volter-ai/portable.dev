/**
 * Dev-mode Sentry test page.
 *
 * Reachable ONLY from the settings root while the hidden 10-tap dev mode
 * is on (the entry is gated in `SettingsScreen`); the route itself
 * (`/settings/sentry-test`) stays registered but unsurfaced otherwise. Confirm
 * Sentry is live on a real device build by
 * firing each error class and watching it land in the Sentry dashboard.
 *
 * testIDs: `sentry-test-screen` (root), `sentry-test-active`, `sentry-test-runtime`,
 * `sentry-test-throw`, `sentry-test-render`, `sentry-test-render-reset`,
 * `sentry-test-capture`, `sentry-test-status`.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppTheme, withAlpha } from '../../theme';
import { SettingsSectionScreen, SettingsCard, SectionLabel } from '../settings/chrome';
import { SentryErrorBoundary } from './sentryErrorBoundary';
import { useSentryTest, type SentryTestDeps } from './useSentryTest';

/** Throws during render when `armed` — so a React ErrorBoundary (NOT a global
 * handler) is what catches it. Renders nothing otherwise. */
function RenderBomb({ armed }: { armed: boolean }) {
  if (armed) {
    throw new Error(
      `[Sentry Test] Render error caught by ErrorBoundary @ ${new Date().toISOString()}`
    );
  }
  return null;
}

export function SentryTestScreen(props: SentryTestDeps = {}) {
  const { theme } = useAppTheme();
  const vm = useSentryTest(props);

  const buttonStyle = [
    styles.button,
    { borderColor: theme.colors.primary, backgroundColor: withAlpha(theme.colors.primary, '14') },
  ];
  const buttonTextStyle = [styles.buttonText, { color: theme.colors.primary }];

  return (
    <SettingsSectionScreen title="Sentry Test" testID="sentry-test-screen">
      {/* Active-client status */}
      <SettingsCard>
        <View style={styles.statusRow}>
          <View
            style={[
              styles.dot,
              {
                backgroundColor: vm.sentryActive ? theme.colors.success : theme.colors.textTertiary,
              },
            ]}
          />
          <Text
            style={[styles.statusText, { color: theme.colors.textSecondary }]}
            testID="sentry-test-active"
          >
            Sentry client: {vm.sentryActive ? 'active' : 'inactive (no-op — DSN unset)'}
          </Text>
        </View>
        <Text
          style={[styles.runtime, { color: theme.colors.textTertiary }]}
          testID="sentry-test-runtime"
        >
          {vm.runtimeLabel}
        </Text>
      </SettingsCard>

      {/* 1. Uncaught async error */}
      <SectionLabel>1. Throw uncaught error</SectionLabel>
      <SettingsCard>
        <Text style={[styles.desc, { color: theme.colors.textTertiary }]}>
          Async throw → the RN global error handler → Sentry.
        </Text>
        <Pressable
          style={buttonStyle}
          accessibilityRole="button"
          onPress={vm.throwUncaught}
          testID="sentry-test-throw"
        >
          <Text style={buttonTextStyle}>Throw uncaught error</Text>
        </Pressable>
      </SettingsCard>

      {/* 2. Render error caught by a scoped ErrorBoundary */}
      <SectionLabel>2. Render error → ErrorBoundary → Sentry</SectionLabel>
      <SettingsCard>
        <Text style={[styles.desc, { color: theme.colors.textTertiary }]}>
          A child throws during render; a scoped Sentry.ErrorBoundary catches it and auto-reports.
        </Text>
        <SentryErrorBoundary
          onError={(_error, _componentStack, eventId) => vm.onBombCaught(eventId)}
          fallback={({ resetError }) => (
            <View style={styles.fallback}>
              <Text style={[styles.caught, { color: theme.colors.success }]}>
                ✅ Caught by ErrorBoundary &amp; reported to Sentry.
              </Text>
              <Pressable
                style={buttonStyle}
                accessibilityRole="button"
                onPress={() => {
                  vm.resetBomb();
                  resetError();
                }}
                testID="sentry-test-render-reset"
              >
                <Text style={buttonTextStyle}>Reset</Text>
              </Pressable>
            </View>
          )}
        >
          <RenderBomb armed={vm.bombArmed} />
          <Pressable
            style={buttonStyle}
            accessibilityRole="button"
            onPress={vm.armBomb}
            testID="sentry-test-render"
          >
            <Text style={buttonTextStyle}>Trigger render error</Text>
          </Pressable>
        </SentryErrorBoundary>
      </SettingsCard>

      {/* 3. Manual capture */}
      <SectionLabel>3. Manual captureException</SectionLabel>
      <SettingsCard>
        <Text style={[styles.desc, { color: theme.colors.textTertiary }]}>
          Explicit Sentry.captureException — the most direct check.
        </Text>
        <Pressable
          style={buttonStyle}
          accessibilityRole="button"
          onPress={vm.captureManually}
          testID="sentry-test-capture"
        >
          <Text style={buttonTextStyle}>Capture exception</Text>
        </Pressable>
      </SettingsCard>

      {/* Status line */}
      <Text
        style={[
          styles.status,
          { color: theme.colors.textSecondary, backgroundColor: theme.colors.surface },
        ]}
        testID="sentry-test-status"
      >
        {vm.status}
      </Text>
    </SettingsSectionScreen>
  );
}

const styles = StyleSheet.create({
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 13, fontWeight: '600', flex: 1 },
  runtime: { fontSize: 11, marginTop: 6, fontFamily: 'monospace' },
  desc: { fontSize: 12, lineHeight: 17, marginBottom: 8 },
  button: {
    width: '100%',
    paddingVertical: 11,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  buttonText: { fontSize: 13, fontWeight: '600' },
  fallback: { gap: 8 },
  caught: { fontSize: 12, fontWeight: '600' },
  status: {
    marginTop: 12,
    fontSize: 11,
    fontFamily: 'monospace',
    padding: 10,
    borderRadius: 8,
    overflow: 'hidden',
  },
});
