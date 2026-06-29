/**
 * Settings → Notifications (`/settings/notifications`) — the NATIVE push path.
 *
 * Mounts `NotificationsScreen` under `ApiProvider` (mock-gateway sandbox HTTP)
 * with a FAKE injected `PushAdapter` (permission + device-token seams) —
 * `expo-notifications` is NEVER loaded under Jest (the real adapter is a lazy
 * require that no test path reaches). Asserts:
 *   1. status renders from the injected adapter + `GET /api/push/settings`
 *      (Checking... → Disabled / Enabled),
 *   2. Enable → permission request → `POST /api/push/subscribe` with the exact
 *      expected body (subscription.endpoint/platform/fcmToken +
 *      deviceInfo.platform/timestamp),
 *   3. Disable → `POST /api/push/unsubscribe { endpoint }`,
 *   4. notifyWhen toggle → `PUT /api/push/settings { notifyWhen: 'offline' }`
 *      + the selection is reflected optimistically,
 *   5. denied → blocked alert + the Open Settings seam fires.
 */

// ── Hoisted mocks (must precede the SUT import) ──────────────────────────────

// NotificationsScreen consumes useAppTheme → themeStore → MMKV. Mock it (in-memory).
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

// In-memory keychain (the authed sandbox client reads token + URL at request time).
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
import { NotificationsScreen } from '../src/features/settings/sections/notifications/NotificationsScreen';
import type {
  PushAdapter,
  PushPermissionState,
} from '../src/features/settings/sections/notifications/pushAdapter';
import { usePushRegistrationStore } from '../src/features/settings/sections/notifications/pushRegistrationStore';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

interface SecureStoreMock {
  __store: Map<string, string>;
}
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

const SANDBOX_BASE = 'https://sandbox.portable.test';
const DEVICE_TOKEN = 'apns-token-123';
const FIXED_NOW = '2026-06-11T12:00:00.000Z';

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** Inert NetInfo seam (online; no transitions needed). */
const netInfo: NetInfoLike = { addEventListener: () => () => {} };

interface FakeAdapterOpts {
  permission?: PushPermissionState;
  requestResult?: PushPermissionState;
  token?: string;
}

/** Controllable fake PushAdapter — never touches expo-notifications. */
function createFakeAdapter(opts: FakeAdapterOpts = {}) {
  const calls = { getPermission: 0, request: 0, getToken: 0 };
  const adapter: PushAdapter = {
    getPermissionState: async () => {
      calls.getPermission += 1;
      return opts.permission ?? 'granted';
    },
    requestPermission: async () => {
      calls.request += 1;
      return opts.requestResult ?? opts.permission ?? 'granted';
    },
    getDeviceToken: async () => {
      calls.getToken += 1;
      return opts.token ?? DEVICE_TOKEN;
    },
  };
  return { adapter, calls };
}

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

describe('settings notifications — native push path', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    return activeQueryClient;
  }

  beforeEach(() => {
    secureStore.__store.clear();
    secureStore.__store.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.__store.set(AUTH_TOKEN_KEY, 'good-token');
    usePushRegistrationStore.setState({ registeredEndpoint: null });
    gateway = createMockGateway();
    gateway.on('POST', `${SANDBOX_BASE}/api/push/subscribe`, () => ({ body: { success: true } }));
    gateway.on('POST', `${SANDBOX_BASE}/api/push/unsubscribe`, () => ({
      body: { success: true },
    }));
    gateway.on('PUT', `${SANDBOX_BASE}/api/push/settings`, () => ({
      body: { success: true, settings: {} },
    }));
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  function registerSettings(body: Record<string, unknown>): void {
    gateway.on('GET', `${SANDBOX_BASE}/api/push/settings`, () => ({ body }));
  }

  function renderScreen(adapter: PushAdapter, openSettings: jest.Mock = jest.fn()): jest.Mock {
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={buildClient(gateway)} queryClient={newQueryClient()} netInfo={netInfo}>
          <NotificationsScreen
            deps={{
              adapter,
              openSettings,
              platform: 'ios',
              now: () => new Date(FIXED_NOW),
            }}
            onBack={jest.fn()}
          />
        </ApiProvider>
      </SafeAreaProvider>
    );
    return openSettings;
  }

  it('renders Checking... then the Disabled status from the injected adapter + server settings', async () => {
    registerSettings({ notifyWhen: 'always' });
    renderScreen(createFakeAdapter({ permission: 'granted' }).adapter);

    // Permission + settings resolve async — the initial render is the loading state.
    expect(screen.getByTestId('settings-notifications-status')).toHaveTextContent('Checking...');
    expect(screen.getByTestId('settings-notifications-status-spinner')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByTestId('settings-notifications-status')).toHaveTextContent('Disabled');
    });
    // No server subscription → no When-to-Notify card; toggle offers Enable.
    expect(screen.queryByTestId('settings-notifications-when-card')).toBeNull();
    expect(screen.getByTestId('settings-notifications-toggle')).toHaveTextContent(
      'Enable Notifications'
    );
    expect(screen.getByTestId('settings-notifications-description')).toHaveTextContent(
      'Get notified when Claude finishes tasks, even when the app is in the background.'
    );
  });

  it('renders Enabled when permission is granted and THIS DEVICE registered its token', async () => {
    registerSettings({ enabled: true, taskComplete: true, notifyWhen: 'offline' });
    // The per-device registration (persisted after a successful subscribe) is
    // the status source — seeded here as if this device had subscribed before.
    usePushRegistrationStore.setState({ registeredEndpoint: DEVICE_TOKEN });
    renderScreen(createFakeAdapter({ permission: 'granted' }).adapter);

    await waitFor(() => {
      expect(screen.getByTestId('settings-notifications-status')).toHaveTextContent('Enabled');
    });
    expect(screen.getByTestId('settings-notifications-toggle')).toHaveTextContent(
      'Disable Notifications'
    );
    // When-to-Notify card reflects the server value.
    expect(screen.getByTestId('settings-notifications-when-card')).toBeTruthy();
    expect(screen.getByTestId('settings-notifications-when-offline')).toBeSelected();
    expect(screen.getByTestId('settings-notifications-when-always')).not.toBeSelected();
  });

  it('does NOT trust the user-level server `enabled` flag: a fresh device shows Disabled', async () => {
    // Multi-device regression: the user enabled push on another device (server flag
    // true) but THIS device never registered a token — the page must offer
    // Enable, not lie about delivery.
    registerSettings({ enabled: true, taskComplete: true, notifyWhen: 'always' });
    renderScreen(createFakeAdapter({ permission: 'granted' }).adapter);

    await waitFor(() => {
      expect(screen.getByTestId('settings-notifications-status')).toHaveTextContent('Disabled');
    });
    expect(screen.getByTestId('settings-notifications-toggle')).toHaveTextContent(
      'Enable Notifications'
    );
  });

  it('Enable → requests permission, reads the device token, POSTs the subscribe body', async () => {
    registerSettings({ notifyWhen: 'always' });
    const { adapter, calls } = createFakeAdapter({
      permission: 'undetermined',
      requestResult: 'granted',
      token: DEVICE_TOKEN,
    });
    renderScreen(adapter);

    await waitFor(() => {
      expect(screen.getByTestId('settings-notifications-status')).toHaveTextContent('Disabled');
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-notifications-toggle'));
    });

    await waitFor(() => {
      expect(
        gateway.requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/push/subscribe'))
      ).toBeTruthy();
    });

    const subscribe = gateway.requests.find(
      (r) => r.method === 'POST' && r.url.endsWith('/api/push/subscribe')
    )!;
    expect(subscribe.body).toEqual({
      subscription: { endpoint: DEVICE_TOKEN, platform: 'ios', fcmToken: DEVICE_TOKEN },
      deviceInfo: { platform: 'ios', timestamp: FIXED_NOW },
    });
    expect(subscribe.headers.Authorization).toBe('Bearer good-token');
    expect(calls.request).toBe(1);
    expect(calls.getToken).toBe(1);

    // UI flips to enabled, the When-to-Notify card appears, and THIS device's
    // registration is persisted (the durable status source).
    await waitFor(() => {
      expect(screen.getByTestId('settings-notifications-status')).toHaveTextContent('Enabled');
    });
    expect(screen.getByTestId('settings-notifications-when-card')).toBeTruthy();
    expect(usePushRegistrationStore.getState().registeredEndpoint).toBe(DEVICE_TOKEN);
  });

  it('Disable → POSTs unsubscribe with the device token endpoint', async () => {
    registerSettings({ enabled: true, taskComplete: true, notifyWhen: 'always' });
    usePushRegistrationStore.setState({ registeredEndpoint: DEVICE_TOKEN });
    renderScreen(createFakeAdapter({ permission: 'granted', token: DEVICE_TOKEN }).adapter);

    await waitFor(() => {
      expect(screen.getByTestId('settings-notifications-status')).toHaveTextContent('Enabled');
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-notifications-toggle'));
    });

    await waitFor(() => {
      expect(
        gateway.requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/push/unsubscribe'))
      ).toBeTruthy();
    });
    const unsubscribe = gateway.requests.find(
      (r) => r.method === 'POST' && r.url.endsWith('/api/push/unsubscribe')
    )!;
    expect(unsubscribe.body).toEqual({ endpoint: DEVICE_TOKEN });

    await waitFor(() => {
      expect(screen.getByTestId('settings-notifications-status')).toHaveTextContent('Disabled');
    });
    expect(screen.queryByTestId('settings-notifications-when-card')).toBeNull();
    expect(usePushRegistrationStore.getState().registeredEndpoint).toBeNull();
  });

  it('notifyWhen pick → PUT { notifyWhen: "offline" } and the selection is reflected', async () => {
    registerSettings({ enabled: true, taskComplete: true, notifyWhen: 'always' });
    usePushRegistrationStore.setState({ registeredEndpoint: DEVICE_TOKEN });
    renderScreen(createFakeAdapter({ permission: 'granted' }).adapter);

    await waitFor(() => {
      expect(screen.getByTestId('settings-notifications-when-card')).toBeTruthy();
    });
    expect(screen.getByTestId('settings-notifications-when-always')).toBeSelected();

    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-notifications-when-offline'));
    });

    await waitFor(() => {
      expect(
        gateway.requests.find((r) => r.method === 'PUT' && r.url.endsWith('/api/push/settings'))
      ).toBeTruthy();
    });
    const put = gateway.requests.find(
      (r) => r.method === 'PUT' && r.url.endsWith('/api/push/settings')
    )!;
    expect(put.body).toEqual({ notifyWhen: 'offline' });

    await waitFor(() => {
      expect(screen.getByTestId('settings-notifications-when-offline')).toBeSelected();
    });
    expect(screen.getByTestId('settings-notifications-when-always')).not.toBeSelected();
  });

  it('denied → shows the blocked alert and fires the Open Settings seam', async () => {
    registerSettings({ notifyWhen: 'always' });
    const openSettings = renderScreen(
      createFakeAdapter({ permission: 'denied' }).adapter,
      jest.fn()
    );

    await waitFor(() => {
      expect(screen.getByTestId('settings-notifications-status')).toHaveTextContent('Blocked');
    });
    expect(screen.getByTestId('settings-notifications-blocked')).toHaveTextContent(
      'Notifications are blocked. Go to Settings > App > Notifications to enable them.'
    );
    // The Enable/Disable button is replaced by the blocked alert.
    expect(screen.queryByTestId('settings-notifications-toggle')).toBeNull();

    fireEvent.press(screen.getByTestId('settings-notifications-open-settings'));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});
