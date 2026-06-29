/**
 * useRepoTree — one directory level of the LOCAL clone's file tree.
 *
 * `GET /api/repos/:owner/:repo/tree/<dirPath>` lists a single directory of the
 * cloned workspace (root = empty path → `/tree/`), already sorted dirs-first by
 * the backend. The tree lazy-loads: each EXPANDED folder
 * mounts its own level, whose query fetches on first mount and caches per path
 * (`queryKeys.tree`).
 *
 * ⚠️ The endpoint returns `{ contents: [...] }` — NOT the `{ tree }`-wrapped
 * shared `GetTreeResponse` (the type lies; same family as the README/`repo`
 * endpoints). Declared locally as {@link RepoTreeEntry}. A not-cloned repo 404s
 * → `retry: false`, the card simply doesn't render.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';

/** One row of a directory listing (backend `RepoHandler.handleGetTree`). */
export interface RepoTreeEntry {
  name: string;
  /** Path relative to the repo root (the file-viewer route param). */
  path: string;
  type: 'file' | 'directory';
  size?: number;
  /** mtime in ms. */
  lastModified?: number;
  /** Directories only: false ⇒ empty folder (rendered dimmed). */
  hasChildren?: boolean;
  /** Gitignored entry (the name renders in tertiary text). */
  isHidden?: boolean;
}

export interface RepoTreeResponse {
  contents: RepoTreeEntry[];
}

export function useRepoTree(
  owner: string,
  repo: string,
  path = '',
  options: { enabled?: boolean } = {}
): UseQueryResult<RepoTreeResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.tree(owner, repo, path),
    queryFn: () => api.get<RepoTreeResponse>(`/api/repos/${owner}/${repo}/tree/${path}`),
    enabled: (options.enabled ?? true) && !!owner && !!repo,
    retry: false,
  });
}
