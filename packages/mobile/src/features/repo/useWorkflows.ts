/**
 * useWorkflows — workflow-files list + view + create/update/delete.
 *
 * MVVM ViewModel-as-hook over the authed TanStack Query layer. The Workflows tab
 * lists the repo's workflow files via `GET /api/repos/:owner/:repo/workflows`
 * (GitHub `listRepoWorkflows` shape: `{ total_count, workflows: [...] }`) and
 * manages a single file's content through the four file endpoints
 * (create/update/delete):
 *   - view   → `GET    .../workflows/file?path=`  → `{ content, sha, path }`
 *   - create → `POST   .../workflows/file`  body `{ path, content, message? }`
 *   - update → `PUT    .../workflows/file`  body `{ path, content, sha, message? }`
 *   - delete → `DELETE .../workflows/file`  body `{ path, sha, message? }`
 *
 * Each write invalidates the workflow-files list (and the viewed file) so the
 * tab reflects the change, mirroring `useRepoIssue`'s invalidate-on-success.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';

/** A workflow file entry (GitHub `listRepoWorkflows` workflow shape). */
export interface WorkflowFileEntry {
  id: number;
  name: string;
  path: string;
  state?: string;
  html_url?: string;
  badge_url?: string;
}

/** Sandbox `/workflows` response (GitHub `listRepoWorkflows`). */
interface WorkflowsListResponse {
  total_count?: number;
  workflows?: WorkflowFileEntry[];
}

/** Sandbox `/workflows/file` GET response (`{ content, sha, path }`). */
export interface WorkflowFileContent {
  content: string;
  sha: string;
  path: string;
}

interface CreateInput {
  path: string;
  content: string;
  message?: string;
}
interface UpdateInput {
  path: string;
  content: string;
  sha: string;
  message?: string;
}
interface DeleteInput {
  path: string;
  sha: string;
  message?: string;
}

export interface UseWorkflows {
  workflows: WorkflowFileEntry[];
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  refetch: () => void;
  /** Fetch a single workflow file's content (view). */
  viewFile: (path: string) => Promise<WorkflowFileContent>;
  /** Create a workflow file via `POST .../workflows/file`. */
  createFile: (input: CreateInput) => void;
  /** Update a workflow file via `PUT .../workflows/file`. */
  updateFile: (input: UpdateInput) => void;
  /** Delete a workflow file via `DELETE .../workflows/file`. */
  deleteFile: (input: DeleteInput) => void;
  isMutating: boolean;
}

export function useWorkflows(owner: string, repo: string): UseWorkflows {
  const api = useApi();
  const qc = useQueryClient();
  const listKey = queryKeys.workflows(owner, repo);

  const query = useQuery({
    queryKey: listKey,
    enabled: !!owner && !!repo,
    queryFn: () => api.get<WorkflowsListResponse>(`/api/repos/${owner}/${repo}/workflows`),
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: listKey });

  const createMutation = useMutation({
    mutationFn: (input: CreateInput) =>
      api.post(`/api/repos/${owner}/${repo}/workflows/file`, input),
    onSuccess: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: (input: UpdateInput) =>
      api.put(`/api/repos/${owner}/${repo}/workflows/file`, input),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (input: DeleteInput) =>
      api.del(`/api/repos/${owner}/${repo}/workflows/file`, input),
    onSuccess: invalidate,
  });

  const workflows = query.data?.workflows ?? [];

  return {
    workflows,
    isLoading: query.isLoading,
    isError: query.isError,
    isEmpty: !query.isLoading && !query.isError && workflows.length === 0,
    refetch: () => void query.refetch(),
    viewFile: (path: string) =>
      api.get<WorkflowFileContent>(
        `/api/repos/${owner}/${repo}/workflows/file?path=${encodeURIComponent(path)}`
      ),
    createFile: (input: CreateInput) => createMutation.mutate(input),
    updateFile: (input: UpdateInput) => updateMutation.mutate(input),
    deleteFile: (input: DeleteInput) => deleteMutation.mutate(input),
    isMutating: createMutation.isPending || updateMutation.isPending || deleteMutation.isPending,
  };
}
