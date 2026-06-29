/**
 * Store-review feature tests (US — "ask for a store rating after ~30 min").
 *
 * Two layers:
 *   1. `useStoreReviewPrompt` (via the render-null `StoreReviewTracker`) driven
 *      by a DETERMINISTIC manual scheduler + an imperative AppState controller +
 *      an injected `requestReview` spy — so no real timers / native modules run.
 *   2. The `storeReview.ts` wrapper against a virtual `expo-store-review` mock.
 *
 * MMKV (the persisted `usageTrackingStore`) is mocked in-memory; the backing Map
 * lives OUTSIDE the factory so it can be cleared/inspected between tests.
 */

import { render, act } from '@testing-library/react-native';

// --- mocks (hoisted above imports) -----------------------------------------

const mockMmkvBacking = new Map<string, string>();
jest.mock('react-native-mmkv', () => {
  const instance = {
    set: (k: string, v: string) => mockMmkvBacking.set(k, String(v)),
    getString: (k: string) => (mockMmkvBacking.has(k) ? mockMmkvBacking.get(k) : undefined),
    remove: (k: string) => mockMmkvBacking.delete(k),
    clearAll: () => mockMmkvBacking.clear(),
  };
  return { __store: mockMmkvBacking, createMMKV: () => instance, MMKV: class {} };
});

const mockStoreReviewState = { available: true, throwOnAvailable: false };
const mockRequestReview = jest.fn(async () => {});
jest.mock(
  'expo-store-review',
  () => ({
    __esModule: true,
    isAvailableAsync: jest.fn(async () => {
      if (mockStoreReviewState.throwOnAvailable) throw new Error('store review unavailable');
      return mockStoreReviewState.available;
    }),
    hasAction: jest.fn(async () => mockStoreReviewState.available),
    requestReview: mockRequestReview,
  }),
  { virtual: true }
);

import {
  StoreReviewTracker,
  useUsageTrackingStore,
  requestStoreReview,
  isStoreReviewAvailable,
  type UseStoreReviewPromptDeps,
} from '../src/features/review';
import type { AppStateLike, AppStateStatus } from '../src/features/socket/lifecycle';

const MINUTE = 60 * 1000;

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Manual interval scheduler — fires due intervals in time order, flushing
 *  microtasks (so the async `requestReview` settles) after each tick. */
function createManualScheduler() {
  let now = 0;
  let nextId = 1;
  const intervals = new Map<number, { cb: () => void; ms: number; next: number }>();

  return {
    intervalCount: () => intervals.size,
    seams: {
      now: () => now,
      setIntervalImpl: (cb: () => void, ms: number) => {
        const id = nextId++;
        intervals.set(id, { cb, ms, next: now + ms });
        return id;
      },
      clearIntervalImpl: (handle: unknown) => {
        intervals.delete(handle as number);
      },
    } satisfies Partial<UseStoreReviewPromptDeps>,
    async advance(ms: number): Promise<void> {
      const target = now + ms;
      for (;;) {
        let dueId: number | null = null;
        let dueTime = Infinity;
        for (const [id, iv] of intervals) {
          if (iv.next <= target && iv.next < dueTime) {
            dueId = id;
            dueTime = iv.next;
          }
        }
        if (dueId === null) break;
        now = dueTime;
        const iv = intervals.get(dueId)!;
        iv.next += iv.ms;
        await act(async () => {
          iv.cb();
          await flushMicrotasks();
        });
      }
      now = target;
    },
  };
}

function createAppStateController(initial: AppStateStatus = 'active') {
  let listener: ((s: AppStateStatus) => void) | null = null;
  const appState: AppStateLike = {
    currentState: initial,
    addEventListener: (_type, l) => {
      listener = l;
      return {
        remove: () => {
          if (listener === l) listener = null;
        },
      };
    },
  };
  return {
    appState,
    async emit(state: AppStateStatus): Promise<void> {
      await act(async () => {
        listener?.(state);
        await flushMicrotasks();
      });
    },
  };
}

function mountTracker(deps: UseStoreReviewPromptDeps) {
  return render(<StoreReviewTracker deps={deps} />);
}

beforeEach(() => {
  mockMmkvBacking.clear();
  useUsageTrackingStore.setState({ activeMs: 0, reviewRequestedAt: null });
  mockRequestReview.mockClear();
  mockStoreReviewState.available = true;
  mockStoreReviewState.throwOnAvailable = false;
});

describe('useStoreReviewPrompt — usage-budget gating', () => {
  it('does not request a review before 30 minutes of foreground use', async () => {
    const sched = createManualScheduler();
    const requestReview = jest.fn(async () => true);
    mountTracker({ ...sched.seams, appState: createAppStateController().appState, requestReview });

    await sched.advance(20 * MINUTE);

    expect(requestReview).not.toHaveBeenCalled();
    expect(useUsageTrackingStore.getState().activeMs).toBe(20 * MINUTE);
    expect(useUsageTrackingStore.getState().reviewRequestedAt).toBeNull();
  });

  it('requests the native review exactly once when cumulative use crosses 30 min', async () => {
    const sched = createManualScheduler();
    const requestReview = jest.fn(async () => true);
    mountTracker({ ...sched.seams, appState: createAppStateController().appState, requestReview });

    await sched.advance(31 * MINUTE);

    expect(requestReview).toHaveBeenCalledTimes(1);
    expect(useUsageTrackingStore.getState().reviewRequestedAt).not.toBeNull();
  });

  it('never asks again once a review has been requested (no timer scheduled)', async () => {
    useUsageTrackingStore.setState({ activeMs: 99 * MINUTE, reviewRequestedAt: 1_234 });
    const sched = createManualScheduler();
    const requestReview = jest.fn(async () => true);
    mountTracker({ ...sched.seams, appState: createAppStateController().appState, requestReview });

    expect(sched.intervalCount()).toBe(0); // effect early-returned, no work scheduled.
    await sched.advance(60 * MINUTE);

    expect(requestReview).not.toHaveBeenCalled();
  });

  it('counts only foreground time — backgrounding freezes the accumulator', async () => {
    const sched = createManualScheduler();
    const requestReview = jest.fn(async () => true);
    const app = createAppStateController('active');
    mountTracker({ ...sched.seams, appState: app.appState, requestReview });

    await sched.advance(10 * MINUTE);
    await app.emit('background');
    await sched.advance(10 * MINUTE); // backgrounded — must NOT count
    await app.emit('active');
    await sched.advance(10 * MINUTE);

    expect(useUsageTrackingStore.getState().activeMs).toBe(20 * MINUTE);
    expect(requestReview).not.toHaveBeenCalled();
  });

  it('retries on the next launch when the prompt is unavailable this session', async () => {
    // Session 1 — the native prompt is unavailable.
    const sched1 = createManualScheduler();
    const unavailable = jest.fn(async () => false);
    const session1 = mountTracker({
      ...sched1.seams,
      appState: createAppStateController().appState,
      requestReview: unavailable,
    });
    await sched1.advance(31 * MINUTE);
    expect(unavailable).toHaveBeenCalledTimes(1); // attempted once, not hammered
    expect(useUsageTrackingStore.getState().reviewRequestedAt).toBeNull();
    session1.unmount();

    // Session 2 — now available; the persisted budget is already over threshold.
    const sched2 = createManualScheduler();
    const available = jest.fn(async () => true);
    mountTracker({
      ...sched2.seams,
      appState: createAppStateController().appState,
      requestReview: available,
    });
    await sched2.advance(1 * MINUTE); // a single tick suffices — threshold already met

    expect(available).toHaveBeenCalledTimes(1);
    expect(useUsageTrackingStore.getState().reviewRequestedAt).not.toBeNull();
  });
});

describe('storeReview wrapper', () => {
  it('requests the native prompt when the API is available', async () => {
    mockStoreReviewState.available = true;
    await expect(requestStoreReview()).resolves.toBe(true);
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
  });

  it('does not request when the native API is unavailable', async () => {
    mockStoreReviewState.available = false;
    await expect(requestStoreReview()).resolves.toBe(false);
    expect(mockRequestReview).not.toHaveBeenCalled();
  });

  it('swallows native errors as "unavailable"', async () => {
    mockStoreReviewState.throwOnAvailable = true;
    await expect(requestStoreReview()).resolves.toBe(false);
    expect(mockRequestReview).not.toHaveBeenCalled();
  });

  it('reports availability via isStoreReviewAvailable', async () => {
    mockStoreReviewState.available = false;
    await expect(isStoreReviewAvailable()).resolves.toBe(false);
    mockStoreReviewState.available = true;
    await expect(isStoreReviewAvailable()).resolves.toBe(true);
  });
});
