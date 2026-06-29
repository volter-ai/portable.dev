/**
 * Settings shell + profile photo + account deletion.
 *
 * With mocked sandbox/gateway HTTP + Clerk, render the settings root and assert:
 *   1. every section nav entry is present and reachable (press → navigate to its
 *      Expo Router route),
 *   2. the profile-photo flow calls Clerk get (imageUrl) / update
 *      (`setProfileImage({ file })`) / delete (`setProfileImage({ file: null })`),
 *   3. the account-deletion confirmation modal issues `DELETE /auth/account`
 *      (Bearer, no cookies) then signs out and navigates to sign-in.
 */

// ── Hoisted mocks (must precede the SUT import) ──────────────────────────────

// SettingsScreen now consumes useAppTheme → themeStore → MMKV. Mock it (in-memory).
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

// In-memory keychain (secureAuthStore + relayUrlStore read this at module scope).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    getItemAsync: async (k: string) => (store.has(k) ? store.get(k)! : null),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});

// avatarPicker imports expo-image-picker at module scope; the ViewModel injects a
// fake `pickAvatar` in tests, so the native module just needs to be inert.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: true })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: [] })),
}));

jest.mock('@clerk/clerk-expo', () => {
  const setProfileImage = jest.fn(async () => ({}));
  const signOut = jest.fn(async () => {});
  const user = {
    fullName: 'Ada Lovelace',
    username: 'ada',
    hasImage: true,
    imageUrl: 'https://img.clerk.example/ada.jpg',
    primaryEmailAddress: { emailAddress: 'ada@example.com' },
    setProfileImage,
  };
  return {
    __mock: { setProfileImage, signOut, user },
    useUser: () => ({ isLoaded: true, isSignedIn: true, user }),
    useClerk: () => ({ signOut }),
  };
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Modal } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { SettingsScreen } from '../src/features/settings/SettingsScreen';
import { SETTINGS_SECTIONS } from '../src/features/settings/settingsSections';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

interface ClerkMock {
  __mock: { setProfileImage: jest.Mock; signOut: jest.Mock; user: { imageUrl: string } };
}
const clerk = jest.requireMock('@clerk/clerk-expo') as ClerkMock;
const secureStore = (jest.requireMock('expo-secure-store') as { __store: Map<string, string> })
  .__store;

interface RenderOpts {
  pickAvatar?: () => Promise<string | null>;
  navigate?: jest.Mock;
  signOut?: jest.Mock;
  gateway?: MockGateway;
}

function renderSettings(opts: RenderOpts = {}) {
  const navigate = opts.navigate ?? jest.fn();
  const deleteAccountRequest = opts.gateway
    ? (token: string) =>
        new GatewayClient({
          gatewayUrl: opts.gateway!.baseUrl,
          fetchImpl: opts.gateway!.fetchImpl,
        }).deleteAccount(token)
    : undefined;

  render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <SettingsScreen
        pickAvatar={opts.pickAvatar}
        navigate={navigate}
        signOut={opts.signOut}
        deleteAccountRequest={deleteAccountRequest}
      />
    </SafeAreaProvider>
  );
  return { navigate };
}

describe('settings shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    secureStore.clear();
    clerk.__mock.user.imageUrl = 'https://img.clerk.example/ada.jpg';
  });

  it('renders a reachable nav entry for every settings section', () => {
    const { navigate } = renderSettings();

    expect(SETTINGS_SECTIONS.length).toBeGreaterThan(0);
    for (const section of SETTINGS_SECTIONS) {
      const row = screen.getByTestId(`settings-section-${section.key}`);
      expect(row).toBeTruthy();
      fireEvent.press(row);
      expect(navigate).toHaveBeenCalledWith(section.route);
    }
    // Each entry navigated to a DISTINCT Expo Router route.
    expect(navigate).toHaveBeenCalledTimes(SETTINGS_SECTIONS.length);
  });

  it('profile photo: GET renders the Clerk image, UPDATE and DELETE call Clerk', async () => {
    renderSettings({ pickAvatar: async () => 'data:image/jpeg;base64,QUJD' });

    // GET — the current avatar comes from Clerk's `user.imageUrl`.
    expect(screen.getByTestId('settings-avatar-image').props.source).toEqual({
      uri: 'https://img.clerk.example/ada.jpg',
    });

    // UPDATE — avatar press opens the photo action sheet, then
    // "Choose photo" picks → Clerk `setProfileImage({ file })`. On iOS
    // (jest-expo default) the pick is DEFERRED to the sheet Modal's
    // `onDismiss` — presenting the native picker mid-dismissal is a UIKit
    // presentation race — so the test drives the dismissal callback.
    fireEvent.press(screen.getByTestId('settings-avatar'));
    expect(screen.getByTestId('settings-avatar-sheet')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-avatar-change'));
    });
    // Sheet closed, but the pick has NOT started yet (deferred to onDismiss).
    expect(screen.queryByTestId('settings-avatar-sheet')).toBeNull();
    expect(clerk.__mock.setProfileImage).not.toHaveBeenCalled();
    await act(async () => {
      // (cast through `never`: the React 18/19 @types mismatch, the
      // chat-message-list FlatList precedent)
      screen.UNSAFE_getByType(Modal as never).props.onDismiss();
    });
    await waitFor(() =>
      expect(clerk.__mock.setProfileImage).toHaveBeenCalledWith({
        file: 'data:image/jpeg;base64,QUJD',
      })
    );

    // DELETE — re-open the sheet → "Remove photo" → `setProfileImage({ file: null })`.
    fireEvent.press(screen.getByTestId('settings-avatar'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-avatar-remove'));
    });
    await waitFor(() => expect(clerk.__mock.setProfileImage).toHaveBeenCalledWith({ file: null }));
  });

  it('search filters the section list and clears back to the full catalog', () => {
    renderSettings();

    // Full catalog rendered without a query.
    expect(screen.getByTestId('settings-section-theme')).toBeTruthy();
    expect(screen.getByTestId('settings-section-secrets')).toBeTruthy();

    // Keyword match (title/description/keywords are searchable).
    fireEvent.changeText(screen.getByTestId('settings-search'), 'brightness');
    expect(screen.getByTestId('settings-section-theme')).toBeTruthy();
    expect(screen.queryByTestId('settings-section-secrets')).toBeNull();

    // No-results message for a miss.
    fireEvent.changeText(screen.getByTestId('settings-search'), 'zzz-nope');
    expect(screen.getByTestId('settings-search-empty')).toBeTruthy();

    // Clearing restores the catalog.
    fireEvent.press(screen.getByTestId('settings-search-clear'));
    expect(screen.getByTestId('settings-section-secrets')).toBeTruthy();
  });

  it('account deletion: confirm modal issues DELETE /auth/account then signs out + routes to sign-in', async () => {
    secureStore.set(AUTH_TOKEN_KEY, 'jwt-abc');
    const gateway = createMockGateway();
    gateway.on('DELETE', '/auth/account', () => ({ body: { success: true } }));
    const signOut = jest.fn(async () => {});

    const { navigate } = renderSettings({ gateway, signOut });

    // Open the inline Danger-Zone confirmation.
    fireEvent.press(screen.getByTestId('settings-delete-account'));
    expect(screen.getByTestId('settings-delete-confirm-panel')).toBeTruthy();

    // Confirm is gated until the user re-types their email.
    fireEvent.press(screen.getByTestId('settings-delete-confirm'));
    expect(gateway.requests.some((r) => r.method === 'DELETE')).toBe(false);

    fireEvent.changeText(screen.getByTestId('settings-delete-email-input'), 'ada@example.com');
    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-delete-confirm'));
    });

    // DELETE /auth/account issued with Bearer + no cookies.
    await waitFor(() =>
      expect(
        gateway.requests.find((r) => r.method === 'DELETE' && r.path === '/auth/account')
      ).toBeTruthy()
    );
    const req = gateway.requests.find((r) => r.method === 'DELETE' && r.path === '/auth/account')!;
    expect(req.headers.Authorization ?? req.headers.authorization).toBe('Bearer jwt-abc');
    expect(req.credentials).toBe('omit');

    // Signed out, then routed to sign-in.
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith('/sign-in');
  });

  it('account deletion: surfaces the gateway error and stays put on failure', async () => {
    secureStore.set(AUTH_TOKEN_KEY, 'jwt-abc');
    const gateway = createMockGateway();
    gateway.on('DELETE', '/auth/account', () => ({
      status: 500,
      body: { error: 'Deletion failed' },
    }));
    const signOut = jest.fn(async () => {});

    const { navigate } = renderSettings({ gateway, signOut });

    fireEvent.press(screen.getByTestId('settings-delete-account'));
    fireEvent.changeText(screen.getByTestId('settings-delete-email-input'), 'ada@example.com');
    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-delete-confirm'));
    });

    await waitFor(() => expect(screen.getByTestId('settings-delete-error')).toBeTruthy());
    expect(signOut).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalledWith('/sign-in');
  });
});
