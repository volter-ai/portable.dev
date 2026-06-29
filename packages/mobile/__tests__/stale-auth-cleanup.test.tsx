/**
 * Stale-credential cleanup.
 *
 * iOS Keychain survives an app reinstall but MMKV does not, so a reinstall can
 * boot the app while still holding a previous (dev) install's credentials. Two
 * defenses, each covered here:
 *
 *   1. Fresh-install marker — marker absent ⇒ wipe the Keychain before
 *      trusting it (deterministic, offline-safe).
 *   2. Auth preflight — `GET /me` verdicts: 401/2xx-HTML ⇒ wipe + sign-in;
 *      network errors fail OPEN (an offline returning user stays in).
 *
 * (The third defense — the SSE-provisioning hardening — was deleted with the
 * Modal SSE provisioning flow in the local-first cleanup.)
 */

jest.mock('expo-router', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    Redirect: ({ href }: { href: string }) =>
      React.createElement(Text, { testID: 'redirect' }, `redirect:${href}`),
  };
});

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
import { act, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { StartupGate } from '../src/features/auth/StartupGate';
import { CLERK_CLIENT_JWT_KEY, forceSignOut } from '../src/features/auth/forceSignOut';
import { INSTALL_MARKER_KEY } from '../src/features/auth/installMarker';
import { preflightAuthToken } from '../src/features/auth/preflightAuth';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { usePushRegistrationStore } from '../src/features/settings/sections/notifications/pushRegistrationStore';
import { useBlockedOrgsStore } from '../src/features/settings/sections/organizations/blockedOrgsStore';
import { useAuthStore } from '../src/features/state/authStore';
import { useChatStore } from '../src/features/state/chatStore';
import { useOfflineQueueStore } from '../src/features/state/offlineQueueStore';
import { useReposStore } from '../src/features/state/reposStore';
import { MOBILE_DEFAULT_THEME_OPTIONS, useThemeStore } from '../src/features/state/themeStore';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway } from '../src/test';

type SecureStoreMock = { __store: Map<string, string> };
type MmkvMock = { __store: Map<string, string> };
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;
const mmkv = jest.requireMock('react-native-mmkv') as MmkvMock;

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

beforeEach(() => {
  secureStore.__store.clear();
  mmkv.__store.clear();
  act(() => {
    useAuthStore.getState().reset();
    // MMKV stores hydrate once at import; reset the in-memory singletons so a
    // prior test's seeded data never leaks into the next (mmkv.__store.clear()
    // only wipes disk, not the live store state).
    useChatStore.getState().reset();
    useOfflineQueueStore.getState().clear();
    useReposStore.getState().reset();
    useThemeStore.getState().reset();
    useBlockedOrgsStore.getState().reset();
    usePushRegistrationStore.getState().clearRegisteredEndpoint();
  });
});

// ── preflightAuthToken ──────────────────────────────────────────────────────

describe('preflightAuthToken', () => {
  const GATEWAY_URL = 'https://gw.test';
  const ME_URL = `${GATEWAY_URL}/auth/mobile/react-native/me`;

  const gateway = new GatewayClient({ gatewayUrl: GATEWAY_URL });

  function responseStub(spec: {
    status: number;
    body: string;
    url?: string;
    contentType?: string;
  }): Response {
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      url: spec.url ?? ME_URL,
      headers: { get: () => spec.contentType ?? null },
      text: async () => spec.body,
    } as unknown as Response;
  }

  const run = (res: Response | (() => Promise<Response>)) =>
    preflightAuthToken({
      gateway,
      authToken: 'token-under-test',
      fetchImpl: (typeof res === 'function' ? res : async () => res) as unknown as typeof fetch,
      timeoutSignal: () => undefined,
    });

  it('returns valid for a 2xx JSON object body', async () => {
    const verdict = await run(
      responseStub({ status: 200, body: JSON.stringify({ userId: 'u1' }) })
    );
    expect(verdict).toBe('valid');
  });

  it('returns auth-dead for an authoritative 401', async () => {
    const verdict = await run(responseStub({ status: 401, body: '{"error":"Unauthorized"}' }));
    expect(verdict).toBe('auth-dead');
  });

  it('returns auth-dead for a 2xx HTML body answered by the gateway origin (RN routes absent)', async () => {
    // The exact production failure shape: a gateway WITHOUT the RN routes serves
    // its SPA catch-all index.html with HTTP 200.
    const verdict = await run(
      responseStub({ status: 200, body: '<!DOCTYPE html><html>…</html>', contentType: 'text/html' })
    );
    expect(verdict).toBe('auth-dead');
  });

  it('returns indeterminate for a 2xx HTML body that left the gateway origin (captive portal)', async () => {
    const verdict = await run(
      responseStub({
        status: 200,
        body: '<html>hotel wifi</html>',
        url: 'http://portal.hotel.local/login',
      })
    );
    expect(verdict).toBe('indeterminate');
  });

  it('returns indeterminate for a network error (fail-open — never signs out offline users)', async () => {
    const verdict = await run(() => Promise.reject(new Error('Network request failed')));
    expect(verdict).toBe('indeterminate');
  });

  it('returns indeterminate for a 5xx (gateway trouble is not an auth verdict)', async () => {
    const verdict = await run(responseStub({ status: 503, body: 'Service Unavailable' }));
    expect(verdict).toBe('indeterminate');
  });

  it('sends Bearer-only auth with cookies omitted', async () => {
    const fetchImpl = jest.fn(async () =>
      responseStub({ status: 200, body: '{}' })
    ) as unknown as typeof fetch;
    await preflightAuthToken({
      gateway,
      authToken: 'tok',
      fetchImpl,
      timeoutSignal: () => undefined,
    });
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ME_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(init.credentials).toBe('omit');
  });
});

// ── forceSignOut ────────────────────────────────────────────────────────────

describe('forceSignOut', () => {
  it('clears the authToken, sandbox URL, identity slice and (opted-in) Clerk client JWT', async () => {
    secureStore.__store.set(AUTH_TOKEN_KEY, 'stale-token');
    secureStore.__store.set(RELAY_URL_KEY, 'https://stale.modal.run');
    secureStore.__store.set(CLERK_CLIENT_JWT_KEY, 'stale-clerk-jwt');
    act(() => {
      useAuthStore.getState().setUser({ userId: 'u1', username: 'bruno', email: 'b@x.dev' });
    });

    await act(async () => {
      await forceSignOut({ clearClerkClientJwt: true });
    });

    expect(secureStore.__store.has(AUTH_TOKEN_KEY)).toBe(false);
    expect(secureStore.__store.has(RELAY_URL_KEY)).toBe(false);
    expect(secureStore.__store.has(CLERK_CLIENT_JWT_KEY)).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('runs the injected Clerk sign-out and keeps the client JWT without the opt-in', async () => {
    secureStore.__store.set(CLERK_CLIENT_JWT_KEY, 'live-clerk-jwt');
    const clerkSignOut = jest.fn(async () => {});

    await act(async () => {
      await forceSignOut({ clerkSignOut });
    });

    expect(clerkSignOut).toHaveBeenCalledTimes(1);
    expect(secureStore.__store.get(CLERK_CLIENT_JWT_KEY)).toBe('live-clerk-jwt');
  });

  it('wipes every NON-secret MMKV store that holds the previous user data', async () => {
    // Seed each local store with data belonging to the signed-out user.
    act(() => {
      useChatStore.getState().updateChatDraft('chat-1', 'secret draft from user A');
      useChatStore.getState().setCustomAiStylePrompt('user A custom prompt');
      useChatStore.getState().setAiStyle('concise');
      useOfflineQueueStore
        .getState()
        .enqueue({ id: 'm1', chatId: 'chat-1', content: 'unsent message', queuedAt: 1 });
      useReposStore.getState().setSearchQuery('user A search');
      useReposStore.getState().setLanguageFilter('TypeScript');
      useThemeStore.getState().setAccent('blue');
      useBlockedOrgsStore.getState().toggleBlocked('acme-org');
      usePushRegistrationStore.getState().setRegisteredEndpoint('device-token-A');
    });

    await act(async () => {
      await forceSignOut();
    });

    // Chat drafts + the AI-style prompt + the offline send queue are gone.
    expect(useChatStore.getState().drafts).toEqual({});
    expect(useChatStore.getState().customAiStylePrompt).toBe('');
    expect(useChatStore.getState().aiStyle).not.toBe('concise');
    expect(useOfflineQueueStore.getState().queue).toEqual([]);
    // Repo prefs, blocked orgs, theme, and the device push token reset.
    expect(useReposStore.getState().searchQuery).toBe('');
    expect(useReposStore.getState().languageFilter).toBeNull();
    expect(useThemeStore.getState().accent).toBe(MOBILE_DEFAULT_THEME_OPTIONS.accent);
    expect(useBlockedOrgsStore.getState().blockedOrgs).toEqual([]);
    expect(usePushRegistrationStore.getState().registeredEndpoint).toBeNull();

    // And the reset is flushed to the (synchronous) MMKV backing store, so the
    // next user reading from disk never sees user A's data either.
    expect(mmkv.__store.get('portable.offlineQueue') ?? '').not.toContain('unsent message');
    expect(mmkv.__store.get('portable.chat') ?? '').not.toContain('secret draft from user A');
  });
});

// ── StartupGate: fresh install + preflight ──────────────────────────────────

describe('StartupGate stale-credential handling', () => {
  it('wipes Keychain residue and redirects on a fresh install (marker absent)', async () => {
    // Reinstall scenario: MMKV is empty (no marker, dev-mode flag gone) while
    // the Keychain still holds the previous install's dev credentials.
    secureStore.__store.set(AUTH_TOKEN_KEY, 'dev-token');
    secureStore.__store.set(RELAY_URL_KEY, 'https://dev-sandbox.modal.run');
    const preflight = jest.fn(async () => 'valid' as const);

    render(
      <StartupGate deps={{ preflight }}>
        <Text testID="app-home">APP</Text>
      </StartupGate>
    );

    expect(await screen.findByText('redirect:/sign-in')).toBeTruthy();
    expect(secureStore.__store.has(AUTH_TOKEN_KEY)).toBe(false);
    expect(secureStore.__store.has(RELAY_URL_KEY)).toBe(false);
    // The install is now marked, so the next boot takes the normal path…
    expect(mmkv.__store.get(INSTALL_MARKER_KEY)).toBe('true');
    // …and the network preflight never ran (the wipe is offline-deterministic).
    expect(preflight).not.toHaveBeenCalled();
  });

  it('wipes and redirects when the gateway authoritatively rejects the token', async () => {
    mmkv.__store.set(INSTALL_MARKER_KEY, 'true');
    secureStore.__store.set(AUTH_TOKEN_KEY, 'foreign-env-token');

    render(
      <StartupGate deps={{ preflight: async () => 'auth-dead' }}>
        <Text testID="app-home">APP</Text>
      </StartupGate>
    );

    expect(await screen.findByText('redirect:/sign-in')).toBeTruthy();
    expect(secureStore.__store.has(AUTH_TOKEN_KEY)).toBe(false);
  });

  it('fails OPEN on an indeterminate preflight (offline returning user stays in)', async () => {
    mmkv.__store.set(INSTALL_MARKER_KEY, 'true');
    secureStore.__store.set(AUTH_TOKEN_KEY, 'token');

    render(
      <StartupGate deps={{ preflight: async () => 'indeterminate' }}>
        <Text testID="app-home">APP</Text>
      </StartupGate>
    );

    expect(await screen.findByTestId('app-home')).toBeTruthy();
    expect(secureStore.__store.get(AUTH_TOKEN_KEY)).toBe('token');
  });
});
