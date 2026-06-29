/**
 * sandboxSessionStore: the death → re-provision epoch transition.
 *
 * `requestReprovision()` is the single sandbox-death transition (replaces the
 * old `recoverSandbox` clear-and-re-exchange flow):
 *
 *   - clears the persisted sandbox URL (SecureStore) + the authStore mirror;
 *   - PRESERVES the Portable authToken (sandbox death does not invalidate the
 *     72h JWT — re-provisioning needs NO Clerk re-exchange) and the identity;
 *   - resets the health stores and bumps the session epoch LAST (the remounted
 *     provisioning gate must never see the dead URL);
 *   - is single-flight: a second call while `reprovisioning` is a no-op (no
 *     double epoch bump from overlapping death signals).
 */

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
    getItemAsync: jest.fn(async (k: string) => (store.has(k) ? (store.get(k) as string) : null)),
    deleteItemAsync: jest.fn(async (k: string) => {
      store.delete(k);
    }),
  };
});

import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { useConnectionFailedStore } from '../src/features/health/connectionFailedStore';
import { useSandboxHealthStore } from '../src/features/health/healthStore';
import { useSandboxSessionStore } from '../src/features/health/sandboxSessionStore';
import { useStartupHealthStore } from '../src/features/health/startupHealthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { useAuthStore } from '../src/features/state/authStore';

interface SecureStoreMock {
  __store: Map<string, string>;
}
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

const DEAD_URL = 'https://dead.example.modal.host';
const AUTH_TOKEN = 'portable-jwt-still-valid';

beforeEach(() => {
  secureStore.__store.clear();
  secureStore.__store.set(AUTH_TOKEN_KEY, AUTH_TOKEN);
  secureStore.__store.set(RELAY_URL_KEY, DEAD_URL);
  useSandboxSessionStore.getState().reset();
  useAuthStore.getState().setSandboxUrl(DEAD_URL);
  useAuthStore
    .getState()
    .setUser({ userId: 'user_42', username: 'octocat', email: 'octo@example.com' });
  useSandboxHealthStore.getState().markFailed();
  useStartupHealthStore.getState().markFailed();
  useConnectionFailedStore.setState({ visible: false, reason: 'pc-down' });
});

describe('sandboxSessionStore.requestReprovision', () => {
  it('clears the dead sandbox URL + mirror, PRESERVES the authToken + identity, resets health, bumps the epoch', async () => {
    await useSandboxSessionStore.getState().requestReprovision();

    // Dead URL gone — SecureStore AND the in-memory mirror.
    expect(secureStore.__store.has(RELAY_URL_KEY)).toBe(false);
    expect(useAuthStore.getState().sandboxUrl).toBeNull();

    // The authToken + identity are PRESERVED (no re-login, no Clerk re-exchange).
    expect(secureStore.__store.get(AUTH_TOKEN_KEY)).toBe(AUTH_TOKEN);
    expect(useAuthStore.getState().user?.userId).toBe('user_42');

    // Health state starts clean for the next sandbox session.
    expect(useSandboxHealthStore.getState().status).toBe('healthy');
    expect(useStartupHealthStore.getState().phase).toBe('checking');

    // The epoch bump (LAST) drives the app-shell's keyed remount.
    expect(useSandboxSessionStore.getState().epoch).toBe(1);
    expect(useSandboxSessionStore.getState().reprovisioning).toBe(true);
  });

  it('is single-flight: overlapping calls bump the epoch ONCE until markSessionLive', async () => {
    const store = useSandboxSessionStore.getState();
    await Promise.all([store.requestReprovision(), store.requestReprovision()]);
    await useSandboxSessionStore.getState().requestReprovision(); // still in flight → no-op

    expect(useSandboxSessionStore.getState().epoch).toBe(1);

    // Provisioning handed the tree back → the next death starts a NEW epoch.
    useSandboxSessionStore.getState().markSessionLive();
    expect(useSandboxSessionStore.getState().reprovisioning).toBe(false);
    await useSandboxSessionStore.getState().requestReprovision();
    expect(useSandboxSessionStore.getState().epoch).toBe(2);
  });

  it('a failed keychain delete does not block the re-provision (epoch still bumps)', async () => {
    const mock = jest.requireMock('expo-secure-store') as { deleteItemAsync: jest.Mock };
    mock.deleteItemAsync.mockRejectedValueOnce(new Error('keychain unavailable'));

    await useSandboxSessionStore.getState().requestReprovision();

    expect(useSandboxSessionStore.getState().epoch).toBe(1);
    // The mirror is still cleared so nothing trusts the dead URL in memory.
    expect(useAuthStore.getState().sandboxUrl).toBeNull();
  });
});

describe('sandboxSessionStore.provisioned (post-onboarding gate skip)', () => {
  it('markProvisioned sets it; a re-provision and reset clear it', async () => {
    // Onboarding concurrent provisioning landed a live sandbox → the auto gate skips.
    expect(useSandboxSessionStore.getState().provisioned).toBe(false);
    useSandboxSessionStore.getState().markProvisioned();
    expect(useSandboxSessionStore.getState().provisioned).toBe(true);

    // A death MUST clear it — the new epoch can never trust the dead sandbox
    // (verify-before-reuse); the remounted gate re-provisions from scratch.
    await useSandboxSessionStore.getState().requestReprovision();
    expect(useSandboxSessionStore.getState().provisioned).toBe(false);

    // reset() clears it too.
    useSandboxSessionStore.getState().markProvisioned();
    useSandboxSessionStore.getState().reset();
    expect(useSandboxSessionStore.getState().provisioned).toBe(false);
  });
});
