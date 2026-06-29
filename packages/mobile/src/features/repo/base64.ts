/**
 * File-content decoding helpers.
 *
 * The sandbox `GET /api/repos/:owner/:repo/contents/*` endpoint returns a bare
 * `FileContent` with the body base64-encoded (both the local-clone and GitHub-API
 * paths emit `{ content, encoding: 'base64' }`). These helpers decode it; the
 * file viewers (`useFileContent`) consume them.
 */

import type { FileContent } from '@vgit2/shared/types';

/**
 * Decode a base64 string into UTF-8 text. `atob` is a global in Hermes (Expo
 * SDK 56 / RN ≥ 0.74) and in the Node/Jest test env; a `TextDecoder` pass (also
 * global in both) turns the binary string into proper UTF-8 so non-ASCII content
 * survives.
 */
export function decodeBase64Utf8(b64: string): string {
  const cleaned = b64.replace(/\s/g, '');
  const binary = globalThis.atob(cleaned);
  if (typeof globalThis.TextDecoder !== 'undefined') {
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new globalThis.TextDecoder().decode(bytes);
  }
  // ASCII fallback if TextDecoder is somehow unavailable.
  return binary;
}

/** Decode a `FileContent` body to text (base64 → UTF-8, else pass through). */
export function fileContentToText(file: FileContent): string {
  if (!file.content) return '';
  return file.encoding === 'base64' ? decodeBase64Utf8(file.content) : file.content;
}
