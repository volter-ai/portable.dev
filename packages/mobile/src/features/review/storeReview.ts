/**
 * Store-review wrapper — the ONLY importer of `expo-store-review`
 * (`SKStoreReviewController` on iOS, the Google Play In-App Review API on
 * Android). It asks the OS to surface its native, non-interruptive "rate this
 * app" prompt; the platform decides whether to actually show it (and caps the
 * frequency — Apple ~3×/365 days, Google its own quota), so this is a *request*,
 * never a guaranteed prompt.
 *
 * The native module is loaded **lazily** via `require` (never a top-level
 * `import`) — the `deviceSse.ts` pattern — so importing this file (or
 * the review barrel, or `useStoreReviewPrompt`) does NOT pull the native module
 * into the Jest module graph; only an actual `requestStoreReview()` call touches
 * it. Tests virtual-mock `expo-store-review`; the consuming ViewModel injects a
 * `requestReview` seam so the module is never loaded in the hook tests at all.
 *
 * No `app.json` config plugin is required (expo-store-review ships no native
 * config) — only the dependency + autolinking.
 */

/** Minimal surface of the `expo-store-review` module we depend on. */
interface StoreReviewModule {
  /** True when the native StoreReview API can be used on this device/build. */
  isAvailableAsync(): Promise<boolean>;
  /** True when there is some review action available (native prompt OR a store URL). */
  hasAction(): Promise<boolean>;
  /** Ask the OS to present its native in-app review prompt. */
  requestReview(): Promise<void>;
}

/**
 * Lazily resolve `expo-store-review`. Kept out of module scope so the native
 * module never loads at import time (Jest / Metro graph stays clean).
 */
function getStoreReview(): StoreReviewModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- intentional lazy native require.
  return require('expo-store-review') as StoreReviewModule;
}

/**
 * Whether the OS can present its native in-app review prompt right now. Any
 * failure (native module missing, unsupported platform) resolves to `false` so a
 * caller never throws on an unavailable device.
 */
export async function isStoreReviewAvailable(): Promise<boolean> {
  try {
    return await getStoreReview().isAvailableAsync();
  } catch {
    return false;
  }
}

/**
 * Request the native store-review prompt. Returns `true` only when the native
 * API was actually invoked (available + `requestReview()` resolved), `false`
 * when the prompt is unavailable on this device/build or anything throws — so
 * the caller can decide whether to retry later (e.g. on a fresh launch) without
 * marking the user as "already asked".
 *
 * NOTE: a `true` return means the request was *made*, not that the prompt was
 * *shown* — the OS owns that decision and gives no signal either way.
 */
export async function requestStoreReview(): Promise<boolean> {
  try {
    const storeReview = getStoreReview();
    if (!(await storeReview.isAvailableAsync())) return false;
    await storeReview.requestReview();
    return true;
  } catch {
    return false;
  }
}
