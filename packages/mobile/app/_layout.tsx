import * as Sentry from '@sentry/react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ClerkAuthProvider } from '@/features/auth/ClerkAuthProvider';
import { AppErrorBoundary } from '@/features/observability/AppErrorBoundary';
import { initSentry } from '@/features/observability/initSentry';

// Initialize Sentry at module load, BEFORE any render (the web/Capacitor pattern).
// No-op in plain `expo start` dev (no DSN resolves); active in release/test builds.
initSentry();

/**
 * Root layout for the Expo Router app (US-008 app-shell composition, hardened).
 *
 * `ClerkAuthProvider` (Expo) wraps the whole tree so every screen can use the
 * native Clerk auth hooks. The root `<Stack>` is mounted UNCONDITIONALLY and owns
 * three top-level entries (the two public auth screens never render an
 * authenticated screen, so they stay OUTSIDE the gate ladder):
 *
 *   - `sign-in`             — the public Clerk sign-in route (rendered WITHOUT the
 *     gate ladder, so the StartupGate's redirect-to-sign-in resolves without a loop).
 *   - `sso-callback`        — the Clerk native-SSO auth-session callback target: a
 *     branded loading screen that gives Expo Router a valid screen during the OAuth
 *     handshake so the Android deep-link redirect doesn't flash the "Unmatched
 *     Route" screen. See `app/sso-callback.tsx`.
 *   - `(app)`               — the authenticated route GROUP, whose `(app)/_layout`
 *     mounts the {@link AppShell} gate ladder around the tabs + detail stacks.
 *
 * Keeping the root navigator stable and delegating ALL authenticated routes to the
 * `(app)` group — instead of conditionally rendering `<AppShell><Stack/></AppShell>`
 * vs a bare `<Stack/>` based on `useSegments()` — is what guarantees an
 * authenticated screen is never rendered outside the providers. The previous
 * conditional pattern let the bare (sign-in-branch) `<Stack>` momentarily render
 * the `/` route during the `/sign-in → /` transition, mounting `ChatComposer`
 * outside `<ApiProvider>` and crashing with `useApi() must be used within an
 * <ApiProvider>`. The root Stack now only ever renders the public `sign-in` /
 * `sso-callback` screens or the `(app)` layout (which always mounts `AppShell`) —
 * none of which render an authenticated screen outside the providers — so that race
 * cannot occur.
 *
 * Route files stay thin (delegating to `src/features/*`); this layout adds no
 * feature logic to `app/`.
 */
function RootLayout() {
  return (
    <AppErrorBoundary>
      <ClerkAuthProvider>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <SafeAreaProvider>
            <KeyboardProvider navigationBarTranslucent preserveEdgeToEdge>
              <StatusBar style="auto" />
              <Stack screenOptions={{ headerShown: false }} />
            </KeyboardProvider>
          </SafeAreaProvider>
        </GestureHandlerRootView>
      </ClerkAuthProvider>
    </AppErrorBoundary>
  );
}

// `Sentry.wrap` instruments the React root (Expo Router renders the default export
// as the app root) — touch/gesture tracking + the documented attach point for the
// SDK's React-tree instrumentation. Required on the single root component.
export default Sentry.wrap(RootLayout);
