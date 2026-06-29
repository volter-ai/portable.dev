/**
 * Hidden dev mode: 10 taps on the sign-in brand header switch the app to
 * the dev gateway with a red DEV MODE banner + the Clerk email/password form.
 *
 * Covers:
 *   1. Prod mode (default): SSO-only — no banner, no email/password form — and
 *      `getGatewayUrl()` resolves the production gateway.
 *   2. 10 quick taps on the logo: banner + form appear, the store flips, the flag
 *      persists to MMKV (`portable.devMode`), cross-env credentials are cleared,
 *      and `getGatewayUrl()` resolves the dev gateway.
 *   3. 10 more taps: back to prod (banner + form gone, flag persisted false).
 *   4. Slow taps (gaps > the 2s window) never toggle.
 *   5. Restart persistence: a fresh module registry reads the persisted flag.
 *   6. Pure resolvers: gateway-URL + Clerk-key resolution per mode/env.
 */

// Hoisted mocks (must precede the SUT import).
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(),
  openAuthSessionAsync: jest.fn(),
  maybeCompleteAuthSession: jest.fn(),
  warmUpAsync: jest.fn(),
  coolDownAsync: jest.fn(),
  dismissBrowser: jest.fn(),
  dismissAuthSession: jest.fn(),
}));

jest.mock('expo-linking', () => ({
  createURL: jest.fn((path: string) => `portable://app${path}`),
}));

// The ClerkProvider mock RECORDS each mount's publishableKey (the []-deps effect
// fires once per MOUNT, so a key-driven remount appends a second entry while a
// mere re-render does not) — how the remount-on-mode-flip test discriminates.
jest.mock('@clerk/clerk-expo', () => {
  const ReactActual = require('react') as typeof import('react');
  const mounts: string[] = [];
  const ClerkProvider = ({
    publishableKey,
    children,
  }: {
    publishableKey: string;
    children: React.ReactNode;
  }) => {
    ReactActual.useEffect(() => {
      mounts.push(publishableKey);
    }, []);
    return children;
  };
  return {
    __clerkMock: { mounts },
    ClerkProvider,
    useSSO: () => ({ startSSOFlow: jest.fn() }),
    useSignIn: () => ({ isLoaded: true, signIn: { create: jest.fn() }, setActive: jest.fn() }),
    useAuth: () => ({ getToken: jest.fn(), isSignedIn: false, isLoaded: true, signOut: jest.fn() }),
  };
});

// In-memory MMKV (nitro module, unusable in Jest). The backing Map lives OUTSIDE
// the factory (jest allows `mock*`-prefixed references) so `jest.isolateModules`
// re-runs of the factory keep hitting the same storage — the "disk" surviving a
// simulated restart.
const mockMmkvBacking = new Map<string, string>();
jest.mock('react-native-mmkv', () => {
  const instance = {
    set: (key: string, value: string | number | boolean) => mockMmkvBacking.set(key, String(value)),
    getString: (key: string) => (mockMmkvBacking.has(key) ? mockMmkvBacking.get(key) : undefined),
    remove: (key: string) => mockMmkvBacking.delete(key),
    contains: (key: string) => mockMmkvBacking.has(key),
    clearAll: () => mockMmkvBacking.clear(),
  };
  return { __store: mockMmkvBacking, createMMKV: () => instance };
});

// In-memory SecureStore — seeds the cross-env credentials the toggle must clear.
const mockSecureBacking = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  __store: mockSecureBacking,
  getItemAsync: jest.fn(async (key: string) => mockSecureBacking.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureBacking.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockSecureBacking.delete(key);
  }),
}));

import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ClerkAuthProvider } from '../src/features/auth/ClerkAuthProvider';
import { SignInScreen, DEV_MODE_TAP_COUNT } from '../src/features/auth/SignInScreen';
import {
  DEV_GATEWAY_URL,
  PROD_GATEWAY_URL,
  getGatewayUrl,
  resolveGatewayUrl,
} from '../src/features/auth/gatewayConfig';
import {
  getClerkPublishableKey,
  resolveClerkPublishableKey,
} from '../src/features/auth/clerkConfig';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { DEV_MODE_STORAGE_KEY, useDevModeStore } from '../src/features/state/devModeStore';

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function renderScreen() {
  return render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <SignInScreen />
    </SafeAreaProvider>
  );
}

function tapLogo(times: number) {
  const logo = screen.getByTestId('sign-in-logo');
  for (let i = 0; i < times; i++) fireEvent.press(logo);
}

beforeEach(() => {
  mockMmkvBacking.clear();
  mockSecureBacking.clear();
  useDevModeStore.setState({ enabled: false });
});

describe('dev mode on the sign-in screen', () => {
  it('prod mode by default: SSO only, no banner, no email/password form, prod gateway', () => {
    renderScreen();

    expect(screen.queryByTestId('dev-mode-banner')).toBeNull();
    expect(screen.queryByTestId('sign-in-email')).toBeNull();
    expect(screen.queryByTestId('sign-in-password')).toBeNull();
    expect(screen.queryByTestId('sign-in-submit')).toBeNull();
    // SSO is the only sign-in surface.
    expect(screen.getByTestId('sign-in-social-github')).toBeTruthy();
    expect(screen.getByTestId('sign-in-social-google')).toBeTruthy();
    expect(screen.getByTestId('sign-in-social-apple')).toBeTruthy();

    // The live reader consults the (prod) store.
    expect(getGatewayUrl()).toBe(resolveGatewayUrl(false));
  });

  it('10 quick taps on the logo enable dev mode: banner + form + dev gateway + persisted flag', async () => {
    // Credentials persisted by the environment we are leaving.
    mockSecureBacking.set(AUTH_TOKEN_KEY, 'stale-prod-token');
    mockSecureBacking.set(RELAY_URL_KEY, 'https://stale-prod-sandbox.modal.run');

    renderScreen();
    tapLogo(DEV_MODE_TAP_COUNT);

    // Mode flipped + UI revealed.
    expect(useDevModeStore.getState().enabled).toBe(true);
    expect(screen.getByTestId('dev-mode-banner')).toHaveTextContent(/DEV MODE/);
    expect(screen.getByTestId('sign-in-email')).toBeTruthy();
    expect(screen.getByTestId('sign-in-password')).toBeTruthy();
    expect(screen.getByTestId('sign-in-submit')).toBeTruthy();

    // The whole app now targets the dev gateway (fresh read, no caching).
    expect(getGatewayUrl()).toBe(resolveGatewayUrl(true));

    // The flag is persisted, and the cross-env credentials are cleared.
    expect(mockMmkvBacking.get(DEV_MODE_STORAGE_KEY)).toBe('true');
    await waitFor(() => {
      expect(mockSecureBacking.has(AUTH_TOKEN_KEY)).toBe(false);
      expect(mockSecureBacking.has(RELAY_URL_KEY)).toBe(false);
    });
  });

  it('10 quick taps on the WHALE (not the words) also enable dev mode', () => {
    // Users tap the whale "logo", not the title — the whale tap layer must
    // route to the same toggle.
    renderScreen();
    const whale = screen.getByTestId('sign-in-logo-whale');
    for (let i = 0; i < DEV_MODE_TAP_COUNT; i++) fireEvent.press(whale);

    expect(useDevModeStore.getState().enabled).toBe(true);
    expect(screen.getByTestId('dev-mode-banner')).toHaveTextContent(/DEV MODE/);
  });

  it('10 more taps return to prod mode (banner + form gone, flag persisted false)', () => {
    renderScreen();
    tapLogo(DEV_MODE_TAP_COUNT);
    expect(useDevModeStore.getState().enabled).toBe(true);

    tapLogo(DEV_MODE_TAP_COUNT);
    expect(useDevModeStore.getState().enabled).toBe(false);
    expect(screen.queryByTestId('dev-mode-banner')).toBeNull();
    expect(screen.queryByTestId('sign-in-email')).toBeNull();
    expect(mockMmkvBacking.get(DEV_MODE_STORAGE_KEY)).toBe('false');
    expect(getGatewayUrl()).toBe(resolveGatewayUrl(false));
  });

  it('slow taps (gaps beyond the window) never toggle', () => {
    // Each tap arrives 3s after the previous one — the counter resets every time.
    let fakeNow = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
      fakeNow += 3000;
      return fakeNow;
    });

    renderScreen();
    tapLogo(DEV_MODE_TAP_COUNT + 5);

    expect(useDevModeStore.getState().enabled).toBe(false);
    expect(screen.queryByTestId('dev-mode-banner')).toBeNull();
    nowSpy.mockRestore();
  });

  it('flipping dev mode REMOUNTS ClerkProvider with the dev publishable key', async () => {
    // The `key` prop is load-bearing: Clerk initialises its instance once and
    // ignores a later `publishableKey` PROP change — only a remount re-inits it
    // against the dev Clerk instance. The mock's []-deps effect records one
    // entry per MOUNT, so this fails if either the store subscription or the
    // key prop is removed (a re-render alone records nothing).
    const { __clerkMock } = jest.requireMock('@clerk/clerk-expo') as {
      __clerkMock: { mounts: string[] };
    };
    __clerkMock.mounts.length = 0;
    const prevDevKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY_DEV;
    process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY_DEV = 'pk_test_dev_instance';
    try {
      render(
        <ClerkAuthProvider>
          <Text>child</Text>
        </ClerkAuthProvider>
      );
      expect(__clerkMock.mounts).toHaveLength(1);

      act(() => {
        useDevModeStore.getState().setDevMode(true);
      });

      // A SECOND mount happened (key flip), carrying the dev-mode key — proving
      // the live reader consults the store at mount time.
      await waitFor(() => expect(__clerkMock.mounts).toHaveLength(2));
      expect(__clerkMock.mounts[1]).toBe('pk_test_dev_instance');
      expect(getClerkPublishableKey()).toBe('pk_test_dev_instance');
    } finally {
      if (prevDevKey === undefined) delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY_DEV;
      else process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY_DEV = prevDevKey;
    }
  });

  it('the persisted flag survives a restart (fresh module registry hydrates from MMKV)', () => {
    mockMmkvBacking.set(DEV_MODE_STORAGE_KEY, 'true');

    // A fresh registry re-creates the store (the app-relaunch path); the mock
    // factory re-runs but shares the same backing Map (the "disk").
    jest.isolateModules(() => {
      const fresh =
        require('../src/features/state/devModeStore') as typeof import('../src/features/state/devModeStore');
      expect(fresh.isDevModeEnabled()).toBe(true);
    });
  });
});

describe('pure mode→env resolution', () => {
  it('resolves the gateway URL per mode, env override first', () => {
    // Defaults (no env override).
    expect(resolveGatewayUrl(false, {})).toBe(PROD_GATEWAY_URL);
    expect(resolveGatewayUrl(true, {})).toBe(DEV_GATEWAY_URL);

    // Env overrides win for their own mode only.
    const env = { prodUrl: 'http://localhost:3501', devUrl: 'https://dev.example.com' };
    expect(resolveGatewayUrl(false, env)).toBe('http://localhost:3501');
    expect(resolveGatewayUrl(true, env)).toBe('https://dev.example.com');

    // Blank env values fall back (an empty string is not a valid base URL).
    expect(resolveGatewayUrl(false, { prodUrl: '  ' })).toBe(PROD_GATEWAY_URL);
    expect(resolveGatewayUrl(true, { devUrl: '' })).toBe(DEV_GATEWAY_URL);
  });

  it('resolves the Clerk publishable key per mode, dev key falling back to the prod key', () => {
    const env = { prodKey: 'pk_live_abc', devKey: 'pk_test_xyz' };
    expect(resolveClerkPublishableKey(false, env)).toBe('pk_live_abc');
    expect(resolveClerkPublishableKey(true, env)).toBe('pk_test_xyz');

    // No dedicated dev key → reuse the main key (shared Clerk instance setup).
    expect(resolveClerkPublishableKey(true, { prodKey: 'pk_live_abc' })).toBe('pk_live_abc');
    expect(resolveClerkPublishableKey(true, { prodKey: 'pk_live_abc', devKey: ' ' })).toBe(
      'pk_live_abc'
    );
    expect(resolveClerkPublishableKey(false, {})).toBe('');
  });
});
