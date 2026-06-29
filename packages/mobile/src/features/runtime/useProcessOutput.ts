/**
 * useProcessOutput — resolves a background process's terminal output (web
 * `RuntimeProcessDetailInstance`). Prefers the inline stdout/stderr carried on the
 * socket `user:runtime_state` snapshot; otherwise fetches the output file
 * (`GET /api/task-output?path=`) and polls it every 2s while the process runs.
 */

import type { ProcessData } from '@vgit2/shared/types';

import { useTaskOutput } from '../api/hooks';

const POLL_MS = 2000;

export interface ProcessOutput {
  /** Combined output text (inline stdout+stderr, or the fetched file). */
  output: string;
  isFetching: boolean;
  refetch: () => void;
  /** True when there is any output source (inline data or an output file path). */
  hasSource: boolean;
}

export function useProcessOutput(process: ProcessData | undefined): ProcessOutput {
  const inline = process ? `${process.stdout ?? ''}${process.stderr ?? ''}` : '';
  const running = process?.status === 'running';
  // Only fetch the file when there is no inline output to show.
  const path = !inline ? process?.outputFilePath : undefined;

  const query = useTaskOutput(path, {
    refetchInterval: running ? POLL_MS : false,
  });

  return {
    output: inline || query.data?.content || '',
    isFetching: query.isFetching,
    refetch: () => void query.refetch(),
    hasSource: Boolean(inline) || Boolean(path),
  };
}
