/**
 * Shared freshness knobs for the chat-list PREVIEWS (the home "Continue chats" + the
 * repo Overview "Continue chats"), both backed by the `['chats']` `useChats` query.
 *
 * Chats are created/updated on the PC (terminal `claude`, another surface) AND the
 * phone, but the `chat:created` socket signal only invalidates the `chat-directory`
 * cache — NOT the `['chats']` query these previews read, and never for a chat that was
 * merely UPDATED on the PC. So the previews drop the 5-min global `staleTime` and POLL
 * to stay current with PC-side activity.
 *
 * Two call sites, gated differently by their mount lifecycle:
 *  - **Home** (`ChatHomeScreen`) stays MOUNTED across bottom-tab switches, so it gates
 *    the interval on Home-tab focus (a `useFocusEffect` flag) to avoid polling while
 *    you're on another tab. It reuses {@link CHAT_LIST_POLL_INTERVAL_MS}.
 *  - **Repo Overview** (`OverviewTab`) UNMOUNTS when you leave the Overview inner-tab
 *    (`RepoPageScreen` renders only the active tab), so its poll stops on its own — it
 *    polls unconditionally via {@link POLLED_CHAT_LIST_OPTIONS} (no focus gate; its
 *    screen also has no navigator under test, so `useFocusEffect` is unavailable there).
 */

/** How often the chat-list previews re-poll `/api/chats` while visible. */
export const CHAT_LIST_POLL_INTERVAL_MS = 15_000;

/**
 * React Query options for a chat-list preview that POLLS unconditionally while mounted
 * (the repo Overview). `staleTime: 0` also refetches on every fresh mount, so switching
 * back to the Overview tab is always current. `refetchIntervalInBackground: false` keeps
 * it from polling once the app is backgrounded.
 */
export const POLLED_CHAT_LIST_OPTIONS = {
  staleTime: 0,
  refetchInterval: CHAT_LIST_POLL_INTERVAL_MS,
  refetchIntervalInBackground: false,
};
