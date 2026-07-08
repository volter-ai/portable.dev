/**
 * Settings — Claude Account section (`/settings/claude-account`, portable.dev#18):
 * sign in with Claude from the phone (browser + paste-code PKCE), the credential
 * status card, the paste-token fallback, and sign-out.
 *
 *   1. no credential → "Not signed in" card + "Sign in with Claude";
 *   2. sign-in flow: start → opens the authorize URL (injected seam) → paste code
 *      → complete POSTs the code → status refetches to signed-in;
 *   3. a failed exchange shows the error banner and stays on code entry;
 *   4. the paste-token fallback POSTs /token and refreshes the status;
 *   5. sign-out DELETEs and the card returns to "Not signed in".
 */

// ── Hoisted mocks (must precede the SUT import) ──────────────────────────────

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

import type { AiCredentialsStatusResponse } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { ClaudeAccountScreen } from '../src/features/settings/sections/claude-account/ClaudeAccountScreen';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

const secureStore = (jest.requireMock('expo-secure-store') as { __store: Map<string, string> })
  .__store;

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const PC_BASE = 'https://pc.portable.test';
const STATUS_URL = `${PC_BASE}/api/ai-credentials/status`;
const START_URL = `${PC_BASE}/api/ai-credentials/login/start`;
const COMPLETE_URL = `${PC_BASE}/api/ai-credentials/login/complete`;
const TOKEN_URL = `${PC_BASE}/api/ai-credentials/token`;
const SIGNOUT_URL = `${PC_BASE}/api/ai-credentials`;

const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize?client_id=x&state=y';

const NONE_STATUS: AiCredentialsStatusResponse = {
  mode: 'none',
  source: 'none',
  hasRefreshToken: false,
};

const SIGNED_IN_STATUS: AiCredentialsStatusResponse = {
  mode: 'claude-oauth',
  source: 'oauth-record',
  hasRefreshToken: true,
  email: 'user@example.com',
};

const inertNetInfo: NetInfoLike = { addEventListener: () => () => {} };

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

describe('settings — Claude Account section', () => {
  let gateway: MockGateway;
  let serverStatus: AiCredentialsStatusResponse;
  let openUrl: jest.Mock;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    return activeQueryClient;
  }

  beforeEach(() => {
    secureStore.clear();
    secureStore.set(RELAY_URL_KEY, PC_BASE);
    secureStore.set(AUTH_TOKEN_KEY, 'good-token');
    serverStatus = NONE_STATUS;
    openUrl = jest.fn(async () => {});
    gateway = createMockGateway();
    gateway.on('GET', STATUS_URL, () => ({ body: serverStatus }));
    gateway.on('POST', START_URL, () => ({ body: { authorizeUrl: AUTHORIZE_URL } }));
    gateway.on('POST', COMPLETE_URL, () => {
      serverStatus = SIGNED_IN_STATUS;
      return { body: { ok: true, email: 'user@example.com' } };
    });
    gateway.on('POST', TOKEN_URL, () => {
      serverStatus = {
        mode: 'claude-oauth',
        source: 'oauth-record',
        hasRefreshToken: false,
      };
      return { body: { ok: true, mode: 'claude-oauth' } };
    });
    gateway.on('DELETE', SIGNOUT_URL, () => {
      serverStatus = NONE_STATUS;
      return { body: { ok: true, cleared: true } };
    });
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  async function mountScreen(): Promise<void> {
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider
          client={buildClient(gateway)}
          queryClient={newQueryClient()}
          netInfo={inertNetInfo}
        >
          <ClaudeAccountScreen onBack={jest.fn()} vmDeps={{ openUrl }} />
        </ApiProvider>
      </SafeAreaProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('settings-claude-account-status')).toBeTruthy();
    });
  }

  it('shows "Not signed in" and the sign-in button when no credential exists', async () => {
    await mountScreen();
    expect(screen.getByText('Not signed in')).toBeTruthy();
    expect(screen.getByTestId('settings-claude-account-signin')).toBeTruthy();
    // No stored credential → no sign-out entry.
    expect(screen.queryByTestId('settings-claude-account-signout')).toBeNull();
  });

  it('runs the full sign-in flow: start → open browser → paste code → signed in', async () => {
    await mountScreen();

    fireEvent.press(screen.getByTestId('settings-claude-account-signin'));

    // start returned the authorize URL → opened in the system browser (seam).
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith(AUTHORIZE_URL);
    });
    // The code-entry panel is up.
    const input = screen.getByTestId('settings-claude-account-code-input');
    fireEvent.changeText(input, '  the-code#the-state  ');
    fireEvent.press(screen.getByTestId('settings-claude-account-code-submit'));

    // complete POSTed the trimmed code.
    await waitFor(() => {
      const post = gateway.requests.find(
        (r) => r.method === 'POST' && r.url.endsWith('/login/complete')
      );
      expect(post).toBeTruthy();
      expect(post!.body).toEqual({ code: 'the-code#the-state' });
    });

    // Status refetched → signed-in card, sign-out available, code panel gone.
    await waitFor(() => {
      expect(screen.getByText('Signed in as user@example.com')).toBeTruthy();
    });
    expect(screen.queryByTestId('settings-claude-account-code-input')).toBeNull();
    expect(screen.getByTestId('settings-claude-account-signout')).toBeTruthy();
  });

  it('shows the error banner and stays on code entry when the exchange fails', async () => {
    gateway.on('POST', COMPLETE_URL, () => ({
      status: 400,
      body: {
        error: 'The pasted code belongs to a different login attempt',
        code: 'state_mismatch',
      },
    }));
    await mountScreen();

    fireEvent.press(screen.getByTestId('settings-claude-account-signin'));
    await waitFor(() => {
      expect(screen.getByTestId('settings-claude-account-code-input')).toBeTruthy();
    });
    fireEvent.changeText(screen.getByTestId('settings-claude-account-code-input'), 'stale-code');
    fireEvent.press(screen.getByTestId('settings-claude-account-code-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('settings-claude-account-banner')).toBeTruthy();
    });
    // Still on code entry so the user can paste the newest code.
    expect(screen.getByTestId('settings-claude-account-code-input')).toBeTruthy();
  });

  it('paste-token fallback POSTs the token and refreshes the status', async () => {
    await mountScreen();

    fireEvent.press(screen.getByTestId('settings-claude-account-token-toggle'));
    fireEvent.changeText(
      screen.getByTestId('settings-claude-account-token-input'),
      ' sk-ant-oat01-pasted '
    );
    fireEvent.press(screen.getByTestId('settings-claude-account-token-submit'));

    await waitFor(() => {
      const post = gateway.requests.find((r) => r.method === 'POST' && r.url.endsWith('/token'));
      expect(post).toBeTruthy();
      expect(post!.body).toEqual({ token: 'sk-ant-oat01-pasted' });
    });
    await waitFor(() => {
      expect(screen.getByText('Signed in with Claude')).toBeTruthy();
    });
  });

  it('sign-out DELETEs and returns the card to "Not signed in"', async () => {
    serverStatus = SIGNED_IN_STATUS;
    await mountScreen();
    expect(screen.getByText('Signed in as user@example.com')).toBeTruthy();

    fireEvent.press(screen.getByTestId('settings-claude-account-signout'));

    await waitFor(() => {
      const del = gateway.requests.find(
        (r) => r.method === 'DELETE' && r.url.endsWith('/api/ai-credentials')
      );
      expect(del).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText('Not signed in')).toBeTruthy();
    });
  });
});
