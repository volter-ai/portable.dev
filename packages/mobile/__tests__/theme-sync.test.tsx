/**
 * Phase 6 — ThemeSync (server theme hydration).
 *
 * Mounts <ThemeSync/> inside ApiProvider with a mocked sandbox HTTP layer. Asserts:
 *   1. a non-empty `GET /api/user/theme` `themeConfig` is applied to the themeStore
 *      (server-wins on cold start, web `ThemeContext` parity);
 *   2. a 404 (brand-new user, no saved theme) leaves the local default intact.
 */

// themeStore reads MMKV; mock it (in-memory).
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

// In-memory keychain (sandbox URL + authToken).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    deleteItemAsync: jest.fn(async (k: string) => {
      store.delete(k);
    }),
  };
});

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react-native';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { GatewayClient } from '../src/services/gatewayClient';
import { useThemeStore, MOBILE_DEFAULT_THEME_OPTIONS } from '../src/features/state/themeStore';
import { ThemeSync } from '../src/features/theme/ThemeSync';
import { createMockGateway, type MockGateway } from '../src/test';

interface SecureStoreMock {
  __store: Map<string, string>;
}
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;
const SANDBOX_BASE = 'https://sandbox.portable.test';
const netInfo = { addEventListener: () => () => {} };

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

describe('ThemeSync — server theme hydration', () => {
  let gateway: MockGateway;
  let queryClient: QueryClient | undefined;

  beforeEach(() => {
    secureStore.__store.clear();
    secureStore.__store.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.__store.set(AUTH_TOKEN_KEY, 'good-token');
    gateway = createMockGateway();
    onlineManager.setOnline(true);
    useThemeStore.setState({ ...MOBILE_DEFAULT_THEME_OPTIONS });
  });

  afterEach(() => {
    queryClient?.clear();
    queryClient = undefined;
    onlineManager.setOnline(true);
  });

  it('applies a non-empty server themeConfig to the store', async () => {
    gateway.on('GET', `${SANDBOX_BASE}/api/user/theme`, () => ({
      body: { themeConfig: { accent: 'teal', brightness: 'dark', usePaper: false } },
    }));

    queryClient = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ApiProvider client={buildClient(gateway)} queryClient={queryClient} netInfo={netInfo}>
        <ThemeSync />
      </ApiProvider>
    );

    await waitFor(() => {
      expect(useThemeStore.getState().accent).toBe('teal');
    });
    expect(useThemeStore.getState().brightness).toBe('dark');
  });

  it('leaves the local default intact when the server has no saved theme (404)', async () => {
    gateway.on('GET', `${SANDBOX_BASE}/api/user/theme`, () => ({
      status: 404,
      body: { error: 'none' },
    }));

    queryClient = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ApiProvider client={buildClient(gateway)} queryClient={queryClient} netInfo={netInfo}>
        <ThemeSync />
      </ApiProvider>
    );

    // Let the failed query settle, then assert the default accent is unchanged.
    await waitFor(() => {
      expect(gateway.requests.some((r) => r.url === `${SANDBOX_BASE}/api/user/theme`)).toBe(true);
    });
    expect(useThemeStore.getState().accent).toBe(MOBILE_DEFAULT_THEME_OPTIONS.accent);
  });
});
