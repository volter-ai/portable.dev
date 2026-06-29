/**
 * Local Expo module entry for iOS Live Activities (issue #1434).
 *
 * NOTE: the app does NOT import this file — `src/features/activity-indicator/
 * iosLiveActivity.ts` calls `requireOptionalNativeModule('LiveActivities')`
 * directly (lazy) so the native probe stays out of the Jest/Metro graph. This
 * typed accessor exists for completeness / documentation of the native surface.
 * The native Swift lives in `ios/`; the Lock Screen / Dynamic Island widget in
 * `targets/widget/`.
 */

import { requireOptionalNativeModule } from 'expo';

export interface LiveActivitiesNativeModule {
  areActivitiesEnabled(): boolean;
  startActivity(
    chatId: string,
    repoName: string,
    title: string,
    lastToolLabel: string
  ): Promise<boolean>;
  updateActivity(chatId: string, lastToolLabel: string, isRunning: boolean): Promise<void>;
  endActivity(chatId: string): Promise<void>;
}

/** `null` on Android / Expo Go / iOS below the ActivityKit floor. */
export const LiveActivities =
  requireOptionalNativeModule<LiveActivitiesNativeModule>('LiveActivities');
