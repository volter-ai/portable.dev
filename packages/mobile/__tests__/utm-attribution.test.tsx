/**
 * UTM attribution — capture campaign UTM from the launch deep link and
 * report it to the gateway ONCE per user so a mobile user gets a
 * `user_attribution` row + `first_use_at` (and therefore counts as a "verified
 * signup"; the native app never visited the web landing page that creates the
 * fingerprint precapture row).
 *
 * Four layers, all native-module-free: the pure `parseUtmFromUrl`, the first-touch
 * `utmStore`, the gateway `reportUtmAttribution` (injected gateway+token), and the
 * `UtmAttributionSync` ViewModel (injected deep-link readers + report + seeded
 * `authStore` identity). The layer mounts with a plain RNTL `render` — it uses the
 * zustand `authStore` hook + injected seams, so no providers are needed.
 */

// utmStore persists through MMKV; authStore / secureAuthStore import expo-secure-store
// at module scope. Both must be in-memory mocks (the native modules never load).
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string) => store.set(k, v),
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
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    deleteItemAsync: jest.fn(async (k: string) => {
      store.delete(k);
    }),
  };
});

import { act, renderHook } from '@testing-library/react-native';

import {
  parseUtmFromUrl,
  reportUtmAttribution,
  useUtmAttribution,
  useUtmAttributionStore,
  type UtmFields,
} from '../src/features/attribution';
import { useAuthStore, type AuthUser } from '../src/features/state/authStore';

const IDENTITY: AuthUser = { userId: 'user_real', username: 'octocat', email: 'octocat@x.io' };

/** Flush the chained getInitialURL → capture → report → markReported microtasks. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  // NOT wrapped in act(): no renderer is mounted yet, and authStore persists via
  // ASYNC SecureStore — a sync act() around its mutation schedules an un-awaited
  // async write that React 19 flags + tears the next render down. utmStore is sync
  // MMKV so its mutations are act-safe, but seeding pre-render needs no act anyway.
  useUtmAttributionStore.getState().reset();
  useAuthStore.getState().reset();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('parseUtmFromUrl', () => {
  it('extracts campaign fields + the landing_url from a deep link', () => {
    const utm = parseUtmFromUrl(
      'portable://open?utm_source=instagram&utm_medium=social&utm_campaign=adriel&utm_content=story'
    );
    expect(utm).toEqual({
      utm_source: 'instagram',
      utm_medium: 'social',
      utm_campaign: 'adriel',
      utm_content: 'story',
      landing_url:
        'portable://open?utm_source=instagram&utm_medium=social&utm_campaign=adriel&utm_content=story',
    });
  });

  it('captures a campaign with only utm_campaign (no source)', () => {
    expect(parseUtmFromUrl('https://portable.dev/?utm_campaign=adriel')?.utm_campaign).toBe(
      'adriel'
    );
  });

  it('strips a trailing #fragment from the last UTM value (not new URL())', () => {
    const utm = parseUtmFromUrl('portable://open?utm_source=ig&utm_campaign=adriel#/home');
    expect(utm?.utm_campaign).toBe('adriel'); // NOT 'adriel#/home'
    expect(utm?.utm_source).toBe('ig');
    expect(utm?.landing_url).toBe('portable://open?utm_source=ig&utm_campaign=adriel#/home'); // full URL kept
  });

  it('returns null for a bare deep link with NO campaign (sso-callback / push)', () => {
    expect(parseUtmFromUrl('portable://sso-callback')).toBeNull();
    expect(parseUtmFromUrl('portable://open?foo=bar&utm_medium=social')).toBeNull(); // medium alone ≠ campaign
    expect(parseUtmFromUrl(null)).toBeNull();
    expect(parseUtmFromUrl(undefined)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('utmStore — first-touch capture', () => {
  it('records the first campaign and never overwrites it', () => {
    const first: UtmFields = { utm_campaign: 'adriel', landing_url: 'a' };
    const second: UtmFields = { utm_campaign: 'other', landing_url: 'b' };

    act(() => useUtmAttributionStore.getState().captureFirstTouch(first));
    expect(useUtmAttributionStore.getState().utm).toEqual(first);

    act(() => useUtmAttributionStore.getState().captureFirstTouch(second));
    expect(useUtmAttributionStore.getState().utm).toEqual(first); // first-touch wins
  });

  it('ignores a non-campaign capture (keeps utm null)', () => {
    act(() => useUtmAttributionStore.getState().captureFirstTouch({ landing_url: 'x' }));
    expect(useUtmAttributionStore.getState().utm).toBeNull();
  });

  it('markReported records the attributed userId', () => {
    act(() => useUtmAttributionStore.getState().markReported('user_real'));
    expect(useUtmAttributionStore.getState().reportedUserId).toBe('user_real');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('reportUtmAttribution', () => {
  it('POSTs the cleaned UTM body with the Bearer token → true', async () => {
    const reportUtm = jest.fn(async () => ({ ok: true as const }));
    const ok = await reportUtmAttribution({
      utm: { utm_source: 'instagram', utm_campaign: 'adriel', utm_medium: '', landing_url: 'u' },
      gateway: { reportUtm },
      getToken: async () => 'tok-123',
    });
    expect(ok).toBe(true);
    // Empty/undefined fields dropped; the token rides as the first arg.
    expect(reportUtm).toHaveBeenCalledWith('tok-123', {
      utm_source: 'instagram',
      utm_campaign: 'adriel',
      landing_url: 'u',
    });
  });

  it('sends an EMPTY body for an organic install (no UTM) — the row still gets created', async () => {
    const reportUtm = jest.fn(async () => ({ ok: true as const }));
    const ok = await reportUtmAttribution({
      utm: null,
      gateway: { reportUtm },
      getToken: async () => 'tok',
    });
    expect(ok).toBe(true);
    expect(reportUtm).toHaveBeenCalledWith('tok', {});
  });

  it('returns false WITHOUT calling the gateway when there is no token', async () => {
    const reportUtm = jest.fn(async () => ({ ok: true as const }));
    const ok = await reportUtmAttribution({ gateway: { reportUtm }, getToken: async () => null });
    expect(ok).toBe(false);
    expect(reportUtm).not.toHaveBeenCalled();
  });

  it('swallows a gateway error → false (never throws)', async () => {
    const reportUtm = jest.fn(async () => {
      throw new Error('network down');
    });
    const ok = await reportUtmAttribution({
      utm: { utm_campaign: 'adriel' },
      gateway: { reportUtm },
      getToken: async () => 'tok',
    });
    expect(ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('UtmAttributionSync — capture + report once per user', () => {
  // The ViewModel is effect-only — `renderHook` runs it without a null-rendering
  // host component (which RNTL 13 can't access `.root` on). `UtmAttributionSync`
  // is the thin `useUtmAttribution() → null` wrapper of this same hook.
  function renderSync(opts: {
    initialUrl?: string | null;
    report: jest.Mock;
    addUrlListener?: (handler: (url: string) => void) => { remove: () => void };
  }) {
    return renderHook(() =>
      useUtmAttribution({
        getInitialUrl: async () => opts.initialUrl ?? null,
        addUrlListener: opts.addUrlListener ?? (() => ({ remove: () => {} })),
        report: opts.report,
      })
    );
  }

  it('captures the launch-link campaign and reports it once for the signed-in user', async () => {
    useAuthStore.getState().setUser(IDENTITY);
    const report = jest.fn(async () => true);

    renderSync({ initialUrl: 'portable://open?utm_source=instagram&utm_campaign=adriel', report });
    await flush();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        utm: {
          utm_source: 'instagram',
          utm_campaign: 'adriel',
          landing_url: 'portable://open?utm_source=instagram&utm_campaign=adriel',
        },
      })
    );
    expect(useUtmAttributionStore.getState().reportedUserId).toBe(IDENTITY.userId);
  });

  it('reports an ORGANIC install (no campaign deep link) so the user still gets a row', async () => {
    useAuthStore.getState().setUser(IDENTITY);
    const report = jest.fn(async () => true);

    renderSync({ initialUrl: null, report });
    await flush();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ utm: null }));
    expect(useUtmAttributionStore.getState().reportedUserId).toBe(IDENTITY.userId);
  });

  it('does NOT report when no user is signed in yet', async () => {
    const report = jest.fn(async () => true);
    renderSync({ initialUrl: 'portable://open?utm_campaign=adriel', report });
    await flush();

    expect(report).not.toHaveBeenCalled();
    // The campaign is still captured for a later launch.
    expect(useUtmAttributionStore.getState().utm?.utm_campaign).toBe('adriel');
  });

  it('does NOT re-report a user already attributed', async () => {
    useAuthStore.getState().setUser(IDENTITY);
    useUtmAttributionStore.getState().markReported(IDENTITY.userId);
    const report = jest.fn(async () => true);

    renderSync({ initialUrl: 'portable://open?utm_campaign=adriel', report });
    await flush();

    expect(report).not.toHaveBeenCalled();
  });

  it('leaves reportedUserId unset on a failed report (retried next launch)', async () => {
    useAuthStore.getState().setUser(IDENTITY);
    const report = jest.fn(async () => false);

    renderSync({ initialUrl: 'portable://open?utm_campaign=adriel', report });
    await flush();

    expect(report).toHaveBeenCalledTimes(1);
    expect(useUtmAttributionStore.getState().reportedUserId).toBeNull();
  });

  it('captures a WARM deep link delivered while the app is open', async () => {
    let handler: ((url: string) => void) | undefined;
    const report = jest.fn(async () => true);

    renderSync({
      initialUrl: null,
      report,
      addUrlListener: (h) => {
        handler = h;
        return { remove: () => {} };
      },
    });
    await flush();

    act(() => handler?.('portable://open?utm_campaign=warmlink'));
    expect(useUtmAttributionStore.getState().utm?.utm_campaign).toBe('warmlink');
  });
});
