// Run the test bundle in production-like mode. jest-expo defaults `__DEV__` to
// true, which makes Expo's `messageSocket.native` bootstrap open a Metro dev
// websocket at import time (it reads a null `scriptURL` under Jest and crashes
// in `getDevServer`). There is no Metro dev server in tests, so disable dev mode.
globalThis.__DEV__ = false;

// Native module mocks needed under jest (no real native runtime).
require('react-native-gesture-handler/jestSetup');

// NB: react-native-reanimated (used by the chat directory's SwipeableChatRow) is
// mocked via jest.config.js `moduleNameMapper` → src/test/reanimatedMock.js. It
// can't load under jest-expo (its real index inits react-native-worklets native at
// module-load and throws). renderRouter tests need an extra opt-in — see
// src/test/reanimatedMock.js + the per-file note in chat-directory.test.tsx.

jest.mock('expo-video', () => {
  const React = require('react');
  const { View } = require('react-native');

  return {
    useVideoPlayer: jest.fn((_source, setup) => {
      const player = {
        loop: false,
        muted: false,
        play: jest.fn(),
      };
      setup?.(player);
      return player;
    }),
    VideoView: ({ style, testID }) => React.createElement(View, { style, testID }),
  };
});

// expo-image renders the animated whale (`WhaleVideo`); its native `ExpoImage`
// view is absent under jest-expo. Stub `Image` to a plain View that forwards
// style + testID so LoadingSplash / ProjectCreationOverlay render deterministically.
jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Image: ({ style, testID }) => React.createElement(View, { style, testID }),
  };
});

// @sentry/react-native is a native module (RNSentry) absent under jest-expo, and
// `app/_layout.tsx` imports it at module scope (`initSentry` + `Sentry.wrap`), so
// ANY router-root test that mounts `_layout` needs this global stub (#1394). The
// two load-bearing bits: `wrap` MUST return its argument unchanged (so
// `export default Sentry.wrap(RootLayout)` still renders) and `ErrorBoundary` MUST
// render its children. `getClient` is a jest.fn so a test can override its return
// to exercise the active/runtime-info path.
jest.mock('@sentry/react-native', () => {
  return {
    init: jest.fn(),
    wrap: (Component) => Component,
    ErrorBoundary: ({ children }) => children,
    withErrorBoundary: (Component) => Component,
    getClient: jest.fn(() => undefined),
    captureException: jest.fn(() => 'test-event-id'),
    captureMessage: jest.fn(() => 'test-event-id'),
    addBreadcrumb: jest.fn(),
    setUser: jest.fn(),
    setTag: jest.fn(),
    setContext: jest.fn(),
    withScope: jest.fn((cb) => cb({ setTag: jest.fn(), setContext: jest.fn() })),
    flush: jest.fn(async () => true),
    nativeCrash: jest.fn(),
    reactNavigationIntegration: jest.fn(() => ({ registerNavigationContainer: jest.fn() })),
    reactNativeTracingIntegration: jest.fn(() => ({})),
    breadcrumbsIntegration: jest.fn(() => ({})),
    mobileReplayIntegration: jest.fn(() => ({})),
    // Defensive: metro.config.js isn't imported by jest, but keep it stubbed.
    getSentryExpoConfig: jest.fn(() => ({ resolver: {}, transformer: {} })),
  };
});

// expo-notifications is a native module absent under jest-expo (its real
// `getLastNotificationResponse`/`getPermissionsAsync` reach an undefined native
// proxy and throw). Since #1435 the `PushSetupLayer` mounts inside `AppShell`'s
// `ApiProvider` and touches it on mount (deep-link listener + `getPermissionState`),
// so ANY router-root test that renders the full ladder needs this inert stub —
// the expo-video / @sentry/react-native precedent. Defaults: permission
// `undetermined` (so the one-time prompt takes the modal branch, not a silent
// subscribe), a null launching response, and a no-op channel/handler. A test that
// needs to DRIVE these (the push-notification suite) declares its own
// `jest.mock('expo-notifications', …)`, which overrides this global per-file.
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(async () => ({
    granted: false,
    status: 'undetermined',
    canAskAgain: true,
  })),
  requestPermissionsAsync: jest.fn(async () => ({
    granted: true,
    status: 'granted',
    canAskAgain: false,
  })),
  getDevicePushTokenAsync: jest.fn(async () => ({ type: 'ios', data: 'mock-device-token' })),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  AndroidImportance: { MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4, MAX: 5 },
}));

// expo-linking reaches a native proxy under jest-expo. Since #1285 the
// `UtmAttributionSync` layer mounts inside `AppShell`'s `ApiProvider` and touches
// it on mount (`getInitialURL` + `addEventListener('url', …)` to capture campaign
// UTM from the launch deep link), so ANY router-root test that renders the full
// ladder needs this inert stub — the expo-notifications precedent above. Defaults:
// no launch URL, a no-op listener subscription, and benign URL helpers. A test that
// needs to DRIVE deep links (sign-in / github-scope / dev-mode) declares its own
// `jest.mock('expo-linking', …)`, which overrides this global per-file.
jest.mock('expo-linking', () => ({
  getInitialURL: jest.fn(async () => null),
  addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  openURL: jest.fn(async () => {}),
  createURL: jest.fn((path) => `portable://${path}`),
  parse: jest.fn(() => ({ queryParams: {} })),
  useURL: jest.fn(() => null),
}));
// react-native-keyboard-controller is a native module absent under jest-expo.
// `app/_layout.tsx` imports `KeyboardProvider` at module scope (wraps the root
// navigator), so ANY router-root test that mounts `_layout` needs this inert stub.
// The library ships its own jest map at `react-native-keyboard-controller/jest`;
// per-file tests that need a richer surface can re-mock after this global.
jest.mock('react-native-keyboard-controller', () =>
  require('react-native-keyboard-controller/jest')
);

// @react-native-firebase/messaging is a native module absent under jest-expo. It
// is lazy-`require`d by `pushAdapter.getDeviceToken()` — the FCM token source for
// BOTH platforms (the iOS APNs→FCM fix). Tests inject a fake `PushAdapter`, so the
// real module is normally never reached, but a full-ladder render mounts
// `PushSetupLayer` with the DEFAULT adapter, so keep an inert stub for robustness —
// the expo-notifications / @sentry/react-native precedent. The modular API surface
// mirrors @react-native-firebase/messaging@24 (getMessaging/getToken/register…).
jest.mock('@react-native-firebase/messaging', () => {
  const instance = {};
  const messaging = () => instance; // namespaced default export
  return {
    __esModule: true,
    default: messaging,
    getMessaging: jest.fn(() => instance),
    getToken: jest.fn(async () => 'mock-fcm-token'),
    registerDeviceForRemoteMessages: jest.fn(async () => undefined),
    isDeviceRegisteredForRemoteMessages: jest.fn(() => true),
  };
});
