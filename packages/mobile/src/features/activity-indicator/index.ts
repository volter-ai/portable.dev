/**
 * Activity indicator — barrel.
 *
 * Surfaces an ongoing-chat-execution indicator outside the app: an iOS Live
 * Activity (ActivityKit) behind one platform-agnostic service. Mounted via
 * {@link ActivityIndicatorSync} in `AppShell`. The Android ongoing-notification
 * backend was removed (it spammed a per-second notification); Android
 * now resolves to the shared no-op.
 */

export { ActivityIndicatorSync } from './ActivityIndicatorSync';
export type { ActivityIndicatorSyncDeps } from './ActivityIndicatorSync';
export {
  createActivityIndicatorService,
  type ActivityIndicatorService,
} from './activityIndicatorService';
export { resolveActivityBackend, noopActivityBackend } from './resolveActivityBackend';
export { createIosLiveActivityBackend } from './iosLiveActivity';
export type { LiveActivitiesNativeModule } from './iosLiveActivity';
export {
  deriveActivityIndicators,
  humanizeToolLabel,
  lastToolName,
  ACTIVE_STATUSES,
  type ResolveActivityMeta,
  type ActivityMeta,
} from './deriveActivityIndicators';
export type { ActivityBackend, ActivityInfo } from './types';
