/**
 * queryClient — the app's single TanStack Query client + NetInfo-driven online
 * awareness.
 *
 * `createQueryClient` configures online-aware retry with exponential backoff.
 * Because the default `networkMode` is `'online'`, when NetInfo reports the
 * device offline TanStack Query PAUSES queries/mutations (`fetchStatus:
 * 'paused'`) rather than erroring them, and automatically resumes (re-fetches
 * queued queries, replays paused mutations) on the next online transition — this
 * is the "queued and auto-sent on reconnect, no manual retry" behavior the story
 * requires, with a non-blocking offline indicator driven off `onlineManager`.
 *
 * `configureQueryOnlineManager` bridges `@react-native-community/netinfo` into
 * TanStack Query's global `onlineManager`. It is injectable (any object exposing
 * `addEventListener`) so tests drive connectivity transitions deterministically
 * without the native module.
 */

import { onlineManager, QueryClient, type QueryClientConfig } from '@tanstack/react-query';

/** Minimal NetInfo surface used to drive online state (real module is a superset). */
export interface NetInfoLike {
  addEventListener(listener: (state: { isConnected: boolean | null }) => void): () => void;
}

/** Exponential backoff capped at 30s (attempt is 0-based). */
export function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

/**
 * Build the shared QueryClient. Queries retry up to 3× with exponential backoff
 * and stay fresh for 5 minutes; mutations do not auto-retry (they pause offline
 * and resume on reconnect via `onlineManager`). Callers may override any default.
 */
export function createQueryClient(overrides?: QueryClientConfig): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: 'online',
        retry: 3,
        retryDelay: backoffDelay,
        staleTime: 300_000,
        refetchOnWindowFocus: false,
        ...overrides?.defaultOptions?.queries,
      },
      mutations: {
        networkMode: 'online',
        retry: 0,
        ...overrides?.defaultOptions?.mutations,
      },
      ...(overrides?.defaultOptions
        ? Object.fromEntries(
            Object.entries(overrides.defaultOptions).filter(
              ([k]) => k !== 'queries' && k !== 'mutations'
            )
          )
        : {}),
    },
  });
}

/**
 * Wire NetInfo connectivity into TanStack Query's `onlineManager`. A connection
 * is treated as online unless NetInfo explicitly reports `isConnected === false`
 * (a `null`/unknown state is optimistically online, matching NetInfo semantics).
 */
export function configureQueryOnlineManager(netInfo: NetInfoLike): void {
  onlineManager.setEventListener((setOnline) => {
    return netInfo.addEventListener((state) => {
      setOnline(state.isConnected !== false);
    });
  });
}
