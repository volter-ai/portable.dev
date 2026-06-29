/**
 * Smoke test for the Expo Router root.
 *
 * The authenticated tree now lives behind the `(app)` route GROUP, whose
 * `(app)/_layout` mounts the {@link AppShell} gate ladder; the root `<Stack>` is
 * mounted unconditionally and only ever renders the public `sign-in` route or the
 * `(app)` group (never a tab screen directly). With no persisted credentials the
 * `(app)` StartupGate redirects to `/sign-in`. This file asserts:
 *   (1) the app entry mounts + redirects to sign-in through the `(app)` ladder;
 *   (2) the `/sign-in → /` transition stays gated — the regression guard for the
 *       previous conditional-root-navigator race that rendered `ChatComposer`
 *       outside `<ApiProvider>`;
 *   (3) a `@vgit2/shared` import resolves at runtime — proving the `workspace:*`
 *       link + Metro `watchFolders` wiring still work.
 *
 * The real `@clerk/clerk-expo` import leaves async handles open and hangs the
 * runner, so it is mocked to a passthrough provider + a stub `useAuth` (the shell
 * recovery layer reads `getToken`). The shell's transitive import graph pulls the
 * MMKV / socket / SecureStore / NetInfo native modules, so those are mocked too.
 */

jest.mock('@clerk/clerk-expo', () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({ getToken: async () => null }),
}));

jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});

jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (key: string, value: string | number | boolean) => store.set(key, String(value)),
    getString: (key: string) => (store.has(key) ? store.get(key) : undefined),
    remove: (key: string) => store.delete(key),
    contains: (key: string) => store.has(key),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    getItemAsync: jest.fn(async (k: string) => (store.has(k) ? (store.get(k) as string) : null)),
    deleteItemAsync: jest.fn(async (k: string) => {
      store.delete(k);
    }),
  };
});

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: () => () => {}, fetch: async () => ({ isConnected: true }) },
}));

import React from 'react';
import { fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter, screen } from 'expo-router/testing-library';
import { Pressable, Text, View } from 'react-native';
// Resolved through the `workspace:*` link to @vgit2/shared (RN-safe constants).
import { TUNNEL_LOADING_DURATION_MS } from '@vgit2/shared/browserConstants';

import RootLayout from '../app/_layout';
import AppGroupLayout from '../app/(app)/_layout';

/**
 * Mirrors the production tree: the public `sign-in` route is a SIBLING of the
 * authenticated `(app)` GROUP, whose real `(app)/_layout` mounts the `AppShell`
 * gate ladder. `(app)/index` is the authenticated entry that must NEVER render
 * for a credential-less user (the StartupGate redirects it to sign-in).
 */
function routes() {
  return {
    _layout: RootLayout,
    '(app)/_layout': AppGroupLayout,
    '(app)/index': () => (
      <View testID="app-index-marker">
        <Text>Home</Text>
      </View>
    ),
    'sign-in': () => (
      <View testID="sign-in-marker">
        <Text>Sign in</Text>
        {/* Mirrors app/sign-in.tsx's post-exchange `router.replace('/')`. */}
        <Pressable testID="go-home" onPress={() => router.replace('/')}>
          <Text>Go home</Text>
        </Pressable>
      </View>
    ),
  };
}

describe('Expo Router root', () => {
  // The new VersionGate (the outermost AppShell gate) fetches GET /api/min-version-v2
  // on mount. This file mounts the REAL `(app)/_layout` (the real AppShell, no
  // injected version dep), so stub global.fetch to return a low minimum → the gate
  // resolves "ok" on the first attempt (no real network, no retry timers) and the
  // ladder proceeds to the sign-in redirect.
  const realFetch = global.fetch;
  beforeAll(() => {
    (global as { fetch: typeof fetch }).fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ minimumVersion: '0.0.0' }),
        text: async () => '{"minimumVersion":"0.0.0"}',
      }) as unknown as Response) as unknown as typeof fetch;
  });
  afterAll(() => {
    (global as { fetch: typeof fetch }).fetch = realFetch;
  });

  it('mounts the gated app entry and redirects to sign-in (no credentials)', async () => {
    renderRouter(routes(), { initialUrl: '/' });

    // (1) App entry mounted + the `(app)` gate ladder redirected to sign-in;
    //     the authenticated entry never rendered.
    expect(await screen.findByTestId('sign-in-marker')).toBeTruthy();
    expect(screen.queryByTestId('app-index-marker')).toBeNull();

    // (3) The @vgit2/shared import resolved at runtime (browser-safe default = 500ms).
    expect(TUNNEL_LOADING_DURATION_MS).toBe(500);
  });

  // (2) Regression guard: `/` is ALWAYS routed through `(app)/_layout` (the gate
  // ladder), even on the `/sign-in → /` transition the real sign-in screen drives.
  // The previous conditional-root-navigator pattern let the bare (sign-in-branch)
  // `<Stack>` render `/` directly, mounting `ChatComposer` outside `<ApiProvider>`
  // ("useApi() must be used within an <ApiProvider>"). Here a credential-less user
  // is redirected straight back to sign-in and `(app)/index` never renders.
  it('keeps `/` gated on the sign-in → / transition (no leaked authenticated screen)', async () => {
    renderRouter(routes(), { initialUrl: '/sign-in' });

    // Public sign-in route renders with no gate.
    expect(await screen.findByTestId('sign-in-marker')).toBeTruthy();

    // Navigate to `/` exactly the way the real sign-in screen does after exchange.
    fireEvent.press(screen.getByTestId('go-home'));

    // Gated back to sign-in through `(app)/_layout`; the authenticated entry never leaked.
    expect(await screen.findByTestId('sign-in-marker')).toBeTruthy();
    expect(screen.queryByTestId('app-index-marker')).toBeNull();
  });
});
