/**
 * GitHub Organizations settings page (`/settings/organizations`) — web
 * `OrganizationsSection.tsx` parity.
 *
 * With the mocked sandbox HTTP (`createMockGateway` + `RelayApiClient`) and
 * an in-memory MMKV, mount `OrganizationsScreen` under `ApiProvider` and assert:
 *   1. the org list renders (login + description + avatar) with every org
 *      checked (visible) by default;
 *   2. toggling an org writes `useBlockedOrgsStore` AND persists into the MMKV
 *      blob `portable.blockedOrgs`; toggling back round-trips to empty;
 *   3. the grant flow POSTs `/auth/github/org-access-url` (Bearer, no cookies),
 *      opens the returned URL via the injected auth-session seam, and refetches
 *      the org list once the session settles (second-response fixture renders);
 *   4. the empty state shows the web copy + the grant CTA with its busy label
 *      while the browser session is open (then refetches on settle);
 *   5. a failed fetch renders the error copy.
 */

// ── Hoisted mocks (must precede the SUT import) ──────────────────────────────

// useAppTheme → themeStore → MMKV, plus the blockedOrgs slice under test.
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

// The authed sandbox client reads the auth token + sandbox URL from SecureStore.
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    getItemAsync: async (k: string) => (store.has(k) ? store.get(k)! : null),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});

// The native NetInfo module must never load under Jest; connectivity is injected.
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import {
  BLOCKED_ORGS_PERSIST_KEY,
  useBlockedOrgsStore,
} from '../src/features/settings/sections/organizations/blockedOrgsStore';
import { OrganizationsScreen } from '../src/features/settings/sections/organizations/OrganizationsScreen';
import type { AuthSessionResult } from '../src/features/settings/sections/organizations/useOrganizationsViewModel';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

const secureStore = (jest.requireMock('expo-secure-store') as { __store: Map<string, string> })
  .__store;
const mmkvStore = (jest.requireMock('react-native-mmkv') as { __store: Map<string, string> })
  .__store;

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const SANDBOX_BASE = 'https://sandbox.portable.test';
const ORGS_URL = `${SANDBOX_BASE}/api/user/organizations`;
const GRANT_URL_ENDPOINT = `${SANDBOX_BASE}/auth/github/org-access-url`;
const OAUTH_URL = 'https://github.com/login/oauth/authorize?client_id=org-access';

const ORGS = [
  {
    login: 'acme',
    id: 1,
    avatar_url: 'https://avatars.example/acme.png',
    description: 'Acme Corp — widgets at scale',
  },
  { login: 'volter', id: 2, avatar_url: 'https://avatars.example/volter.png', description: null },
];
const GRANTED_ORG = {
  login: 'newco',
  id: 3,
  avatar_url: 'https://avatars.example/newco.png',
  description: 'Freshly granted',
};

/** Inert NetInfo (always online) for the query client. */
const netInfo: NetInfoLike = { addEventListener: () => () => {} };

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

describe('settings — GitHub Organizations page', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    return activeQueryClient;
  }

  beforeEach(() => {
    secureStore.clear();
    secureStore.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.set(AUTH_TOKEN_KEY, 'good-token');
    mmkvStore.clear();
    act(() => {
      useBlockedOrgsStore.setState({ blockedOrgs: [] });
    });
    gateway = createMockGateway();
    gateway.on('GET', ORGS_URL, () => ({ body: { organizations: ORGS } }));
    gateway.on('POST', GRANT_URL_ENDPOINT, () => ({ body: { url: OAUTH_URL } }));
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  function mount(
    opts: {
      openAuthSession?: (url: string, returnTo: string) => Promise<AuthSessionResult>;
    } = {}
  ) {
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={buildClient(gateway)} queryClient={newQueryClient()} netInfo={netInfo}>
          <OrganizationsScreen
            deps={{
              openAuthSession: opts.openAuthSession ?? jest.fn(async () => ({ type: 'dismiss' })),
              createReturnToUrl: () => 'portable://settings/organizations',
            }}
          />
        </ApiProvider>
      </SafeAreaProvider>
    );
  }

  /** Read the persisted blockedOrgs array out of the MMKV blob. */
  function persistedBlockedOrgs(): string[] {
    const blob = mmkvStore.get(BLOCKED_ORGS_PERSIST_KEY);
    if (!blob) return [];
    return (JSON.parse(blob) as { state: { blockedOrgs: string[] } }).state.blockedOrgs;
  }

  it('renders the org list (login, description, avatar) with all orgs checked by default', async () => {
    mount();

    await waitFor(() => {
      expect(screen.getByTestId('settings-organizations-list')).toBeTruthy();
    });

    expect(screen.getByText('acme')).toBeTruthy();
    expect(screen.getByText('Acme Corp — widgets at scale')).toBeTruthy();
    expect(screen.getByText('volter')).toBeTruthy();
    expect(screen.getByTestId('settings-organizations-avatar-acme').props.source).toEqual({
      uri: 'https://avatars.example/acme.png',
    });

    // Checked = NOT blocked (web parity); both checkmarks render initially.
    expect(screen.getByTestId('settings-organizations-check-acme')).toBeTruthy();
    expect(screen.getByTestId('settings-organizations-check-volter')).toBeTruthy();
    // Header subtext + inline grant button (non-empty state).
    expect(screen.getByTestId('settings-organizations-grant')).toHaveTextContent('Grant access');
  });

  it('toggling an org writes the store + the MMKV blob, and round-trips back', async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId('settings-organizations-org-acme')).toBeTruthy();
    });

    // Uncheck (block) acme.
    fireEvent.press(screen.getByTestId('settings-organizations-org-acme'));
    expect(useBlockedOrgsStore.getState().blockedOrgs).toEqual(['acme']);
    await waitFor(() => {
      expect(persistedBlockedOrgs()).toEqual(['acme']);
    });
    expect(screen.queryByTestId('settings-organizations-check-acme')).toBeNull();
    // The other org stays checked.
    expect(screen.getByTestId('settings-organizations-check-volter')).toBeTruthy();

    // Re-check (unblock) acme — store AND blob round-trip to empty.
    fireEvent.press(screen.getByTestId('settings-organizations-org-acme'));
    expect(useBlockedOrgsStore.getState().blockedOrgs).toEqual([]);
    await waitFor(() => {
      expect(persistedBlockedOrgs()).toEqual([]);
    });
    expect(screen.getByTestId('settings-organizations-check-acme')).toBeTruthy();
  });

  it('grant access: POSTs org-access-url, opens the returned URL, and refetches on settle', async () => {
    // Second-response fixture: after the grant settles, the backend reports a new org.
    let orgCalls = 0;
    gateway.on('GET', ORGS_URL, () => {
      orgCalls += 1;
      return {
        body: { organizations: orgCalls === 1 ? ORGS : [...ORGS, GRANTED_ORG] },
      };
    });
    const openAuthSession = jest.fn(async () => ({ type: 'success' as const }));
    mount({ openAuthSession });

    await waitFor(() => {
      expect(screen.getByTestId('settings-organizations-grant')).toBeTruthy();
    });
    expect(screen.queryByTestId('settings-organizations-org-newco')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-organizations-grant'));
    });

    // POST recorded — Bearer, no cookies, against the sandbox /auth route.
    const post = gateway.requests.find(
      (r) => r.method === 'POST' && r.url.endsWith('/auth/github/org-access-url')
    );
    expect(post).toBeTruthy();
    expect(post!.url).toBe(GRANT_URL_ENDPOINT);
    expect(post!.headers.Authorization ?? post!.headers.authorization).toBe('Bearer good-token');
    expect(post!.headers.Cookie ?? post!.headers.cookie).toBeUndefined();

    // The in-app browser opened the gateway-built URL with the RN return target.
    expect(openAuthSession).toHaveBeenCalledTimes(1);
    expect(openAuthSession).toHaveBeenCalledWith(OAUTH_URL, 'portable://settings/organizations');

    // On settle the org list refetched — the second fixture renders.
    await waitFor(() => {
      expect(screen.getByTestId('settings-organizations-org-newco')).toBeTruthy();
    });
    expect(orgCalls).toBe(2);
  });

  it('empty state: web copy + grant CTA with busy label while the session is open', async () => {
    gateway.on('GET', ORGS_URL, () => ({ body: { organizations: [] } }));
    let settle: (r: AuthSessionResult) => void = () => {};
    const openAuthSession = jest.fn(
      () => new Promise<AuthSessionResult>((resolve) => (settle = resolve))
    );
    mount({ openAuthSession });

    await waitFor(() => {
      expect(screen.getByTestId('settings-organizations-empty')).toBeTruthy();
    });
    expect(
      screen.getByText("No organizations found or you haven't granted access yet")
    ).toBeTruthy();
    expect(screen.getByTestId('settings-organizations-grant')).toHaveTextContent(
      'Grant Organization Access'
    );

    // Press grant — busy label shows while the in-app browser session is open.
    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-organizations-grant'));
    });
    expect(screen.getByTestId('settings-organizations-grant')).toHaveTextContent(
      'Waiting for authorization...'
    );

    const getsBefore = gateway.requests.filter(
      (r) => r.method === 'GET' && r.url === ORGS_URL
    ).length;

    // Settle the session — the button re-enables and the list refetches once.
    await act(async () => {
      settle({ type: 'dismiss' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('settings-organizations-grant')).toHaveTextContent(
        'Grant Organization Access'
      );
    });
    await waitFor(() => {
      const getsAfter = gateway.requests.filter(
        (r) => r.method === 'GET' && r.url === ORGS_URL
      ).length;
      expect(getsAfter).toBe(getsBefore + 1);
    });
  });

  it('renders the error state when the fetch fails', async () => {
    gateway.on('GET', ORGS_URL, () => ({ status: 500, body: { error: 'boom' } }));
    mount();

    await waitFor(() => {
      expect(screen.getByTestId('settings-organizations-error')).toBeTruthy();
    });
    expect(screen.getByTestId('settings-organizations-error')).toHaveTextContent(
      'Failed to load organizations'
    );
    expect(screen.queryByTestId('settings-organizations-list')).toBeNull();
    expect(screen.queryByTestId('settings-organizations-empty')).toBeNull();
  });
});
