/**
 * Settings — Commits section (`/settings/commits`): the per-user "AI
 * co-author on commits" toggle, server-persisted via `/api/user-settings`.
 *
 *   1. default (no stored setting) → the toggle is ON (SDK default);
 *   2. a stored `includeCoAuthoredBy: false` → the toggle renders OFF;
 *   3. turning it OFF POSTs the FULL merged settings (preserving onboardingCompleted)
 *      and the switch reflects OFF (optimistic) and stays OFF across the refetch;
 *   4. turning it back ON POSTs `includeCoAuthoredBy: true`.
 */

// ── Hoisted mocks (must precede the SUT import) ──────────────────────────────

// CommitsScreen → useAppTheme → themeStore → MMKV. In-memory mock (repo shape).
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

// In-memory keychain (the authed sandbox client reads token + sandbox URL).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    getItemAsync: async (k: string) => (store.has(k) ? store.get(k)! : null),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { UserSettings } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { CommitsScreen } from '../src/features/settings/sections/commits/CommitsScreen';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

const secureStore = (jest.requireMock('expo-secure-store') as { __store: Map<string, string> })
  .__store;

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const SANDBOX_BASE = 'https://sandbox.portable.test';
const SETTINGS_URL = `${SANDBOX_BASE}/api/user-settings`;

const inertNetInfo: NetInfoLike = { addEventListener: () => () => {} };

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

describe('settings — commits section (AI co-author toggle)', () => {
  let gateway: MockGateway;
  let serverSettings: UserSettings | null;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    return activeQueryClient;
  }

  beforeEach(() => {
    secureStore.clear();
    secureStore.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.set(AUTH_TOKEN_KEY, 'good-token');
    gateway = createMockGateway();
    gateway.on('GET', SETTINGS_URL, () => ({
      body: {
        success: true,
        settings: serverSettings,
        hasCompletedOnboarding: serverSettings?.onboardingCompleted ?? false,
      },
    }));
    gateway.on('POST', SETTINGS_URL, (req) => {
      const body = req.body as { settings: UserSettings };
      serverSettings = body.settings;
      return { body: { success: true, settings: body.settings } };
    });
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  function mountScreen(): void {
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider
          client={buildClient(gateway)}
          queryClient={newQueryClient()}
          netInfo={inertNetInfo}
        >
          <CommitsScreen onBack={jest.fn()} />
        </ApiProvider>
      </SafeAreaProvider>
    );
  }

  async function mountAndAwaitToggle(): Promise<void> {
    mountScreen();
    await waitFor(() => {
      expect(screen.getByTestId('settings-commits-coauthor')).toBeTruthy();
    });
  }

  it('defaults to ON when no setting is stored', async () => {
    serverSettings = null;
    await mountAndAwaitToggle();
    expect(screen.getByTestId('settings-commits-coauthor').props.value).toBe(true);
  });

  it('renders OFF when the user has disabled the AI co-author', async () => {
    serverSettings = { onboardingCompleted: true, includeCoAuthoredBy: false };
    await mountAndAwaitToggle();
    expect(screen.getByTestId('settings-commits-coauthor').props.value).toBe(false);
  });

  it('turning it OFF POSTs the full merged settings and the switch stays OFF', async () => {
    serverSettings = { onboardingCompleted: true };
    await mountAndAwaitToggle();
    expect(screen.getByTestId('settings-commits-coauthor').props.value).toBe(true);

    fireEvent(screen.getByTestId('settings-commits-coauthor'), 'valueChange', false);

    await waitFor(() => {
      const post = gateway.requests.find(
        (r) => r.method === 'POST' && r.url.endsWith('/api/user-settings')
      );
      expect(post).toBeTruthy();
      // Read-modify-write: onboardingCompleted preserved, the toggle flipped off.
      expect(post!.body).toEqual({
        settings: { onboardingCompleted: true, includeCoAuthoredBy: false },
      });
    });

    // Optimistic + refetch: the switch reflects OFF and stays OFF.
    await waitFor(() => {
      expect(screen.getByTestId('settings-commits-coauthor').props.value).toBe(false);
    });
  });

  it('turning it back ON POSTs includeCoAuthoredBy: true', async () => {
    serverSettings = { onboardingCompleted: true, includeCoAuthoredBy: false };
    await mountAndAwaitToggle();
    expect(screen.getByTestId('settings-commits-coauthor').props.value).toBe(false);

    fireEvent(screen.getByTestId('settings-commits-coauthor'), 'valueChange', true);

    await waitFor(() => {
      const post = gateway.requests.find(
        (r) => r.method === 'POST' && r.url.endsWith('/api/user-settings')
      );
      expect(post).toBeTruthy();
      expect(post!.body).toEqual({
        settings: { onboardingCompleted: true, includeCoAuthoredBy: true },
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('settings-commits-coauthor').props.value).toBe(true);
    });
  });
});
