/**
 * App-wide React error boundary for the native app.
 *
 * Wraps the whole tree
 * (mounted OUTSIDE the providers in `app/_layout.tsx`), catches uncaught errors
 * thrown during render anywhere below, reports them to Sentry automatically
 * (`Sentry.ErrorBoundary` calls `captureException` — a no-op when Sentry isn't
 * initialized), and shows a minimal recovery screen instead of a white screen.
 *
 * The fallback uses SELF-CONTAINED static dark styling (no `useAppTheme`): it
 * renders when the app tree has crashed, so it must not depend on the (possibly
 * broken) theme store / providers. Render-phase errors only — event-handler /
 * async / native errors are caught by the SDK's default global handlers.
 */

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SentryErrorBoundary } from './sentryErrorBoundary';

/** Static dark recovery screen — no provider/theme dependency. */
export function ErrorFallback({ resetError }: { error: unknown; resetError: () => void }) {
  return (
    <View style={styles.root} accessibilityRole="alert" testID="app-error-boundary">
      <Text style={styles.emoji}>⚠️</Text>
      <Text style={styles.title}>Something went wrong</Text>
      <Text style={styles.body}>
        The app hit an unexpected error and it has been reported. Try again — this usually fixes it.
      </Text>
      <Pressable
        style={styles.button}
        accessibilityRole="button"
        onPress={resetError}
        testID="app-error-boundary-reset"
      >
        <Text style={styles.buttonText}>Try again</Text>
      </Pressable>
    </View>
  );
}

export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <SentryErrorBoundary fallback={(props) => <ErrorFallback {...props} />}>
      {children}
    </SentryErrorBoundary>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
    // Matches the splash / app background (#1a1a1a).
    backgroundColor: '#1a1a1a',
  },
  emoji: { fontSize: 40, lineHeight: 44 },
  title: { fontSize: 20, fontWeight: '600', color: '#eee', textAlign: 'center' },
  body: {
    fontSize: 14,
    lineHeight: 21,
    color: '#bbb',
    textAlign: 'center',
    maxWidth: 340,
  },
  button: {
    marginTop: 8,
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 12,
    backgroundColor: 'rgba(216, 79, 74, 0.95)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
