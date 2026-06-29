/**
 * useFileContent — fetch + decode a repository file for the native viewers.
 *
 * MVVM ViewModel-as-hook over the authed TanStack Query layer. It
 * detects the file type from the path (no network), then either:
 *
 *  - TEXT (code/markdown/text/csv): `GET /api/repos/:owner/:repo/contents/<path>`
 *    returns a bare `FileContent` (`{ content, encoding:'base64', … }`, same shape
 *    the README uses); decode base64 → UTF-8 text.
 *  - BINARY (image/pdf/video/audio): no body fetch — resolve the absolute
 *    `/api/repos/:owner/:repo/raw/<path>` URL (mutable sandbox base) and attach a
 *    `Authorization: Bearer` header so the native `Image`/`Pdf` loader streams the
 *    bytes itself (RN carries auth via the header, not a `?token=` query).
 *
 * The result is a discriminated union so the viewer dispatch is type-safe.
 */

import { useQuery } from '@tanstack/react-query';

import type { FileContent } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';
import { ApiHttpError } from '../api/relayClient';
// FILE import (not the pc-connect barrel) — the raw-bytes endpoint is on the relay
// data path, authenticated by the connected PC's device token (legacy
// authToken fallback when no PC is connected).
import { resolveDataPathToken } from '../pc-connect/dataPathToken';
import { fileContentToText } from '../repo/base64';
import { detectFileType, isBinaryPreview, type FileTypeInfo } from './fileTypeDetector';

/** A binary preview source the native `Image`/`Pdf` components consume directly. */
export interface FileSource {
  uri: string;
  headers: Record<string, string>;
}

export type FileContentResult =
  | { kind: 'text'; content: string }
  | { kind: 'binary'; source: FileSource; downloadUrl: string };

export interface UseFileContent {
  /** The detected type/viewer hints (available before the query resolves). */
  fileType: FileTypeInfo;
  /** The bare file name (last path segment). */
  fileName: string;
  /** Decoded text (text files) — empty until loaded / for binary files. */
  content: string;
  /** Binary preview source (image/pdf/video/audio) — null for text files. */
  source: FileSource | null;
  /**
   * Authenticated raw-bytes URL for opening in the system browser (the binary
   * "Download" fallback). Carries `?token=` so a cookie-less browser request still
   * authenticates (the gateway `jwtAuth` reads `req.query.token`). Null for text.
   */
  downloadUrl: string | null;
  isLoading: boolean;
  isError: boolean;
  /** A not-found (404) file — distinct from a generic transport error. */
  isNotFound: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Build the binary result: the absolute raw-bytes source (URL + Bearer header for
 * the native loaders) plus a `?token=`-bearing `downloadUrl` for the system
 * browser. No body is fetched — the loader / browser streams the bytes itself.
 */
async function resolveBinaryResult(
  api: ReturnType<typeof useApi>,
  owner: string,
  repo: string,
  filePath: string
): Promise<Extract<FileContentResult, { kind: 'binary' }>> {
  const uri = await api.resolveUrl(`/api/repos/${owner}/${repo}/raw/${filePath}`);
  const token = await resolveDataPathToken();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const downloadUrl = token
    ? `${uri}${uri.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
    : uri;
  return { kind: 'binary', source: { uri, headers }, downloadUrl };
}

export function useFileContent(owner: string, repo: string, filePath: string): UseFileContent {
  const api = useApi();
  const fileName = filePath.split('/').pop() || filePath;
  const fileType = detectFileType(fileName);
  // image/pdf/video/audio render from the raw URL; an unpreviewable `binary` file
  // also skips the body fetch (the download fallback only needs the URL).
  const skipBodyFetch = isBinaryPreview(fileType.type) || fileType.type === 'binary';

  const query = useQuery<FileContentResult>({
    queryKey: queryKeys.file(owner, repo, filePath),
    enabled: !!owner && !!repo && !!filePath,
    retry: false,
    queryFn: async () => {
      // TEMP [FILEDIAG] — remove after debugging the file-viewer render failure.
      console.warn(
        `[FILEDIAG] fetch owner=${owner} repo=${repo} path=${filePath} type=${fileType.type} skipBody=${skipBodyFetch}`
      );
      try {
        if (skipBodyFetch) {
          const r = await resolveBinaryResult(api, owner, repo, filePath);
          console.warn(
            `[FILEDIAG] binary ok uri=${r.source.uri} hasAuth=${!!r.source.headers.Authorization}`
          );
          return r;
        }
        const file = await api.get<FileContent>(`/api/repos/${owner}/${repo}/contents/${filePath}`);
        console.warn(
          `[FILEDIAG] text ok encoding=${file.encoding} contentLen=${file.content?.length ?? 0}`
        );
        return { kind: 'text', content: fileContentToText(file) };
      } catch (e: any) {
        console.warn(
          `[FILEDIAG] FETCH FAILED name=${e?.name} status=${e?.status} message=${e?.message}`
        );
        throw e;
      }
    },
  });

  const data = query.data;
  const isNotFound = query.error instanceof ApiHttpError && query.error.status === 404;

  return {
    fileType,
    fileName,
    content: data?.kind === 'text' ? data.content : '',
    source: data?.kind === 'binary' ? data.source : null,
    downloadUrl: data?.kind === 'binary' ? data.downloadUrl : null,
    isLoading: query.isLoading,
    isError: query.isError,
    isNotFound,
    error: (query.error as Error) ?? null,
    refetch: () => void query.refetch(),
  };
}
