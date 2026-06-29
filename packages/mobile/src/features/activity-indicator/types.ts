/**
 * Activity indicator — shared contracts.
 *
 * An "ongoing chat activity indicator" surfaces a long-running Claude chat
 * execution OUTSIDE the app UI so the user can track progress with the phone
 * locked or another app foregrounded:
 *   - iOS  → a Live Activity (ActivityKit) on the Lock Screen + Dynamic Island.
 *   - Android → none. The ongoing-notification backend was removed
 *     (it spammed a per-second notification + vibration during long runs).
 *
 * The platform difference is hidden behind {@link ActivityBackend}; the
 * platform-agnostic {@link ActivityIndicatorService} reconciles the set of
 * currently-running chats against whichever backend `Platform.OS` selected. No
 * fallbacks: iOS uses the real Live Activity; every other platform (Android
 * included) is a silent no-op.
 */

/** The renderable state of ONE chat's activity indicator. */
export interface ActivityInfo {
  /** The chat id — the stable key for start/update/stop + the notification id. */
  chatId: string;
  /** Headline (the chat's preview/summary/title, or the repo when unknown). */
  title: string;
  /** `owner/repo` (empty when the chat isn't repo-scoped / unresolved yet). */
  repoName: string;
  /** A humanized label for the latest tool the agent ran (e.g. "Running a command"). */
  lastToolLabel: string;
}

/**
 * The platform implementation. Calls are fire-and-forget (each method drives an
 * async native call internally) and MUST never throw — a broken indicator can
 * never break the chat. `start` begins the surface, `update` mutates it in
 * place, `stop` removes it.
 */
export interface ActivityBackend {
  start(info: ActivityInfo): void;
  update(info: ActivityInfo): void;
  stop(chatId: string): void;
}
