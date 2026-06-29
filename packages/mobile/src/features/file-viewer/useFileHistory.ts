/**
 * useFileHistory — git-history lookup + restore for a not-found file.
 *
 * MVVM ViewModel-as-hook over the authed TanStack Query layer. When a file 404s
 * (deleted in the working tree), this asks the
 * `GET /api/repos/:owner/:repo/file-history/<path>` endpoint whether the file existed in
 * git history, surfacing the last commit (sha/author/date/message + its content).
 * "Restore last committed version" writes that content back via
 * `PUT /api/repos/:owner/:repo/contents/<path>` (the local-file update handler),
 * then invalidates the file query so the viewer reloads the restored file.
 *
 * The shared `GetFileHistoryResponse` type is `{ [key]: any }` (useless), so the
 * wire shape is declared locally — the established locally-declared-superset
 * pattern. The endpoint 404s when the repo isn't cloned locally; that is treated
 * as "no history" (not an error wall).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';

export interface FileHistoryCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  /** The file's content at the last commit — present iff it can be restored. */
  content?: string;
}

export interface FileHistory {
  existed: boolean;
  lastCommit?: FileHistoryCommit;
  deletedInCurrentChangeset?: boolean;
}

export interface UseFileHistory {
  history: FileHistory | null;
  isLoading: boolean;
  /** Restore the last-committed content; resolves once the file query is invalidated. */
  restore: () => Promise<void>;
  isRestoring: boolean;
  restoreError: Error | null;
  canRestore: boolean;
}

export function useFileHistory(
  owner: string,
  repo: string,
  filePath: string,
  enabled: boolean
): UseFileHistory {
  const api = useApi();
  const queryClient = useQueryClient();

  const query = useQuery<FileHistory>({
    queryKey: queryKeys.fileHistory(owner, repo, filePath),
    enabled: enabled && !!owner && !!repo && !!filePath,
    retry: false,
    queryFn: () => api.get<FileHistory>(`/api/repos/${owner}/${repo}/file-history/${filePath}`),
  });

  const lastCommit = query.data?.lastCommit;
  const canRestore = !!lastCommit?.content;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!lastCommit?.content) throw new Error('No committed version to restore');
      await api.put(`/api/repos/${owner}/${repo}/contents/${filePath}`, {
        content: lastCommit.content,
        message: `Restore ${filePath} from git history via Portable`,
      });
    },
    onSuccess: () => {
      // Reload the file: the once-404 query refetches and the viewer renders it.
      void queryClient.invalidateQueries({ queryKey: queryKeys.file(owner, repo, filePath) });
    },
  });

  return {
    history: query.data ?? null,
    isLoading: query.isLoading,
    restore: () => mutation.mutateAsync(),
    isRestoring: mutation.isPending,
    restoreError: (mutation.error as Error) ?? null,
    canRestore,
  };
}
