/**
 * ViewModel for the MCP Servers settings section (MVVM ViewModel-as-hook).
 *
 * Server state lives in TanStack Query via the EXISTING shared `useMcps()`
 * hook (`GET /api/mcps/available` → `{ mcps: McpStatus[] }`). The I/O seam is
 * the authed `RelayApiClient` injected through `<ApiProvider client=…>` (the
 * repo's established injection point — same as `useChatChrome`/`useTasks`), so
 * tests drive this ViewModel end-to-end with `createMockGateway` and no
 * native modules.
 *
 * `retry: false`: the section fetches once and surfaces the error immediately
 * (no retry loop); manual retry re-fetches.
 */

import { useMcps } from '../../../api/hooks';
import type { McpStatus } from './mcpHelpers';

export interface McpServersViewModel {
  /** Initial load in flight (v5 `isPending` — also true while paused offline). */
  loading: boolean;
  /** Error message, or null. Rendered as `Error loading MCPs: ${error}`. */
  error: string | null;
  mcps: McpStatus[];
  /** Manual re-fetch (the SectionError retry button). */
  retry: () => void;
}

export function useMcpServers(): McpServersViewModel {
  const query = useMcps({ retry: false });

  return {
    loading: query.isPending,
    error: query.isError
      ? query.error instanceof Error
        ? query.error.message
        : 'Failed to fetch MCPs'
      : null,
    mcps: query.data?.mcps ?? [],
    retry: () => {
      void query.refetch();
    },
  };
}
