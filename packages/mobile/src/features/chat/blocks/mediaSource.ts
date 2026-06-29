/**
 * mediaSource — resolve image/video source URIs from a streamed block.
 *
 * The PC api emits screenshots / videos as `image`/`video` blocks whose `source.url`
 * is a RELATIVE PC path: `/data/media/<userId>/<name>.webp` (screenshots, public) or
 * `/api/video/...` & `/api/uploads/...` (behind the PC's `/api` JWT middleware). RN's
 * `<Image>` / expo-video CANNOT load a relative path, and the PC is reached through the
 * relay (`<gatewayBase>/t/<pcId>`), so a usable source must be resolved to the ABSOLUTE
 * relay base — with a `Bearer` JWT for `/api/*` (carried in the source `headers`, NOT a
 * `?token=` query). Inline `data:` (base64) and already-absolute `http(s)` sources pass
 * through untouched (base64 needs no relay/auth, so it renders even when the PC has no
 * ffmpeg and the screenshot stays base64).
 *
 * `getImageSource`/`getVideoSource` are the SYNC extractors (raw url / data-URI);
 * `resolveAuthedMediaSource` is the ASYNC funnel that turns a relative path into the
 * absolute relay URL + auth header. The relay base + token are read LAZILY (so the heavy
 * `baseUrls`/`dataPathToken` → `expo-secure-store` graph never enters a plain block test)
 * and best-effort (any failure falls back to the raw relative URL — never throws).
 */

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

/** The (loosely-typed) `source` payload of an image/video block. */
interface MediaBlockSource {
  url?: string;
  data?: string;
  media_type?: string;
  file_path?: string;
}

/** A resolved, loadable media source for RN `<Image>` / expo-video. */
export interface AuthedMediaSource {
  uri: string;
  /** Bearer header for relay `/api/*` reads (omitted for public `/data/media` + inline). */
  headers?: Record<string, string>;
}

function blockSource(block: ClaudeStreamBlock): MediaBlockSource {
  const source = block.source;
  return source && typeof source === 'object' ? (source as MediaBlockSource) : {};
}

/** A `data:` URI or an already-absolute `http(s)` URL — loadable without the relay. */
export function isInlineUri(uri: string): boolean {
  return /^(data:|https?:\/\/)/i.test(uri);
}

/** Resolve the displayable image URI (URL → data-URI fallback). */
export function getImageSource(block: ClaudeStreamBlock): string {
  const source = blockSource(block);
  const mediaType = source.media_type || 'image/png';
  if (source.url) return source.url;
  const imageData = source.data ?? (typeof block.source === 'string' ? block.source : '');
  return `data:${mediaType};base64,${imageData}`;
}

/** Resolve the displayable video URI + mime type (URL → file path → data-URI). */
export function getVideoSource(block: ClaudeStreamBlock): { src: string; type: string } {
  const source = blockSource(block);
  const mediaType = source.media_type || 'video/webm';
  if (source.url) return { src: source.url, type: mediaType };
  if (source.file_path) return { src: `/api/video/${source.file_path}`, type: mediaType };
  const videoData = source.data ?? (typeof block.source === 'string' ? block.source : '');
  return { src: `data:${mediaType};base64,${videoData}`, type: mediaType };
}

/**
 * Turn a raw media URL into a loadable `{ uri, headers? }` against the relay.
 *
 * - `data:` / `http(s)` → returned as-is (no relay, no auth).
 * - a relative PC path (`/data/media/...`, `/api/video/...`, `/api/uploads/...`) →
 *   prefixed with the connected PC's relay base (`getRelayUrl`). `/api/*` reads are
 *   behind the PC's JWT middleware, so they carry a `Bearer` from `resolveDataPathToken`;
 *   `/data/media/*` is served publicly (before the JWT middleware) so no header is added.
 *
 * Best-effort: if the relay base / token can't be read (no PC connected, SecureStore
 * unavailable in a test), it falls back to the raw URL and NEVER throws.
 */
export async function resolveAuthedMediaSource(rawUrl: string): Promise<AuthedMediaSource> {
  if (!rawUrl || isInlineUri(rawUrl)) return { uri: rawUrl };

  try {
    // Lazy-require so the SecureStore-backed relay/token graph never enters the static
    // graph of a block test that renders inline / absolute media.
    const { getRelayUrl } = require('../../api/baseUrls') as {
      getRelayUrl: () => Promise<string | null>;
    };
    const base = await getRelayUrl();
    const path = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
    const uri = base ? `${base.replace(/\/$/, '')}${path}` : rawUrl;

    // `/api/*` is behind the PC JWT middleware; `/data/media/*` is public.
    if (path.startsWith('/api/')) {
      const { resolveDataPathToken } = require('../../pc-connect/dataPathToken') as {
        resolveDataPathToken: () => Promise<string | null>;
      };
      const token = await resolveDataPathToken();
      if (token) return { uri, headers: { Authorization: `Bearer ${token}` } };
    }
    return { uri };
  } catch {
    return { uri: rawUrl };
  }
}
