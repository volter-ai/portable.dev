/**
 * ViewModel for the Connected Services settings section.
 *
 * Joins three concerns:
 *   1. the user's connections — server state via the existing `useConnections()`
 *      query (`GET /api/connections`, shared `queryKeys.connections()`);
 *   2. the service catalog — a LOCAL query over `GET /api/connections/services`
 *      (`{ services: ServiceConfig[] }`; no shared hook exists — the
 *      locally-declared-query pattern), keyed `['connection-services']` so a
 *      `queryKeys.connections()` invalidation never refetches the static catalog;
 *   3. the write flows — rename (`PATCH /api/connections/:id/rename`, body
 *      `{ newDisplayName }` — the field `connections.routes.ts` actually reads),
 *      disconnect
 *      (`DELETE /api/connections/:id`) and exclusive enable/disable
 *      (`PATCH /api/connections/:id/toggle-active`, body `{ isActive }`), each
 *      invalidating `queryKeys.connections()` on success.
 *
 * CONNECT FLOW (native v1, the `ActiveChatScreen.startConnection` precedent):
 * `connect(service)` builds `${sandboxUrl}/connections?service=X&token=<jwt>`
 * (the sandbox reads `?token=` from the URL via jwtService, so the
 * in-app browser session is authenticated), opens it via the injectable
 * `openBrowser` seam (default: lazy `expo-web-browser` `openBrowserAsync`), and
 * refetches the connections list when the browser closes — the native
 * replacement for the popup-poll / postMessage round-trip.
 *
 * Every I/O seam is injectable so the section is fully testable with the mock
 * gateway and no native browser/secure-store module beyond the standard mocks.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  DeleteConnectionResponse,
  RenameConnectionApiResponse,
  ServiceCategory,
  ServiceConfig,
  ServiceConnection,
  ToggleConnectionActiveResponse,
} from '@vgit2/shared/types';
import { SERVICE_CATEGORIES } from '@vgit2/shared/types';

import { useApi } from '../../../api/ApiProvider';
import { useConnections } from '../../../api/hooks';
import { queryKeys } from '../../../api/keys';
import { getAuthToken } from '../../../auth/secureAuthStore';
import { getRelayUrl } from '../../../api/relayUrlStore';

/**
 * Local query key for the service catalog. Deliberately NOT prefixed with
 * `queryKeys.connections()` (`['connections']`) so invalidating the user's
 * connection list does not refetch the static catalog.
 */
export const CONNECTION_SERVICES_QUERY_KEY = ['connection-services'] as const;

/** `GET /api/connections/services` response (declared locally — no shared hook). */
export interface ServiceCatalogResponse {
  services: ServiceConfig[];
}

/** One available-services group (only enabled, non-connected-exclusive services). */
export interface AvailableServiceGroup {
  category: ServiceCategory;
  label: string;
  services: ServiceConfig[];
}

/** Result of an in-app browser session (subset of expo-web-browser's). */
export interface BrowserResult {
  type?: string;
}

export interface ConnectionsViewModelDeps {
  /** Sandbox base URL for the connect surface (default: SecureStore `getRelayUrl`). */
  resolveSandboxUrl?: () => Promise<string | null>;
  /** Portable authToken for the `?token=` query param (default: SecureStore `getAuthToken`). */
  resolveAuthToken?: () => Promise<string | null>;
  /** Open the connect URL in the in-app browser (default: lazy `openBrowserAsync`). */
  openBrowser?: (url: string) => Promise<BrowserResult>;
}

export interface ConnectionsViewModel {
  /** Initial fetch (connections + catalog) in flight. */
  isLoading: boolean;
  /** Either fetch failed ("failed to load" copy). */
  error: string | null;
  /** Refetch both queries after an error. */
  retry: () => void;

  /** The user's connections (`GET /api/connections`). */
  connections: ServiceConnection[];
  /** Catalog lookup by service id. */
  serviceConfigFor: (service: string) => ServiceConfig | undefined;
  /** Unique connected services (summary: "{count} service(s) connected"). */
  connectedServicesCount: number;
  /** Total connections (summary: "{total} total connection(s)"). */
  totalConnections: number;
  /** Connected-count badge per service. */
  connectionCountFor: (service: string) => number;
  /**
   * Available services grouped by category (SERVICE_CATEGORIES order): only
   * `enabled !== false`, and exclusives already connected are skipped.
   */
  availableGroups: AvailableServiceGroup[];

  /** Open the in-app browser connect flow for a service, then refetch. */
  connect: (service: string) => Promise<void>;
  /** Service id with a connect browser session open (busy state). */
  connectingService: string | null;

  /** `PATCH /api/connections/:id/rename` with `{ newDisplayName }`. */
  rename: (connectionId: string, newDisplayName: string) => Promise<void>;
  renamingId: string | null;

  /** `DELETE /api/connections/:id`. */
  disconnect: (connectionId: string) => Promise<void>;
  disconnectingId: string | null;

  /** `PATCH /api/connections/:id/toggle-active` with `{ isActive }` (exclusive services). */
  toggleActive: (connectionId: string, isActive: boolean) => Promise<void>;
  togglingId: string | null;
}

/** Default browser seam — lazy `require` so Jest/Metro never load it at import. */
function defaultOpenBrowser(url: string): Promise<BrowserResult> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const WebBrowser = require('expo-web-browser') as {
    openBrowserAsync: (u: string) => Promise<BrowserResult>;
  };
  return WebBrowser.openBrowserAsync(url);
}

/** Build the authenticated sandbox connect URL (exported for the test contract). */
export function buildConnectUrl(base: string, service: string, token: string | null): string {
  let url = `${base}/connections?service=${encodeURIComponent(service)}`;
  if (token) url += `&token=${encodeURIComponent(token)}`;
  return url;
}

export function useConnectionsViewModel(deps: ConnectionsViewModelDeps = {}): ConnectionsViewModel {
  const api = useApi();
  const qc = useQueryClient();

  const connectionsQuery = useConnections();
  const servicesQuery = useQuery({
    queryKey: CONNECTION_SERVICES_QUERY_KEY,
    queryFn: () => api.get<ServiceCatalogResponse>('/api/connections/services'),
  });

  const resolveSandboxUrl = deps.resolveSandboxUrl ?? getRelayUrl;
  const resolveAuthToken = deps.resolveAuthToken ?? getAuthToken;
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;

  // The shared GetConnectionsResponse is loose (`connections: any[]`) — narrow
  // to the shared ServiceConnection element shape.
  const connections = useMemo(
    () => (connectionsQuery.data?.connections ?? []) as ServiceConnection[],
    [connectionsQuery.data]
  );
  const services = useMemo(() => servicesQuery.data?.services ?? [], [servicesQuery.data]);

  const serviceConfigMap = useMemo(() => {
    const map: Record<string, ServiceConfig> = {};
    for (const config of services) map[config.service] = config;
    return map;
  }, [services]);

  const connectionCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of connections) counts[c.service] = (counts[c.service] ?? 0) + 1;
    return counts;
  }, [connections]);

  const availableGroups = useMemo<AvailableServiceGroup[]>(() => {
    const connected = new Set(connections.map((c) => c.service));
    const available = services.filter(
      (s) => s.enabled !== false && !(s.isExclusive && connected.has(s.service))
    );
    return SERVICE_CATEGORIES.filter((c) => c.id !== 'all')
      .map((cat) => ({
        category: cat.id as ServiceCategory,
        label: cat.label,
        services: available.filter((s) => s.category === cat.id),
      }))
      .filter((group) => group.services.length > 0);
  }, [connections, services]);

  const invalidateConnections = useCallback(
    () => qc.invalidateQueries({ queryKey: queryKeys.connections() }),
    [qc]
  );

  // ── Connect flow (in-app browser → refetch on close) ──────────────────────
  const [connectingService, setConnectingService] = useState<string | null>(null);
  // Re-entrancy guard (state lags a fast double-tap; the organizations precedent).
  const connectBusyRef = useRef(false);

  const connect = useCallback(
    async (service: string) => {
      if (connectBusyRef.current) return;
      connectBusyRef.current = true;
      setConnectingService(service);
      try {
        const base = await resolveSandboxUrl();
        if (base) {
          const token = await resolveAuthToken();
          await openBrowser(buildConnectUrl(base, service, token));
          // The browser closed — the OAuth/credential flow may have created a
          // connection; re-pull the list.
          await invalidateConnections();
        }
      } catch {
        // Failures are swallowed; the button just re-enables.
      } finally {
        connectBusyRef.current = false;
        setConnectingService(null);
      }
    },
    [resolveSandboxUrl, resolveAuthToken, openBrowser, invalidateConnections]
  );

  // ── Write mutations (each invalidates the shared connections key) ─────────
  const renameMutation = useMutation({
    mutationFn: (vars: { connectionId: string; newDisplayName: string }) =>
      api.patch<RenameConnectionApiResponse>(`/api/connections/${vars.connectionId}/rename`, {
        newDisplayName: vars.newDisplayName,
      }),
    onSuccess: invalidateConnections,
  });

  const disconnectMutation = useMutation({
    mutationFn: (connectionId: string) =>
      api.del<DeleteConnectionResponse>(`/api/connections/${connectionId}`),
    onSuccess: invalidateConnections,
  });

  const toggleMutation = useMutation({
    mutationFn: (vars: { connectionId: string; isActive: boolean }) =>
      api.patch<ToggleConnectionActiveResponse>(
        `/api/connections/${vars.connectionId}/toggle-active`,
        { isActive: vars.isActive }
      ),
    onSuccess: invalidateConnections,
  });

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const rename = useCallback(
    async (connectionId: string, newDisplayName: string) => {
      const trimmed = newDisplayName.trim();
      if (!trimmed) return; // empty rename is a no-op
      setRenamingId(connectionId);
      try {
        await renameMutation.mutateAsync({ connectionId, newDisplayName: trimmed });
      } catch {
        // Rename failure is surfaced as a no-op here (the card re-enables).
      } finally {
        setRenamingId(null);
      }
    },
    [renameMutation]
  );

  const disconnect = useCallback(
    async (connectionId: string) => {
      setDisconnectingId(connectionId);
      try {
        await disconnectMutation.mutateAsync(connectionId);
      } catch {
        // Errors are logged-and-swallowed; the row re-enables.
      } finally {
        setDisconnectingId(null);
      }
    },
    [disconnectMutation]
  );

  const toggleActive = useCallback(
    async (connectionId: string, isActive: boolean) => {
      setTogglingId(connectionId);
      try {
        await toggleMutation.mutateAsync({ connectionId, isActive });
      } catch {
        // Swallowed — same as above.
      } finally {
        setTogglingId(null);
      }
    },
    [toggleMutation]
  );

  const retry = useCallback(() => {
    void connectionsQuery.refetch();
    void servicesQuery.refetch();
  }, [connectionsQuery, servicesQuery]);

  return {
    // v5 `isPending` (not `isLoading`) so an offline-paused cold start still spins.
    isLoading: connectionsQuery.isPending || servicesQuery.isPending,
    error:
      connectionsQuery.isError || servicesQuery.isError
        ? 'Failed to load connected services'
        : null,
    retry,
    connections,
    serviceConfigFor: (service) => serviceConfigMap[service],
    connectedServicesCount: new Set(connections.map((c) => c.service)).size,
    totalConnections: connections.length,
    connectionCountFor: (service) => connectionCounts[service] ?? 0,
    availableGroups,
    connect,
    connectingService,
    rename,
    renamingId,
    disconnect,
    disconnectingId,
    toggleActive,
    togglingId,
  };
}
