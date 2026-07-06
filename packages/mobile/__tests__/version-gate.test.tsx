/**
 * Version-update gate (dismissible "Update available" card — #1522).
 *
 * Covers the five layers of the version-update feature:
 *   1. `meetsMinimumVersion` — the major.minor comparison rule (patch ignored,
 *      fail-open on unparseable).
 *   2. `runVersionGate` — the retry + fail-open orchestration.
 *   3. `GatewayClient.getMinVersion` — hits the EXISTING public
 *      `GET /api/min-version-v2` (no Bearer, no cookies).
 *   4. `shouldShowUpdatePrompt` / `updatePromptStore` — the persisted "Later"
 *      snooze window (24h, MMKV).
 *   5. `VersionGate` — splash while checking; when behind, children render
 *      UNDERNEATH a dismissible card (the app is NEVER hard-blocked); children
 *      alone when up to date / fail-open / snoozed.
 *
 * The component tests render the themed splash/update card, which read the
 * MMKV-backed theme store → `react-native-mmkv` is mocked in-memory.
 */

jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (key: string, value: string | number | boolean) => store.set(key, String(value)),
    getString: (key: string) => (store.has(key) ? store.get(key) : undefined),
    remove: (key: string) => store.delete(key),
    contains: (key: string) => store.has(key),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Linking, Text } from 'react-native';

import {
  APP_STORE_URL,
  UPDATE_PROMPT_SNOOZE_MS,
  VersionGate,
  meetsMinimumVersion,
  runVersionGate,
  shouldShowUpdatePrompt,
  useUpdatePromptStore,
} from '../src/features/version-update';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway } from '../src/test';

describe('meetsMinimumVersion (major.minor rule, patch ignored, fail-open)', () => {
  it('passes when the app is ahead or equal at major.minor', () => {
    expect(meetsMinimumVersion('1.5.0', '1.4.0')).toBe(true); // ahead on minor
    expect(meetsMinimumVersion('2.0.0', '1.9.0')).toBe(true); // ahead on major
    expect(meetsMinimumVersion('1.4.0', '1.4.0')).toBe(true); // equal
  });

  it('fails when the app is behind at major.minor', () => {
    expect(meetsMinimumVersion('1.4.0', '1.5.0')).toBe(false); // behind on minor
    expect(meetsMinimumVersion('1.0.0', '2.0.0')).toBe(false); // behind on major
  });

  it('ignores the patch level entirely', () => {
    expect(meetsMinimumVersion('1.4.9', '1.4.0')).toBe(true);
    expect(meetsMinimumVersion('1.4.0', '1.4.9')).toBe(true);
  });

  it('fails open (returns true) on unparseable versions — never block on bad data', () => {
    expect(meetsMinimumVersion('garbage', '1.4.0')).toBe(true);
    expect(meetsMinimumVersion('1.4.0', '')).toBe(true);
  });
});

describe('runVersionGate (retry + fail-open orchestration)', () => {
  it('returns "ok" when the app meets the minimum', async () => {
    const verdict = await runVersionGate({
      appVersion: '1.5.0',
      getMinimumVersion: async () => '1.4.0',
    });
    expect(verdict).toBe('ok');
  });

  it('returns "update-required" when the app is behind (no retry on a real answer)', async () => {
    const getMinimumVersion = jest.fn(async () => '1.5.0');
    const verdict = await runVersionGate({ appVersion: '1.4.0', getMinimumVersion });
    expect(verdict).toBe('update-required');
    expect(getMinimumVersion).toHaveBeenCalledTimes(1);
  });

  it('fails OPEN ("ok") after exhausting retries on persistent errors', async () => {
    const failing = jest.fn(async () => {
      throw new Error('network down');
    });
    const verdict = await runVersionGate({
      appVersion: '1.0.0',
      getMinimumVersion: failing,
      sleep: async () => {}, // no real backoff timers
    });
    expect(verdict).toBe('ok');
    expect(failing).toHaveBeenCalledTimes(3); // default maxAttempts
  });

  it('retries a transient failure then resolves the real verdict', async () => {
    let calls = 0;
    const flaky = jest.fn(async () => {
      calls += 1;
      if (calls < 2) throw new Error('blip');
      return '2.0.0';
    });
    const verdict = await runVersionGate({
      appVersion: '1.0.0',
      getMinimumVersion: flaky,
      sleep: async () => {},
    });
    expect(verdict).toBe('update-required'); // app 1.x behind minimum 2.0
    expect(flaky).toHaveBeenCalledTimes(2);
  });
});

describe('GatewayClient.getMinVersion → GET /api/min-version-v2', () => {
  it('calls the existing public route with no Bearer and no cookies', async () => {
    const gateway = createMockGateway();
    const client = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
    gateway.on('GET', '/api/min-version-v2', () => ({ body: { minimumVersion: '1.4.0' } }));

    const res = await client.getMinVersion();
    expect(res).toEqual({ minimumVersion: '1.4.0' });

    const call = gateway.requests.find((r) => r.path === '/api/min-version-v2');
    expect(call).toBeTruthy();
    expect(call!.method).toBe('GET');
    expect(call!.credentials).toBe('omit');
    expect(call!.headers.Authorization).toBeUndefined();
  });
});

describe('shouldShowUpdatePrompt (the persisted "Later" snooze window)', () => {
  const NOW = 1_750_000_000_000;

  it('shows when never dismissed', () => {
    expect(shouldShowUpdatePrompt(null, NOW)).toBe(true);
  });

  it('snoozes within the window and reappears after it elapses', () => {
    expect(shouldShowUpdatePrompt(NOW - 1, NOW)).toBe(false); // just dismissed
    expect(shouldShowUpdatePrompt(NOW - UPDATE_PROMPT_SNOOZE_MS + 1, NOW)).toBe(false); // inside
    expect(shouldShowUpdatePrompt(NOW - UPDATE_PROMPT_SNOOZE_MS, NOW)).toBe(true); // elapsed
  });

  it('stays snoozed when the clock moved backwards (never nag on clock skew)', () => {
    expect(shouldShowUpdatePrompt(NOW + 60_000, NOW)).toBe(false);
  });
});

describe('VersionGate (dismissible update prompt — never hard-blocks)', () => {
  beforeEach(() => {
    useUpdatePromptStore.setState({ dismissedAt: null });
  });

  it('shows the branded splash while the check is in flight, then renders children', async () => {
    let resolveMin: (v: string) => void = () => {};
    render(
      <VersionGate
        deps={{
          appVersion: '1.0.0',
          getMinimumVersion: () =>
            new Promise<string>((resolve) => {
              resolveMin = resolve;
            }),
        }}
      >
        <Text testID="app-children">APP</Text>
      </VersionGate>
    );

    // Checking → the splash blocks; children are NOT rendered yet.
    expect(screen.getByTestId('version-gate-loading')).toBeTruthy();
    expect(screen.queryByTestId('app-children')).toBeNull();

    await act(async () => {
      resolveMin('0.5.0'); // app 1.0 >= minimum 0.5 → ok
      await Promise.resolve();
    });

    expect(await screen.findByTestId('app-children')).toBeTruthy();
    expect(screen.queryByTestId('version-gate-loading')).toBeNull();
  });

  it('shows the dismissible card OVER the still-rendered children when the app is behind; Update opens the store', async () => {
    const onUpdate = jest.fn();
    render(
      <VersionGate deps={{ appVersion: '1.0.0', getMinimumVersion: async () => '2.0.0', onUpdate }}>
        <Text testID="app-children">APP</Text>
      </VersionGate>
    );

    // The card appears, but the app renders UNDERNEATH it — never a hard block.
    expect(await screen.findByTestId('update-available-card')).toBeTruthy();
    expect(screen.getByTestId('app-children')).toBeTruthy();

    fireEvent.press(screen.getByTestId('update-available-update'));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('the default Update action deep-links the platform store (no onUpdate override)', async () => {
    // Production mounts VersionGate with no onUpdate, so the real CTA is
    // UpdateAvailableCard's Linking.openURL default — exercise it, not the seam.
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    try {
      render(
        <VersionGate deps={{ appVersion: '1.0.0', getMinimumVersion: async () => '2.0.0' }}>
          <Text testID="app-children">APP</Text>
        </VersionGate>
      );

      fireEvent.press(await screen.findByTestId('update-available-update'));

      // jest-expo defaults Platform.OS to 'ios' → the App Store URL.
      expect(openURL).toHaveBeenCalledTimes(1);
      expect(openURL).toHaveBeenCalledWith(APP_STORE_URL);
      // The card stays up (updating happens out-of-app); no snooze is recorded.
      expect(screen.getByTestId('update-available-card')).toBeTruthy();
      expect(useUpdatePromptStore.getState().dismissedAt).toBeNull();
    } finally {
      openURL.mockRestore();
    }
  });

  it('"Later" dismisses the card, keeps the app usable, and persists the snooze', async () => {
    const NOW = 1_750_000_000_000;
    render(
      <VersionGate
        deps={{ appVersion: '1.0.0', getMinimumVersion: async () => '2.0.0', now: () => NOW }}
      >
        <Text testID="app-children">APP</Text>
      </VersionGate>
    );

    expect(await screen.findByTestId('update-available-card')).toBeTruthy();

    fireEvent.press(screen.getByTestId('update-available-later'));

    expect(screen.queryByTestId('update-available-card')).toBeNull();
    expect(screen.getByTestId('app-children')).toBeTruthy();
    expect(useUpdatePromptStore.getState().dismissedAt).toBe(NOW);
  });

  it('does NOT nag again on a relaunch inside the snooze window', async () => {
    const DISMISSED_AT = 1_750_000_000_000;
    useUpdatePromptStore.setState({ dismissedAt: DISMISSED_AT });

    render(
      <VersionGate
        deps={{
          appVersion: '1.0.0',
          getMinimumVersion: async () => '2.0.0',
          now: () => DISMISSED_AT + 60 * 60 * 1000, // 1h later, same day
        }}
      >
        <Text testID="app-children">APP</Text>
      </VersionGate>
    );

    expect(await screen.findByTestId('app-children')).toBeTruthy();
    expect(screen.queryByTestId('update-available-card')).toBeNull();
  });

  it('re-shows the card on a relaunch once the snooze window has elapsed', async () => {
    const DISMISSED_AT = 1_750_000_000_000;
    useUpdatePromptStore.setState({ dismissedAt: DISMISSED_AT });

    render(
      <VersionGate
        deps={{
          appVersion: '1.0.0',
          getMinimumVersion: async () => '2.0.0',
          now: () => DISMISSED_AT + UPDATE_PROMPT_SNOOZE_MS,
        }}
      >
        <Text testID="app-children">APP</Text>
      </VersionGate>
    );

    expect(await screen.findByTestId('update-available-card')).toBeTruthy();
    expect(screen.getByTestId('app-children')).toBeTruthy();
  });

  it('does NOT pop the card mid-session when the snooze elapses without a remount (latched)', async () => {
    const DISMISSED_AT = 1_750_000_000_000;
    useUpdatePromptStore.setState({ dismissedAt: DISMISSED_AT });
    let clock = DISMISSED_AT + 60 * 60 * 1000; // 1h after dismissal → still snoozed
    const now = () => clock;
    const deps = { appVersion: '1.0.0', getMinimumVersion: async () => '2.0.0', now };

    const { rerender } = render(
      <VersionGate deps={deps}>
        <Text testID="app-children">APP</Text>
      </VersionGate>
    );

    // Latched not-due at verdict time → no card.
    expect(await screen.findByTestId('app-children')).toBeTruthy();
    expect(screen.queryByTestId('update-available-card')).toBeNull();

    // The 24h window elapses while the process stays alive, then a re-render fires
    // (ordinary navigation). A per-render clock check would pop the modal here.
    await act(async () => {
      clock = DISMISSED_AT + UPDATE_PROMPT_SNOOZE_MS + 1;
      rerender(
        <VersionGate deps={deps}>
          <Text testID="app-children">APP</Text>
        </VersionGate>
      );
      await Promise.resolve();
    });

    // Still no card — the decision was latched at verdict time, not re-derived.
    expect(screen.queryByTestId('update-available-card')).toBeNull();
  });

  it('renders children when the app meets the minimum (no update card)', async () => {
    render(
      <VersionGate deps={{ appVersion: '2.0.0', getMinimumVersion: async () => '1.0.0' }}>
        <Text testID="app-children">APP</Text>
      </VersionGate>
    );

    expect(await screen.findByTestId('app-children')).toBeTruthy();
    expect(screen.queryByTestId('update-available-card')).toBeNull();
  });

  it('fails OPEN to children when the version service errors out', async () => {
    render(
      <VersionGate
        deps={{
          appVersion: '1.0.0',
          getMinimumVersion: async () => {
            throw new Error('gateway unreachable');
          },
          sleep: async () => {},
        }}
      >
        <Text testID="app-children">APP</Text>
      </VersionGate>
    );

    expect(await screen.findByTestId('app-children')).toBeTruthy();
    expect(screen.queryByTestId('update-available-card')).toBeNull();
  });
});
