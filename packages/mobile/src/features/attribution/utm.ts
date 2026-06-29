/**
 * UTM parsing for the native app.
 *
 * Mobile attribution is fingerprint-INDEPENDENT (a native app shares no IP/User-
 * Agent with the web landing page, so the server's fingerprint claim can never
 * match), which means the campaign must arrive INSIDE the app — via a deep link
 * carrying `utm_*` query params (a universal/app link tapped from a campaign).
 * This parses those params off ANY launch/incoming URL.
 */

export const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;

export type UtmKey = (typeof UTM_KEYS)[number];

/** Captured UTM campaign fields (+ the URL they came from). */
export type UtmFields = Partial<Record<UtmKey, string>> & { landing_url?: string };

/**
 * Parse `utm_*` params off a URL. Returns `null` unless at least `utm_source`
 * or `utm_campaign` is present (a real campaign) — a bare deep link (e.g. the
 * `portable://sso-callback` auth callback or a push-notification callback) carries
 * no campaign and must NOT register as one. `landing_url` records the source URL
 * for debugging.
 *
 * Uses a manual query slice + `URLSearchParams` rather than `new URL()` because
 * RN's URL polyfill is unreliable for custom schemes (`portable://…`).
 */
export function parseUtmFromUrl(url: string | null | undefined): UtmFields | null {
  if (!url) return null;
  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) return null;

  let params: URLSearchParams;
  try {
    // Strip a trailing `#fragment` before parsing — unlike `new URL()`,
    // `URLSearchParams` KEEPS it, so `…?utm_campaign=adriel#/home` would otherwise
    // capture `adriel#/home` and corrupt the campaign value. `landing_url` below
    // still records the full URL (fragment included).
    const query = url.slice(queryIndex + 1).split('#')[0];
    params = new URLSearchParams(query);
  } catch {
    return null;
  }

  const out: UtmFields = {};
  for (const key of UTM_KEYS) {
    const value = params.get(key);
    if (value) out[key] = value;
  }
  if (!out.utm_source && !out.utm_campaign) return null;

  out.landing_url = url;
  return out;
}
