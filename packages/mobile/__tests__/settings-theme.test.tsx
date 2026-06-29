/**
 * Theme settings page (`/settings/theme`).
 *
 * Mounts `ThemeSectionScreen` under `ApiProvider` (mock-gateway sandbox client)
 * with `debounceMs: 0` and asserts:
 *   1. brightness select writes the store AND fires `PUT /api/user/theme`
 *      whose `body.themeConfig.brightness` matches;
 *   2. the conditional modifier toggles per brightness (system → OLED + Paper,
 *      light → Paper only, dark → OLED only);
 *   3. an accent picked in the modal writes the store + PUTs, and the trigger
 *      shows the accent's display label;
 *   4. the custom accent reveals hex inputs — a valid #RRGGBB pair commits
 *      `setCustomGradient` and the PUT carries both values; an invalid hex
 *      does NOT commit;
 *   5. Bold Mode / Gradients toggles (Gradients disabled until Bold is on);
 *   6. Reset fires `DELETE /api/user/theme` + store back to
 *      `MOBILE_DEFAULT_THEME_OPTIONS`;
 *   7. the page itself re-themes live (root background flips paper → dark).
 */

// ── Hoisted mocks (must precede the SUT import) ──────────────────────────────

// useAppTheme → themeStore → MMKV: mock the native nitro module (in-memory).
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

// The native NetInfo module must never load under Jest; connectivity is injected.
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { ThemeOptions } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { ThemeSectionScreen } from '../src/features/settings/sections/theme/ThemeSectionScreen';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { MOBILE_DEFAULT_THEME_OPTIONS, useThemeStore } from '../src/features/state/themeStore';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

const secureStore = (jest.requireMock('expo-secure-store') as { __store: Map<string, string> })
  .__store;

const SANDBOX_BASE = 'https://sandbox.portable.test';
const THEME_URL = `${SANDBOX_BASE}/api/user/theme`;

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const inertNetInfo: NetInfoLike = { addEventListener: () => () => {} };

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

describe('settings — Theme section', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  beforeEach(() => {
    secureStore.clear();
    secureStore.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.set(AUTH_TOKEN_KEY, 'good-token');
    gateway = createMockGateway();
    gateway.on('PUT', THEME_URL, () => ({ body: { success: true } }));
    gateway.on('DELETE', THEME_URL, () => ({ body: { success: true } }));
    onlineManager.setOnline(true);
    // Reset to the mobile defaults AND clear the custom fields (zustand `set`
    // merges, so `reset()` alone would leak custom values across tests).
    act(() => {
      useThemeStore.setState({
        ...MOBILE_DEFAULT_THEME_OPTIONS,
        customGradientStart: undefined,
        customGradientEnd: undefined,
      });
    });
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  function mountScreen(): void {
    activeQueryClient = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider
          client={buildClient(gateway)}
          queryClient={activeQueryClient}
          netInfo={inertNetInfo}
        >
          <ThemeSectionScreen deps={{ debounceMs: 0 }} onBack={() => {}} />
        </ApiProvider>
      </SafeAreaProvider>
    );
  }

  const themePuts = () => gateway.requests.filter((r) => r.method === 'PUT' && r.url === THEME_URL);
  const themeDeletes = () =>
    gateway.requests.filter((r) => r.method === 'DELETE' && r.url === THEME_URL);
  const lastPutConfig = (): ThemeOptions =>
    (themePuts().at(-1)!.body as { themeConfig: ThemeOptions }).themeConfig;

  it('brightness select writes the store and PUTs the matching themeConfig', async () => {
    mountScreen();

    fireEvent.press(screen.getByTestId('settings-theme-brightness-dark'));

    expect(useThemeStore.getState().brightness).toBe('dark');
    await waitFor(() => expect(themePuts().length).toBeGreaterThanOrEqual(1));
    expect(lastPutConfig().brightness).toBe('dark');
  });

  it('shows Paper only on light (default), both modifiers on system, OLED only on dark', async () => {
    mountScreen();

    // Default = light (MOBILE_DEFAULT_THEME_OPTIONS) → Paper only.
    expect(screen.getByTestId('settings-theme-paper')).toBeTruthy();
    expect(screen.queryByTestId('settings-theme-oled')).toBeNull();

    fireEvent.press(screen.getByTestId('settings-theme-brightness-system'));
    expect(screen.getByTestId('settings-theme-paper')).toBeTruthy();
    expect(screen.getByTestId('settings-theme-oled')).toBeTruthy();

    fireEvent.press(screen.getByTestId('settings-theme-brightness-dark'));
    expect(screen.getByTestId('settings-theme-oled')).toBeTruthy();
    expect(screen.queryByTestId('settings-theme-paper')).toBeNull();
  });

  it('modifier toggles write the store and PUT (OLED on dark)', async () => {
    mountScreen();

    fireEvent.press(screen.getByTestId('settings-theme-brightness-dark'));
    fireEvent(screen.getByTestId('settings-theme-oled'), 'valueChange', true);

    expect(useThemeStore.getState().useOled).toBe(true);
    await waitFor(() => {
      expect(themePuts().length).toBeGreaterThanOrEqual(1);
      expect(lastPutConfig().useOled).toBe(true);
    });
    expect(lastPutConfig().brightness).toBe('dark');
  });

  it('accent picked in the modal writes the store, PUTs, and updates the trigger label', async () => {
    mountScreen();

    // Default accent label (orange → 'Orange Cords').
    expect(screen.getByTestId('settings-theme-accent-label')).toHaveTextContent('Orange Cords');
    expect(screen.queryByTestId('settings-theme-accent-modal')).toBeNull();

    fireEvent.press(screen.getByTestId('settings-theme-accent-trigger'));
    expect(screen.getByTestId('settings-theme-accent-modal')).toBeTruthy();

    fireEvent.press(screen.getByTestId('settings-theme-accent-option-teal'));

    expect(useThemeStore.getState().accent).toBe('teal');
    expect(screen.queryByTestId('settings-theme-accent-modal')).toBeNull();
    expect(screen.getByTestId('settings-theme-accent-label')).toHaveTextContent('A Cyan Manifesto');
    await waitFor(() => expect(themePuts().length).toBeGreaterThanOrEqual(1));
    expect(lastPutConfig().accent).toBe('teal');
  });

  it('custom accent shows hex inputs; a valid pair commits setCustomGradient and PUTs both values', async () => {
    mountScreen();

    expect(screen.queryByTestId('settings-theme-custom-card')).toBeNull();
    fireEvent.press(screen.getByTestId('settings-theme-accent-trigger'));
    fireEvent.press(screen.getByTestId('settings-theme-accent-option-custom'));

    expect(useThemeStore.getState().accent).toBe('custom');
    expect(screen.getByTestId('settings-theme-custom-card')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('settings-theme-custom-start'), '#112233');
    fireEvent.changeText(screen.getByTestId('settings-theme-custom-end'), '#445566');

    expect(useThemeStore.getState().customGradientStart).toBe('#112233');
    expect(useThemeStore.getState().customGradientEnd).toBe('#445566');
    await waitFor(() => {
      expect(themePuts().length).toBeGreaterThanOrEqual(1);
      expect(lastPutConfig().customGradientStart).toBe('#112233');
    });
    expect(lastPutConfig().customGradientEnd).toBe('#445566');
    expect(lastPutConfig().accent).toBe('custom');
  });

  it('an invalid hex draft does NOT commit to the store', async () => {
    mountScreen();

    fireEvent.press(screen.getByTestId('settings-theme-accent-trigger'));
    fireEvent.press(screen.getByTestId('settings-theme-accent-option-custom'));

    fireEvent.changeText(screen.getByTestId('settings-theme-custom-start'), '#11ZZ33');

    expect(useThemeStore.getState().customGradientStart).toBeUndefined();
  });

  it('Bold Mode toggle writes the store + PUTs; Gradients is gated on Bold', async () => {
    mountScreen();

    // Gradients disabled while boldMode is off.
    expect(screen.getByTestId('settings-theme-gradients').props.disabled).toBe(true);

    fireEvent(screen.getByTestId('settings-theme-bold'), 'valueChange', true);
    expect(useThemeStore.getState().boldMode).toBe(true);
    await waitFor(() => {
      expect(themePuts().length).toBeGreaterThanOrEqual(1);
      expect(lastPutConfig().boldMode).toBe(true);
    });

    expect(screen.getByTestId('settings-theme-gradients').props.disabled).toBe(false);
    fireEvent(screen.getByTestId('settings-theme-gradients'), 'valueChange', false);
    expect(useThemeStore.getState().useGradients).toBe(false);
    await waitFor(() => expect(lastPutConfig().useGradients).toBe(false));
  });

  it('reset fires DELETE /api/user/theme and restores the mobile defaults', async () => {
    mountScreen();

    // Dirty the theme first.
    fireEvent.press(screen.getByTestId('settings-theme-brightness-dark'));
    fireEvent.press(screen.getByTestId('settings-theme-accent-trigger'));
    fireEvent.press(screen.getByTestId('settings-theme-accent-option-teal'));
    expect(useThemeStore.getState().accent).toBe('teal');

    fireEvent.press(screen.getByTestId('settings-theme-reset'));

    await waitFor(() => expect(themeDeletes().length).toBe(1));
    await waitFor(() => {
      expect(useThemeStore.getState().brightness).toBe(MOBILE_DEFAULT_THEME_OPTIONS.brightness);
    });
    expect(useThemeStore.getState().accent).toBe(MOBILE_DEFAULT_THEME_OPTIONS.accent);
    expect(useThemeStore.getState().usePaper).toBe(true);
    expect(useThemeStore.getState().customGradientStart).toBeUndefined();
  });

  it('re-themes live: the root background flips from paper to dark on brightness change', async () => {
    mountScreen();

    // Default light + usePaper → resolved 'paper' background.
    expect(screen.getByTestId('settings-theme')).toHaveStyle({ backgroundColor: '#F5F1E8' });

    fireEvent.press(screen.getByTestId('settings-theme-brightness-dark'));

    expect(screen.getByTestId('settings-theme')).toHaveStyle({ backgroundColor: '#0D1117' });
  });
});
