/**
 * Push notification setup — `usePushDeepLink`, `PushPermissionPrompt`,
 * and `PushSetupLayer`.
 *
 * `expo-notifications` is mocked at the top so the lazy `require` seam resolves to
 * a controllable fake (the real native module never loads). The `PushAdapter` is
 * injected into the prompt via deps for full controllability, and the deep-link
 * hook takes an injected router spy.
 */

// ── Hoisted mocks (must precede the SUT import) ─────────────────────────────────

// PushPermissionPrompt → useNotificationsViewModel → useAppTheme → themeStore →
// MMKV; pushRegistrationStore also persists through MMKV.
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

// In-memory keychain — the authed sandbox client reads token + URL at request time.
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

// expo-router: inject a spy router so no navigation context is needed.
jest.mock('expo-router', () => ({
  useRouter: jest.fn(() => ({ push: jest.fn() })),
}));

// expo-notifications: lazily required at runtime — mock it so no native module
// loads. Implementations are overridden per test below.
jest.mock('expo-notifications', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listeners: Array<(response: any) => void> = [];
  return {
    __listeners: listeners,
    getLastNotificationResponseAsync: jest.fn(async () => null),
    addNotificationResponseReceivedListener: jest.fn((cb: (r: unknown) => void) => {
      listeners.push(cb);
      return {
        remove: jest.fn(() => {
          const idx = listeners.indexOf(cb);
          if (idx !== -1) listeners.splice(idx, 1);
        }),
      };
    }),
    setNotificationHandler: jest.fn(),
    setNotificationChannelAsync: jest.fn(async () => null),
    AndroidImportance: { MAX: 5 },
  };
});

// ── Imports ─────────────────────────────────────────────────────────────────────

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { PushPermissionPrompt } from '../src/features/settings/sections/notifications/PushPermissionPrompt';
import type {
  PushAdapter,
  PushPermissionState,
} from '../src/features/settings/sections/notifications/pushAdapter';
import { usePushRegistrationStore } from '../src/features/settings/sections/notifications/pushRegistrationStore';
import { PushSetupLayer } from '../src/features/settings/sections/notifications/PushSetupLayer';
import { usePushDeepLink } from '../src/features/settings/sections/notifications/usePushDeepLink';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

// ── Shared test helpers ──────────────────────────────────────────────────────────

interface ExpoNotificationsMock {
  __listeners: Array<(r: unknown) => void>;
  getLastNotificationResponseAsync: jest.Mock;
  addNotificationResponseReceivedListener: jest.Mock;
  setNotificationHandler: jest.Mock;
  setNotificationChannelAsync: jest.Mock;
}
function getNotifMock(): ExpoNotificationsMock {
  return jest.requireMock('expo-notifications') as ExpoNotificationsMock;
}

interface SecureStoreMock {
  __store: Map<string, string>;
}
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

const SANDBOX_BASE = 'https://sandbox.portable.test';
const DEVICE_TOKEN = 'apns-token-push-test-456';
const netInfo: NetInfoLike = { addEventListener: () => () => {} };

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const SUBSCRIBE_URL = `${SANDBOX_BASE}/api/push/subscribe`;

function findSubscribe(gateway: MockGateway) {
  return gateway.requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/push/subscribe'));
}

interface FakeAdapterOpts {
  permission?: PushPermissionState;
  requestResult?: PushPermissionState;
  token?: string;
}

/** Controllable fake PushAdapter — never touches expo-notifications. */
function createFakeAdapter(opts: FakeAdapterOpts = {}): PushAdapter {
  return {
    getPermissionState: jest.fn(async () => opts.permission ?? 'undetermined'),
    requestPermission: jest.fn(async () => opts.requestResult ?? opts.permission ?? 'granted'),
    getDeviceToken: jest.fn(async () => opts.token ?? DEVICE_TOKEN),
  };
}

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

// ── usePushDeepLink ───────────────────────────────────────────────────────────────

describe('usePushDeepLink', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getNotifMock().__listeners.length = 0;
    getNotifMock().getLastNotificationResponseAsync.mockResolvedValue(null);
  });

  function makeResponse(chatId: string | undefined) {
    return {
      notification: { request: { content: { data: chatId !== undefined ? { chatId } : {} } } },
    };
  }

  it('cold start: navigates to the chat when a launching response carries a chatId', async () => {
    getNotifMock().getLastNotificationResponseAsync.mockResolvedValue(makeResponse('abc'));
    const push = jest.fn();
    renderHook(() => usePushDeepLink({ router: { push } }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/(app)/(tabs)/chat/abc'));
  });

  it('cold start: a null launching response navigates nowhere', async () => {
    getNotifMock().getLastNotificationResponseAsync.mockResolvedValue(null);
    const push = jest.fn();
    renderHook(() => usePushDeepLink({ router: { push } }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('warm start: a tap with a chatId pushes the chat route', async () => {
    const push = jest.fn();
    renderHook(() => usePushDeepLink({ router: { push } }));

    await act(async () => {
      getNotifMock().__listeners.forEach((cb) => cb(makeResponse('xyz')));
    });
    expect(push).toHaveBeenCalledWith('/(app)/(tabs)/chat/xyz');
  });

  it('warm start: a tap with no chatId falls back to the chats list', async () => {
    const push = jest.fn();
    renderHook(() => usePushDeepLink({ router: { push } }));

    await act(async () => {
      getNotifMock().__listeners.forEach((cb) => cb(makeResponse(undefined)));
    });
    expect(push).toHaveBeenCalledWith('/(app)/(tabs)/chats');
  });

  it('cleanup: the listener subscription is removed on unmount', () => {
    const { unmount } = renderHook(() => usePushDeepLink({ router: { push: jest.fn() } }));
    expect(getNotifMock().addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);

    unmount();
    expect(getNotifMock().__listeners.length).toBe(0);
  });
});

// ── PushPermissionPrompt ───────────────────────────────────────────────────────────

describe('PushPermissionPrompt', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    return activeQueryClient;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    secureStore.__store.clear();
    secureStore.__store.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.__store.set(AUTH_TOKEN_KEY, 'good-token');
    act(() =>
      usePushRegistrationStore.setState({ registeredEndpoint: null, permissionAsked: false })
    );
    gateway = createMockGateway();
    gateway.on('GET', `${SANDBOX_BASE}/api/push/settings`, () => ({
      body: { enabled: false, notifyWhen: 'always' },
    }));
    gateway.on('POST', SUBSCRIBE_URL, () => ({ body: { success: true } }));
    gateway.on('POST', `${SANDBOX_BASE}/api/push/unsubscribe`, () => ({ body: { success: true } }));
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  function renderPrompt(adapter: PushAdapter) {
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={buildClient(gateway)} queryClient={newQueryClient()} netInfo={netInfo}>
          <PushPermissionPrompt deps={{ adapter }} />
        </ApiProvider>
      </SafeAreaProvider>
    );
  }

  it('permission already granted + no registered endpoint → silently registers, no modal', async () => {
    const adapter = createFakeAdapter({ permission: 'granted', token: DEVICE_TOKEN });
    renderPrompt(adapter);

    await waitFor(() => expect(findSubscribe(gateway)).toBeTruthy());
    // The POST carries THIS device's APNs/FCM token + platform.
    const body = findSubscribe(gateway)?.body as {
      subscription: { endpoint: string; platform: string; fcmToken: string };
      deviceInfo: { platform: string };
    };
    expect(body.subscription.endpoint).toBe(DEVICE_TOKEN);
    expect(body.subscription.fcmToken).toBe(DEVICE_TOKEN);
    expect(typeof body.subscription.platform).toBe('string');
    expect(body.deviceInfo.platform).toBe(body.subscription.platform);
    expect(screen.queryByTestId('push-permission-enable')).toBeNull();
  });

  it('permission granted + endpoint already registered → does nothing', async () => {
    act(() => usePushRegistrationStore.setState({ registeredEndpoint: DEVICE_TOKEN }));
    const adapter = createFakeAdapter({ permission: 'granted', token: DEVICE_TOKEN });
    renderPrompt(adapter);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(findSubscribe(gateway)).toBeUndefined();
    expect(screen.queryByTestId('push-permission-enable')).toBeNull();
  });

  it('undetermined + not asked → shows the modal, marks asked, Enable registers', async () => {
    const adapter = createFakeAdapter({
      permission: 'undetermined',
      requestResult: 'granted',
      token: DEVICE_TOKEN,
    });
    renderPrompt(adapter);

    await waitFor(() => expect(screen.getByTestId('push-permission-enable')).toBeTruthy(), {
      timeout: 3000,
    });
    expect(usePushRegistrationStore.getState().permissionAsked).toBe(true);

    await act(async () => {
      fireEvent.press(screen.getByTestId('push-permission-enable'));
    });
    await waitFor(() => expect(findSubscribe(gateway)).toBeTruthy());
    const body = findSubscribe(gateway)?.body as {
      subscription: { endpoint: string; platform: string; fcmToken: string };
    };
    expect(body.subscription.endpoint).toBe(DEVICE_TOKEN);
    expect(typeof body.subscription.platform).toBe('string');
  });

  it('undetermined + not asked + Not Now → closes without registering', async () => {
    const adapter = createFakeAdapter({ permission: 'undetermined' });
    renderPrompt(adapter);

    await waitFor(() => expect(screen.getByTestId('push-permission-not-now')).toBeTruthy(), {
      timeout: 3000,
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('push-permission-not-now'));
    });

    expect(findSubscribe(gateway)).toBeUndefined();
    expect(screen.queryByTestId('push-permission-enable')).toBeNull();
  });

  it('already asked + undetermined → never shows the modal', async () => {
    act(() => usePushRegistrationStore.setState({ permissionAsked: true }));
    const adapter = createFakeAdapter({ permission: 'undetermined' });
    renderPrompt(adapter);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('push-permission-enable')).toBeNull();
    expect(findSubscribe(gateway)).toBeUndefined();
  });

  it('one-time: once the prompt is shown, a fresh mount never shows it again', async () => {
    // First launch: undetermined + not asked → the modal appears and marks asked.
    const { unmount } = renderPrompt(createFakeAdapter({ permission: 'undetermined' }));
    await waitFor(() => expect(screen.getByTestId('push-permission-not-now')).toBeTruthy(), {
      timeout: 3000,
    });
    expect(usePushRegistrationStore.getState().permissionAsked).toBe(true);

    const firstQueryClient = activeQueryClient;
    unmount();
    firstQueryClient?.clear();

    // Next launch (the persisted `permissionAsked` survives) → never shown again.
    renderPrompt(createFakeAdapter({ permission: 'undetermined' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('push-permission-enable')).toBeNull();
    expect(screen.queryByTestId('push-permission-not-now')).toBeNull();
  });
});

// ── PushSetupLayer ─────────────────────────────────────────────────────────────────

describe('PushSetupLayer', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;
  const originalOS = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    secureStore.__store.clear();
    secureStore.__store.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.__store.set(AUTH_TOKEN_KEY, 'good-token');
    // Granted + already registered → the prompt is a no-op (no modal / no POST noise).
    act(() =>
      usePushRegistrationStore.setState({ registeredEndpoint: DEVICE_TOKEN, permissionAsked: true })
    );
    gateway = createMockGateway();
    gateway.on('GET', `${SANDBOX_BASE}/api/push/settings`, () => ({
      body: { enabled: true, notifyWhen: 'always' },
    }));
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  function mountLayer() {
    activeQueryClient = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    const adapter = createFakeAdapter({ permission: 'granted', token: DEVICE_TOKEN });
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider
          client={buildClient(gateway)}
          queryClient={activeQueryClient}
          netInfo={netInfo}
        >
          <PushSetupLayer
            deps={{ prompt: { adapter }, deepLink: { router: { push: jest.fn() } } }}
          />
        </ApiProvider>
      </SafeAreaProvider>
    );
  }

  it('sets a foreground notification handler that shows banner + list + sound + badge', async () => {
    mountLayer();

    await waitFor(() => expect(getNotifMock().setNotificationHandler).toHaveBeenCalledTimes(1));
    const arg = getNotifMock().setNotificationHandler.mock.calls[0][0] as {
      handleNotification: () => Promise<Record<string, boolean>>;
    };
    await expect(arg.handleNotification()).resolves.toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    });
  });

  it('creates the Android channel "portable-notifications" on Android', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    mountLayer();

    await waitFor(() =>
      expect(getNotifMock().setNotificationChannelAsync).toHaveBeenCalledWith(
        'portable-notifications',
        expect.objectContaining({ name: 'Portable Notifications', importance: 5 })
      )
    );
  });

  it('does NOT create a notification channel on iOS', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    mountLayer();

    await waitFor(() => expect(getNotifMock().setNotificationHandler).toHaveBeenCalled());
    expect(getNotifMock().setNotificationChannelAsync).not.toHaveBeenCalled();
  });
});
