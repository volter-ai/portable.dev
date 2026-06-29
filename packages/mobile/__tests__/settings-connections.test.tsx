/**
 * Connected Services settings page (`/settings/connections`) — web
 * `ConnectedServicesSection.tsx` parity.
 *
 * With the mocked sandbox HTTP (`createMockGateway` + `RelayApiClient`),
 * mount `ConnectionsScreen` under `ApiProvider` and assert:
 *   1. connected cards show displayName AND the service id (don't swap — the
 *      web gotcha), the hidden count testID, the summary line, the green Active
 *      indicator only on active connections, and the available catalog grouped
 *      by category EXCLUDING disabled services;
 *   2. "+ Add" opens the injected browser seam with the sandbox connect URL
 *      (`service=` + `token=` + sandbox base) and refetches on close (the
 *      second fixture adds the new connection → the hidden count updates);
 *   3. rename → `PATCH /api/connections/slack_1/rename` with body
 *      `{ newDisplayName: 'New name' }` (the field `connections.routes.ts`
 *      actually reads — web ConnectionsContext parity);
 *   4. disconnect is a two-step confirm → `DELETE /api/connections/slack_1`
 *      recorded only after Confirm, list refetches;
 *   5. an already-connected EXCLUSIVE service is skipped from the available
 *      catalog, and its card's Enable button PATCHes toggle-active
 *      `{ isActive: true }`;
 *   6. a failed connections fetch renders the error state.
 */

// ── Hoisted mocks (must precede the SUT import) ──────────────────────────────

// useAppTheme → themeStore → MMKV.
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

// The authed sandbox client + the connect flow read SecureStore (token + sandbox URL).
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
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { ConnectionsScreen } from '../src/features/settings/sections/connections/ConnectionsScreen';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

const secureStore = (jest.requireMock('expo-secure-store') as { __store: Map<string, string> })
  .__store;

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const SANDBOX_BASE = 'https://sandbox.portable.test';
const AUTH_TOKEN = 'good-token';
const CONNECTIONS_URL = `${SANDBOX_BASE}/api/connections`;
const SERVICES_URL = `${SANDBOX_BASE}/api/connections/services`;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SLACK_CONNECTION = {
  id: 'uuid-1',
  userId: 'user@example.com',
  connectionId: 'slack_1',
  displayName: 'My Slack',
  service: 'slack',
  serviceType: 'sdk',
  connectedAt: '2026-01-05T12:00:00.000Z',
  isActive: true,
};
const GITHUB_CONNECTION = {
  id: 'uuid-2',
  userId: 'user@example.com',
  connectionId: 'github_1',
  displayName: 'GitHub',
  service: 'github',
  serviceType: 'sdk',
  connectedAt: '2026-02-10T12:00:00.000Z',
  isActive: false,
};
const LINEAR_CONNECTION = {
  id: 'uuid-3',
  userId: 'user@example.com',
  connectionId: 'linear_1',
  displayName: 'My Linear',
  service: 'linear',
  serviceType: 'sdk',
  connectedAt: '2026-06-11T12:00:00.000Z',
  isActive: true,
};
const AWS_CONNECTION = {
  id: 'uuid-4',
  userId: 'user@example.com',
  connectionId: 'aws_1',
  displayName: 'My AWS',
  service: 'aws-cli',
  serviceType: 'cli',
  connectedAt: '2026-03-01T12:00:00.000Z',
  isActive: false,
};

const SERVICES = [
  {
    name: 'Slack',
    service: 'slack',
    type: 'sdk',
    authType: 'oauth',
    icon: 'slack.svg',
    description: 'Send messages and read channels',
    enabled: true,
    domain: 'slack.com',
    category: 'communication',
  },
  {
    name: 'GitHub',
    service: 'github',
    type: 'sdk',
    authType: 'oauth',
    icon: 'github.svg',
    description: 'Repos, issues and pull requests',
    enabled: true,
    domain: 'github.com',
    category: 'development',
  },
  {
    name: 'Linear',
    service: 'linear',
    type: 'sdk',
    authType: 'oauth',
    icon: 'linear.svg',
    description: 'Issue tracking for modern teams',
    enabled: true,
    domain: 'linear.app',
    category: 'productivity',
  },
  {
    name: 'Notion',
    service: 'notion',
    type: 'sdk',
    authType: 'oauth',
    icon: 'notion.svg',
    description: 'Docs and wikis',
    enabled: false, // Coming Soon — must be EXCLUDED from the available catalog
    domain: 'notion.so',
    category: 'productivity',
  },
  {
    name: 'AWS CLI',
    service: 'aws-cli',
    type: 'cli',
    authType: 'api-key',
    icon: 'aws.svg',
    description: 'Deploy with AWS credentials',
    enabled: true,
    isExclusive: true, // only one active; skipped from available once connected
    domain: 'aws.amazon.com',
    category: 'infrastructure',
  },
];

/** Inert NetInfo (always online) for the query client. */
const netInfo: NetInfoLike = { addEventListener: () => () => {} };

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

describe('settings — Connected Services page', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    return activeQueryClient;
  }

  beforeEach(() => {
    secureStore.clear();
    secureStore.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.set(AUTH_TOKEN_KEY, AUTH_TOKEN);
    gateway = createMockGateway();
    gateway.on('GET', CONNECTIONS_URL, () => ({
      body: { connections: [SLACK_CONNECTION, GITHUB_CONNECTION] },
    }));
    gateway.on('GET', SERVICES_URL, () => ({ body: { services: SERVICES } }));
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  function mount(opts: { openBrowser?: (url: string) => Promise<{ type?: string }> } = {}) {
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={buildClient(gateway)} queryClient={newQueryClient()} netInfo={netInfo}>
          <ConnectionsScreen
            deps={{ openBrowser: opts.openBrowser ?? jest.fn(async () => ({ type: 'dismiss' })) }}
          />
        </ApiProvider>
      </SafeAreaProvider>
    );
  }

  it('renders connected cards (displayName AND service id), summary, count, active indicator, and the available catalog excluding disabled services', async () => {
    mount();

    await waitFor(() => {
      expect(screen.getByTestId('settings-connections-connection-slack_1')).toBeTruthy();
    });

    // Connected cards show BOTH the displayName and the raw service id (don't swap).
    const slackCard = screen.getByTestId('settings-connections-connection-slack_1');
    expect(within(slackCard).getByText('My Slack')).toBeTruthy();
    expect(within(slackCard).getByText('slack')).toBeTruthy();
    const githubCard = screen.getByTestId('settings-connections-connection-github_1');
    expect(within(githubCard).getByText('GitHub')).toBeTruthy();
    expect(within(githubCard).getByText('github')).toBeTruthy();

    // Hidden virtualization-proof count + the summary line (2 services / 2 connections).
    expect(screen.getByTestId('settings-connections-count')).toHaveTextContent('2');
    expect(screen.getByTestId('settings-connections-summary')).toHaveTextContent(
      '2 services connected · 2 total connections'
    );

    // Active indicator renders ONLY on the active connection.
    expect(screen.getByTestId('settings-connections-active-slack_1')).toBeTruthy();
    expect(screen.queryByTestId('settings-connections-active-github_1')).toBeNull();

    // Available catalog: enabled services grouped by category…
    expect(screen.getByTestId('settings-connections-category-communication')).toBeTruthy();
    expect(screen.getByTestId('settings-connections-service-slack')).toBeTruthy();
    expect(screen.getByTestId('settings-connections-service-linear')).toBeTruthy();
    expect(screen.getByTestId('settings-connections-service-aws-cli')).toBeTruthy();
    // …but the DISABLED service (Coming Soon) is excluded.
    expect(screen.queryByTestId('settings-connections-service-notion')).toBeNull();
  });

  it('"+ Add" opens the in-app browser at the sandbox connect URL (service= + token=) and refetches on close', async () => {
    // Second-response fixture: after the browser closes, the backend has the new connection.
    let connectionCalls = 0;
    gateway.on('GET', CONNECTIONS_URL, () => {
      connectionCalls += 1;
      return {
        body: {
          connections:
            connectionCalls === 1
              ? [SLACK_CONNECTION, GITHUB_CONNECTION]
              : [SLACK_CONNECTION, GITHUB_CONNECTION, LINEAR_CONNECTION],
        },
      };
    });
    const openBrowser = jest.fn(async () => ({ type: 'dismiss' as const }));
    mount({ openBrowser });

    await waitFor(() => {
      expect(screen.getByTestId('settings-connections-add-linear')).toBeTruthy();
    });
    expect(screen.getByTestId('settings-connections-count')).toHaveTextContent('2');

    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-connections-add-linear'));
    });

    // The browser opened the authenticated sandbox connect surface exactly once.
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(openBrowser).toHaveBeenCalledWith(
      `${SANDBOX_BASE}/connections?service=linear&token=${AUTH_TOKEN}`
    );

    // On close the list refetched — the new connection lands and the count updates.
    await waitFor(() => {
      expect(screen.getByTestId('settings-connections-count')).toHaveTextContent('3');
    });
    expect(screen.getByTestId('settings-connections-connection-linear_1')).toBeTruthy();
    expect(connectionCalls).toBe(2);
  });

  it('rename: inline input → PATCH /rename with body { newDisplayName }', async () => {
    gateway.on('PATCH', `${CONNECTIONS_URL}/slack_1/rename`, () => ({
      body: { success: true, connection: { ...SLACK_CONNECTION, displayName: 'New name' } },
    }));
    mount();

    await waitFor(() => {
      expect(screen.getByTestId('settings-connections-rename-slack_1')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('settings-connections-rename-slack_1'));
    const input = screen.getByTestId('settings-connections-rename-input-slack_1');
    expect(input.props.value).toBe('My Slack');

    fireEvent.changeText(input, 'New name');
    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-connections-rename-save-slack_1'));
    });

    await waitFor(() => {
      const patch = gateway.requests.find(
        (r) => r.method === 'PATCH' && r.url.endsWith('/api/connections/slack_1/rename')
      );
      expect(patch).toBeTruthy();
      // The backend reads `newDisplayName` (connections.routes.ts; web ConnectionsContext parity).
      expect(patch!.body).toEqual({ newDisplayName: 'New name' });
    });
    // Rename mode closed back to the actions row.
    expect(screen.queryByTestId('settings-connections-rename-input-slack_1')).toBeNull();
  });

  it('disconnect: two-step confirm → DELETE recorded only after Confirm, list refetches', async () => {
    let connectionCalls = 0;
    gateway.on('GET', CONNECTIONS_URL, () => {
      connectionCalls += 1;
      return {
        body: {
          connections:
            connectionCalls === 1 ? [SLACK_CONNECTION, GITHUB_CONNECTION] : [GITHUB_CONNECTION],
        },
      };
    });
    gateway.on('DELETE', `${CONNECTIONS_URL}/slack_1`, () => ({ body: { success: true } }));
    mount();

    await waitFor(() => {
      expect(screen.getByTestId('settings-connections-disconnect-slack_1')).toBeTruthy();
    });

    // Step 1: Remove → confirm step appears, NO DELETE issued yet.
    fireEvent.press(screen.getByTestId('settings-connections-disconnect-slack_1'));
    expect(screen.getByTestId('settings-connections-disconnect-confirm-slack_1')).toBeTruthy();
    expect(gateway.requests.find((r) => r.method === 'DELETE')).toBeUndefined();

    // Step 2: Confirm → DELETE recorded against the connectionId.
    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-connections-disconnect-confirm-slack_1'));
    });
    await waitFor(() => {
      const del = gateway.requests.find(
        (r) => r.method === 'DELETE' && r.url.endsWith('/api/connections/slack_1')
      );
      expect(del).toBeTruthy();
    });

    // The refetched list drops the card and the count updates.
    await waitFor(() => {
      expect(screen.queryByTestId('settings-connections-connection-slack_1')).toBeNull();
    });
    expect(screen.getByTestId('settings-connections-count')).toHaveTextContent('1');
  });

  it('exclusive services: already-connected exclusive is skipped from the catalog; Enable PATCHes toggle-active', async () => {
    gateway.on('GET', CONNECTIONS_URL, () => ({
      body: { connections: [SLACK_CONNECTION, AWS_CONNECTION] },
    }));
    gateway.on('PATCH', `${CONNECTIONS_URL}/aws_1/toggle-active`, () => ({
      body: { success: true, connection: { ...AWS_CONNECTION, isActive: true } },
    }));
    mount();

    await waitFor(() => {
      expect(screen.getByTestId('settings-connections-connection-aws_1')).toBeTruthy();
    });

    // The connected EXCLUSIVE service is skipped from the available catalog…
    expect(screen.queryByTestId('settings-connections-service-aws-cli')).toBeNull();
    // …while non-exclusive enabled services still show.
    expect(screen.getByTestId('settings-connections-service-linear')).toBeTruthy();

    // The inactive exclusive connection offers Enable → PATCH toggle-active { isActive: true }.
    const toggle = screen.getByTestId('settings-connections-toggle-aws_1');
    expect(toggle).toHaveTextContent('Enable');
    await act(async () => {
      fireEvent.press(toggle);
    });
    await waitFor(() => {
      const patch = gateway.requests.find(
        (r) => r.method === 'PATCH' && r.url.endsWith('/api/connections/aws_1/toggle-active')
      );
      expect(patch).toBeTruthy();
      expect(patch!.body).toEqual({ isActive: true });
    });
  });

  it('renders the error state when the connections fetch fails', async () => {
    gateway.on('GET', CONNECTIONS_URL, () => ({ status: 500, body: { error: 'boom' } }));
    mount();

    await waitFor(() => {
      expect(screen.getByTestId('settings-connections-error')).toBeTruthy();
    });
    // Regex — the SectionError node also contains the Retry button text.
    expect(screen.getByTestId('settings-connections-error')).toHaveTextContent(
      /Failed to load connected services/
    );
    expect(screen.queryByTestId('settings-connections-summary')).toBeNull();
    expect(screen.queryByTestId('settings-connections-count')).toBeNull();
  });
});
