/**
 * Sentry error monitoring.
 *
 * Covers the framework-free DSN resolution, `initSentry` (reuses the shared
 * `buildSentryConfig`; leaves release/dist unset), the app-wide error boundary
 * passthrough + fallback, the dev-mode test-page ViewModel (every error seam
 * injected so the suite never actually throws), and the test screen. `@sentry/
 * react-native` is globally stubbed in `jest.setup.js` (the native module is
 * absent under jest-expo); `react-native-mmkv` is mocked because `SentryTestScreen`
 * → settings chrome → `useAppTheme` → themeStore touches it at import.
 */

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Sentry from '@sentry/react-native';

jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string | number | boolean) => store.set(k, String(v)),
    getString: (k: string) => (store.has(k) ? store.get(k) : undefined),
    remove: (k: string) => store.delete(k),
    contains: (k: string) => store.has(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

import {
  MOBILE_SENTRY_DSN,
  resolveSentryDsn,
  isSentryTestEnabled,
  type SentryEnv,
} from '../src/features/observability/sentryConfig';
import { initSentry, getSentryRuntimeInfo } from '../src/features/observability/initSentry';
import { AppErrorBoundary, ErrorFallback } from '../src/features/observability/AppErrorBoundary';
import { useSentryTest } from '../src/features/observability/useSentryTest';
import { SentryTestScreen } from '../src/features/observability/SentryTestScreen';

const SAFE_AREA_METRICS = {
  insets: { top: 0, bottom: 0, left: 0, right: 0 },
  frame: { x: 0, y: 0, width: 390, height: 844 },
};

const env = (over: Partial<SentryEnv> = {}): SentryEnv => ({ enableTest: false, ...over });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveSentryDsn', () => {
  it('an explicit EXPO_PUBLIC_SENTRY_DSN always wins (even in dev)', () => {
    expect(resolveSentryDsn(true, env({ dsn: 'https://ci@example/9' }))).toBe(
      'https://ci@example/9'
    );
  });

  it('plain dev (no flag, no override) → undefined (Sentry stays off — no flood)', () => {
    expect(resolveSentryDsn(true, env())).toBeUndefined();
  });

  it('dev + EXPO_PUBLIC_ENABLE_SENTRY_TEST → the bundled DSN', () => {
    expect(resolveSentryDsn(true, env({ enableTest: true }))).toBe(MOBILE_SENTRY_DSN);
  });

  it('a release build (dev=false) → the bundled DSN automatically', () => {
    expect(resolveSentryDsn(false, env())).toBe(MOBILE_SENTRY_DSN);
  });

  it('a blank/whitespace override falls through to the dev/release rule', () => {
    expect(resolveSentryDsn(true, env({ dsn: '   ' }))).toBeUndefined();
    expect(resolveSentryDsn(false, env({ dsn: '' }))).toBe(MOBILE_SENTRY_DSN);
  });

  it('isSentryTestEnabled reads the flag', () => {
    expect(isSentryTestEnabled(env({ enableTest: true }))).toBe(true);
    expect(isSentryTestEnabled(env())).toBe(false);
  });
});

describe('initSentry', () => {
  it('calls Sentry.init (DSN resolves with __DEV__ false in jest) and reports active', () => {
    // __DEV__ is false in jest.setup → getSentryDsn() returns the bundled DSN.
    const started = initSentry();
    expect(started).toBe(true);
    expect(Sentry.init).toHaveBeenCalledTimes(1);
    const opts = (Sentry.init as jest.Mock).mock.calls[0][0];
    // release/dist are deliberately UNSET (auto-detected from the native build).
    expect(opts.release).toBeUndefined();
    expect(opts.dist).toBeUndefined();
    expect(opts.dsn).toBe(MOBILE_SENTRY_DSN);
    expect(opts.initialScope.tags.service).toBe('mobile');
    // beforeSend drops non-error levels.
    expect(opts.beforeSend({ level: 'info' })).toBeNull();
    expect(opts.beforeSend({ level: 'error', extra: { a: 1 } })).toMatchObject({ level: 'error' });
  });

  it('getSentryRuntimeInfo reflects the active client options', () => {
    (Sentry.getClient as jest.Mock).mockReturnValueOnce({
      getOptions: () => ({
        environment: 'ios',
        release: 'dev.portable.app@1.5.0+1042',
        dist: '1042',
      }),
    });
    expect(getSentryRuntimeInfo()).toEqual({
      active: true,
      environment: 'ios',
      release: 'dev.portable.app@1.5.0+1042',
      dist: '1042',
    });
  });
});

describe('AppErrorBoundary', () => {
  it('renders children (passthrough) and the fallback shows a recovery screen', () => {
    render(
      <AppErrorBoundary>
        <Text testID="boundary-child">ok</Text>
      </AppErrorBoundary>
    );
    expect(screen.getByTestId('boundary-child')).toBeTruthy();

    const resetError = jest.fn();
    render(<ErrorFallback error={new Error('boom')} resetError={resetError} />);
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    fireEvent.press(screen.getByTestId('app-error-boundary-reset'));
    expect(resetError).toHaveBeenCalledTimes(1);
  });
});

describe('useSentryTest', () => {
  it('manual capture calls Sentry.captureException and surfaces the event id', () => {
    const captureException = jest.fn((_e: unknown) => 'evt-1');
    const { result } = renderHook(() =>
      useSentryTest({ captureException, now: () => 'T', runtimeInfo: () => ({ active: true }) })
    );
    act(() => result.current.captureManually());
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(result.current.status).toContain('evt-1');
  });

  it('throwUncaught schedules the throw WITHOUT invoking it (no crash)', () => {
    const scheduleUncaught = jest.fn(); // records the throwFn, never calls it
    const { result } = renderHook(() =>
      useSentryTest({ scheduleUncaught, runtimeInfo: () => ({ active: true }) })
    );
    act(() => result.current.throwUncaught());
    expect(scheduleUncaught).toHaveBeenCalledTimes(1);
    expect(typeof scheduleUncaught.mock.calls[0][0]).toBe('function');
    expect(result.current.status).toContain('UNCAUGHT');
  });

  it('arms/resets the render bomb and records a caught render error', () => {
    const { result } = renderHook(() => useSentryTest({ runtimeInfo: () => ({ active: true }) }));
    expect(result.current.bombArmed).toBe(false);
    act(() => result.current.armBomb());
    expect(result.current.bombArmed).toBe(true);
    act(() => result.current.resetBomb());
    expect(result.current.bombArmed).toBe(false);
    act(() => result.current.onBombCaught('evt-2'));
    expect(result.current.status).toContain('evt-2');
  });

  it('exposes the active state + a runtime label', () => {
    const { result } = renderHook(() =>
      useSentryTest({ runtimeInfo: () => ({ active: true, environment: 'android' }) })
    );
    expect(result.current.sentryActive).toBe(true);
    expect(result.current.runtimeLabel).toContain('env: android');
    expect(result.current.runtimeLabel).toContain('release: (native auto)');
  });
});

describe('SentryTestScreen', () => {
  it('renders the dev page and the Capture button fires captureException', () => {
    const captureException = jest.fn((_e: unknown) => 'evt-9');
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <SentryTestScreen captureException={captureException} />
      </SafeAreaProvider>
    );
    expect(screen.getByTestId('sentry-test-screen')).toBeTruthy();
    expect(screen.getByTestId('sentry-test-active')).toBeTruthy();
    // NB: never press the throw/render buttons here — they intentionally crash.
    fireEvent.press(screen.getByTestId('sentry-test-capture'));
    expect(captureException).toHaveBeenCalledTimes(1);
    // RNTL `toHaveTextContent` with a bare string is exact-ish for symbol-adjacent
    // text ("… → event id: evt-9") — assert with a regex (documented gotcha).
    expect(screen.getByTestId('sentry-test-status')).toHaveTextContent(/evt-9/);
  });
});
