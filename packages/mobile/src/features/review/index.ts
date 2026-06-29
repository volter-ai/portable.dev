/**
 * Store-review feature barrel — ask the user to rate the app on the store after
 * ~30 min of cumulative foreground usage.
 */

export { StoreReviewTracker, type StoreReviewTrackerProps } from './StoreReviewTracker';
export {
  useStoreReviewPrompt,
  DEFAULT_REVIEW_THRESHOLD_MS,
  DEFAULT_REVIEW_TICK_MS,
  type UseStoreReviewPromptDeps,
  type StoreReviewPromptStatus,
} from './useStoreReviewPrompt';
export {
  useUsageTrackingStore,
  USAGE_TRACKING_PERSIST_KEY,
  type UsageTrackingState,
} from './usageTrackingStore';
export { requestStoreReview, isStoreReviewAvailable } from './storeReview';
