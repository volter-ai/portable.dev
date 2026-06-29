/**
 * ActivityIndicatorService — the platform-agnostic reconciler.
 *
 * Given the CURRENT set of running chats (a snapshot), it diffs against the set
 * it last drove and issues the minimal backend calls: `start` for a newly
 * running chat, `update` only when the rendered info actually changed (dedup —
 * iOS throttles ActivityKit updates and Android re-renders the notification, so
 * we never push a no-op), and `stop` for a chat that left the running set. The
 * backend is injected so the service is unit-testable with zero native code.
 */

import type { ActivityBackend, ActivityInfo } from './types';

export interface ActivityIndicatorService {
  /**
   * Drive the indicators to exactly match `indicators` (the chats running RIGHT
   * NOW). Idempotent: calling it repeatedly with the same snapshot is a no-op
   * after the first.
   */
  reconcile(indicators: ActivityInfo[]): void;
  /** Stop every active indicator (call on teardown / unmount). */
  stopAll(): void;
}

function sameInfo(a: ActivityInfo, b: ActivityInfo): boolean {
  return a.title === b.title && a.repoName === b.repoName && a.lastToolLabel === b.lastToolLabel;
}

/** Never let an indicator error bubble into the app. */
function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* swallow — the indicator is best-effort */
  }
}

export function createActivityIndicatorService(deps: {
  backend: ActivityBackend;
}): ActivityIndicatorService {
  const { backend } = deps;
  /** chatId → the info we last drove the backend with. */
  const active = new Map<string, ActivityInfo>();

  function reconcile(indicators: ActivityInfo[]): void {
    const seen = new Set<string>();
    for (const info of indicators) {
      seen.add(info.chatId);
      const prev = active.get(info.chatId);
      if (!prev) {
        active.set(info.chatId, info);
        safe(() => backend.start(info));
      } else if (!sameInfo(prev, info)) {
        active.set(info.chatId, info);
        safe(() => backend.update(info));
      }
      // else: unchanged → no backend call (dedup).
    }
    for (const chatId of Array.from(active.keys())) {
      if (!seen.has(chatId)) {
        active.delete(chatId);
        safe(() => backend.stop(chatId));
      }
    }
  }

  function stopAll(): void {
    for (const chatId of Array.from(active.keys())) {
      active.delete(chatId);
      safe(() => backend.stop(chatId));
    }
  }

  return { reconcile, stopAll };
}
