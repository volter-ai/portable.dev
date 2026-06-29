/**
 * iOS Live Activity backend — the ONLY importer of the local
 * `LiveActivities` native module (ActivityKit).
 *
 * The native module is resolved **lazily** via `requireOptionalNativeModule`
 * (the `pushAdapter.ts` pattern), so importing this file never pulls
 * the native module into the Jest/Metro graph — tests inject a fake module.
 * `requireOptionalNativeModule` returns `null` when the module is absent (Android,
 * Expo Go, or an OS below the ActivityKit floor), so every call degrades to a
 * no-op without throwing.
 *
 * The native source lives in `modules/live-activities/` (the Swift `Module` +
 * `ActivityAttributes`) with the Lock Screen / Dynamic Island SwiftUI widget in
 * `targets/widget/`. Elapsed time is rendered NATIVELY by the widget from the
 * `startedAt: Date` baked into the activity at `startActivity` — JS never pushes
 * a per-second tick (which would hit ActivityKit's update budget). Device-only
 * acceptance (a real Live Activity on a physical device) is the deferred pass.
 */

import type { ActivityBackend } from './types';

/** The native module surface (matches the Swift `Module { Name("LiveActivities") }`). */
export interface LiveActivitiesNativeModule {
  /** Whether the user has Live Activities enabled (false on iOS &lt; 16.2 / disabled). */
  areActivitiesEnabled(): boolean;
  /** Begin a Live Activity for `chatId`. `lastToolLabel` is the initial caption. */
  startActivity(
    chatId: string,
    repoName: string,
    title: string,
    lastToolLabel: string
  ): Promise<boolean>;
  /** Mutate the running activity's caption / running flag in place. */
  updateActivity(chatId: string, lastToolLabel: string, isRunning: boolean): Promise<void>;
  /** End + dismiss the running activity. */
  endActivity(chatId: string): Promise<void>;
}

export interface IosLiveActivityBackendDeps {
  /** Injectable for tests; the default resolves the real native module once. */
  resolveModule?: () => LiveActivitiesNativeModule | null;
}

let cachedModule: LiveActivitiesNativeModule | null | undefined;

function defaultResolveModule(): LiveActivitiesNativeModule | null {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // Lazy require keeps the native probe out of the Jest/Metro module graph.
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- intentional lazy native require.
    const expo = require('expo') as {
      requireOptionalNativeModule?: <T>(name: string) => T | null;
    };
    cachedModule =
      expo.requireOptionalNativeModule?.<LiveActivitiesNativeModule>('LiveActivities') ?? null;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

export function createIosLiveActivityBackend(
  deps: IosLiveActivityBackendDeps = {}
): ActivityBackend {
  const resolveModule = deps.resolveModule ?? defaultResolveModule;

  return {
    start(info) {
      const mod = resolveModule();
      void mod?.startActivity(info.chatId, info.repoName, info.title, info.lastToolLabel);
    },
    update(info) {
      const mod = resolveModule();
      void mod?.updateActivity(info.chatId, info.lastToolLabel, true);
    },
    stop(chatId) {
      const mod = resolveModule();
      void mod?.endActivity(chatId);
    },
  };
}
