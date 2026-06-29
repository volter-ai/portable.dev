/**
 * StartupGate integration test.
 *
 * The startup gate makes a single cold-launch decision: is a Portable authToken
 * persisted in SecureStore? If so, render the app; otherwise redirect to Clerk
 * sign-in. (The old in-place credential migration was removed — an
 * upgrading user simply re-authenticates once.)
 */

// `expo-router`'s <Redirect> needs a router context; mock it to a marker so we can
// assert "routes to sign-in" without mounting the full router.
jest.mock('expo-router', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    Redirect: ({ href }: { href: string }) =>
      React.createElement(Text, { testID: 'redirect' }, `redirect:${href}`),
  };
});

// The gate now renders the branded LoadingSplash → useAppTheme → themeStore → MMKV.
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string) => store.set(k, String(v)),
    getString: (k: string) => store.get(k),
    remove: (k: string) => store.delete(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

// In-memory expo-secure-store (jest-expo provides no working SecureStore).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    getItemAsync: jest.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
    deleteItemAsync: jest.fn(async (k: string) => {
      store.delete(k);
    }),
  };
});

import React from 'react';
import { Text } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';

import { StartupGate } from '../src/features/auth/StartupGate';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';

type SecureStoreMock = { __store: Map<string, string> };
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

// Pin the startup checks to their happy path: this suite covers the
// original token-presence contract; the fresh-install/preflight behavior has
// its own suite (`stale-auth-cleanup.test.tsx`).
const STARTUP_OK = {
  isFreshInstall: () => false,
  preflight: async () => 'valid' as const,
};

beforeEach(() => {
  secureStore.__store.clear();
});

describe('StartupGate', () => {
  it('lands on the app when a persisted authToken exists', async () => {
    secureStore.__store.set(AUTH_TOKEN_KEY, 'existing-rn-token');

    render(
      <StartupGate deps={STARTUP_OK}>
        <Text testID="app-home">APP</Text>
      </StartupGate>
    );

    expect(await screen.findByTestId('app-home')).toBeTruthy();
    expect(screen.queryByTestId('redirect')).toBeNull();
  });

  it('redirects to sign-in when no authToken is persisted', async () => {
    render(
      <StartupGate deps={{ isFreshInstall: () => false }}>
        <Text testID="app-home">APP</Text>
      </StartupGate>
    );

    expect(await screen.findByText('redirect:/sign-in')).toBeTruthy();
    expect(screen.queryByTestId('app-home')).toBeNull();
    // Nothing was written on the re-auth path.
    expect(secureStore.__store.size).toBe(0);
  });

  it('honors an injected getRnAuthToken seam', async () => {
    const getRnAuthToken = jest.fn(async () => 'injected-token');

    render(
      <StartupGate deps={{ ...STARTUP_OK, getRnAuthToken }}>
        <Text testID="app-home">APP</Text>
      </StartupGate>
    );

    expect(await screen.findByTestId('app-home')).toBeTruthy();
    expect(getRnAuthToken).toHaveBeenCalledTimes(1);
  });

  it('settles deterministically (no lingering loading state)', async () => {
    secureStore.__store.set(AUTH_TOKEN_KEY, 'existing-rn-token');

    render(
      <StartupGate deps={STARTUP_OK}>
        <Text testID="app-home">APP</Text>
      </StartupGate>
    );

    await waitFor(() => expect(screen.queryByTestId('startup-gate-loading')).toBeNull());
    expect(screen.getByTestId('app-home')).toBeTruthy();
  });
});
