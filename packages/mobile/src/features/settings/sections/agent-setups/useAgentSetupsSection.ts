/**
 * ViewModel for the Agent Setups settings section (MVVM ViewModel-as-hook).
 *
 * Server state lives in TanStack Query via the EXISTING shared
 * `useAgentSetups()` hook (`GET /api/agent-setups` → `{ agentSetups:
 * AgentSetup[] }`). The I/O seam is the authed `RelayApiClient` injected
 * through `<ApiProvider client=…>` (the repo's established injection point —
 * same as `useChatChrome`/`useTasks`), so tests drive this end-to-end with
 * `createMockGateway` and no native modules.
 *
 * `retry: false`: the section fetches once on mount and surfaces the error
 * immediately; manual retry re-fetches.
 */

import type { AgentSetup } from '@vgit2/shared/types';

import { useAgentSetups } from '../../../api/hooks';

export interface AgentSetupsSectionViewModel {
  /** Initial load in flight (v5 `isPending` — also true while paused offline). */
  loading: boolean;
  /** Error message, or null. Rendered as `Error loading agent setups: ${error}`. */
  error: string | null;
  setups: AgentSetup[];
  /** Manual re-fetch (the SectionError retry button). */
  retry: () => void;
}

export function useAgentSetupsSection(): AgentSetupsSectionViewModel {
  const query = useAgentSetups({ retry: false });

  return {
    loading: query.isPending,
    error: query.isError
      ? query.error instanceof Error
        ? query.error.message
        : 'Failed to load agent setups'
      : null,
    setups: query.data?.agentSetups ?? [],
    retry: () => {
      void query.refetch();
    },
  };
}
