/**
 * useWorkflowRun — single workflow-run detail with jobs/steps.
 *
 * MVVM ViewModel-as-hook. The detail is server state → `useQuery` over
 * `GET /api/repos/:owner/:repo/actions/runs/:runId`, which returns
 * `{ run, jobs }` (the backend `handleGetWorkflowRun` shape). Each job carries
 * `status`/`conclusion`, `started_at`/`completed_at` (timing), and `steps` — the
 * per-job step list the UI renders as the run's logs (jobs + their steps as the
 * run breakdown).
 */

import { useQuery } from '@tanstack/react-query';

import type { WorkflowRun } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';

/** A single step inside a workflow job (the rendered "logs" breakdown). */
export interface WorkflowStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  started_at?: string | null;
  completed_at?: string | null;
}

/** A job within a workflow run (status/conclusion/timing + steps). */
export interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  html_url?: string;
  steps?: WorkflowStep[];
}

/** Sandbox `/actions/runs/:runId` response (`{ run, jobs }`). */
interface WorkflowRunDetailResponse {
  run: WorkflowRun;
  jobs?: WorkflowJob[];
}

export interface UseWorkflowRun {
  run: WorkflowRun | undefined;
  jobs: WorkflowJob[];
  isLoading: boolean;
  isError: boolean;
}

export function useWorkflowRun(owner: string, repo: string, runId: number | null): UseWorkflowRun {
  const api = useApi();
  const enabled = !!owner && !!repo && typeof runId === 'number';
  const id = runId ?? 0;

  const query = useQuery({
    queryKey: queryKeys.workflowRun(owner, repo, id),
    enabled,
    retry: false,
    queryFn: () =>
      api.get<WorkflowRunDetailResponse>(`/api/repos/${owner}/${repo}/actions/runs/${id}`),
  });

  return {
    run: query.data?.run,
    jobs: query.data?.jobs ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
