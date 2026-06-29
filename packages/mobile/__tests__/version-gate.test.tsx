/**
 * Force-update version gate.
 *
 * Covers the four layers of the version-update feature:
 *   1. `meetsMinimumVersion` — the major.minor comparison rule (patch ignored,
 *      fail-open on unparseable).
 *   2. `runVersionGate` — the retry + fail-open orchestration.
 *   3. `GatewayClient.getMinVersion` — hits the EXISTING public
 *      `GET /api/min-version-v2` (no Bearer, no cookies).
 *   4. `VersionGate` — the blocking gate view: splash while checking, the
 *      update screen when behind, children when up to date / fail-open.
 *
 * The component tests render the themed splash/update screen, which read the
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
import { Text } from 'react-native';

import { VersionGate, meetsMinimumVersion, runVersionGate } from '../src/features/version-update';
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

describe('VersionGate (blocking gate view)', () => {
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

  it('blocks with the UpdateRequired screen when the app is behind; the button opens the store', async () => {
    const onUpdate = jest.fn();
    render(
      <VersionGate deps={{ appVersion: '1.0.0', getMinimumVersion: async () => '2.0.0', onUpdate }}>
        <Text testID="app-children">APP</Text>
      </VersionGate>
    );

    expect(await screen.findByTestId('update-required-screen')).toBeTruthy();
    expect(screen.queryByTestId('app-children')).toBeNull();

    fireEvent.press(screen.getByTestId('update-required-button'));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('renders children when the app meets the minimum (no update screen)', async () => {
    render(
      <VersionGate deps={{ appVersion: '2.0.0', getMinimumVersion: async () => '1.0.0' }}>
        <Text testID="app-children">APP</Text>
      </VersionGate>
    );

    expect(await screen.findByTestId('app-children')).toBeTruthy();
    expect(screen.queryByTestId('update-required-screen')).toBeNull();
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
    expect(screen.queryByTestId('update-required-screen')).toBeNull();
  });
});
