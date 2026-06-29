/**
 * ApiProvider — the app-shell wiring for server state.
 *
 * Mounts the shared TanStack Query client (via `QueryClientProvider`), bridges
 * NetInfo into `onlineManager` so queries/mutations pause-and-resume across
 * connectivity changes, and exposes the authed {@link RelayApiClient} through
 * React context (`useApi()`). Every typed endpoint hook reads the client from
 * here, so the whole app shares one Bearer/refresh/sandbox-URL path.
 *
 * All collaborators are injectable (`client`, `queryClient`, `netInfo`) so tests
 * mount the provider with mocked HTTP + connectivity and no native modules.
 */

import NetInfo from '@react-native-community/netinfo';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';

import { GatewayClient } from '../../services/gatewayClient';
import { getGatewayUrl } from '../auth/gatewayConfig';
// FILE import (not the pc-connect barrel) so the heavy PcConnectGate graph stays
// out of the api module — only the SecureStore-backed token resolver is pulled in.
import { persistRenewedDataPathToken, resolveDataPathToken } from '../pc-connect/dataPathToken';
import { RelayApiClient } from './relayClient';
import { configureQueryOnlineManager, createQueryClient, type NetInfoLike } from './queryClient';

const ApiContext = createContext<RelayApiClient | null>(null);

export interface ApiProviderProps {
  children: ReactNode;
  /** Override the API client (default: built from the configured Gateway URL). */
  client?: RelayApiClient;
  /** Override the QueryClient (default: `createQueryClient()`). */
  queryClient?: QueryClient;
  /** Override the NetInfo source (default: `@react-native-community/netinfo`). */
  netInfo?: NetInfoLike;
}

/** Build the default authed sandbox client from the configured Gateway URL. */
function buildDefaultClient(): RelayApiClient {
  const gateway = new GatewayClient({ gatewayUrl: getGatewayUrl() });
  // The relay data path is authenticated by the connected PC's data-path JWT
  // (QR pairing), falling back to the legacy Portable authToken when no PC is
  // connected — every `/api/*` request rides this single funnel. The PC slides
  // the JWT and returns it in `X-Renewed-Token`; persist it for the connected pcId
  // so an actively-used pairing never expires (no `/refresh` on the PC).
  return new RelayApiClient({
    gateway,
    getToken: resolveDataPathToken,
    persistRenewedToken: persistRenewedDataPathToken,
  });
}

export function ApiProvider({
  children,
  client,
  queryClient,
  netInfo,
}: ApiProviderProps): React.JSX.Element {
  // Stable for the provider's lifetime (recreating the QueryClient drops cache).
  const apiClient = useMemo(() => client ?? buildDefaultClient(), [client]);
  const qc = useMemo(() => queryClient ?? createQueryClient(), [queryClient]);
  const netInfoRef = useRef(netInfo ?? (NetInfo as unknown as NetInfoLike));

  useEffect(() => {
    configureQueryOnlineManager(netInfoRef.current);
  }, []);

  return (
    <QueryClientProvider client={qc}>
      <ApiContext.Provider value={apiClient}>{children}</ApiContext.Provider>
    </QueryClientProvider>
  );
}

/** Access the shared authed sandbox API client. Throws if used outside ApiProvider. */
export function useApi(): RelayApiClient {
  const client = useContext(ApiContext);
  if (!client) {
    throw new Error('useApi() must be used within an <ApiProvider>.');
  }
  return client;
}

/**
 * Non-throwing {@link useApi} (the `useOptionalSocket` pattern): `null` when no
 * `ApiProvider` is mounted. For screens that ALSO render outside the provider
 * tree (e.g. the settings root in unit tests) and degrade by hiding the
 * server-backed affordances instead of crashing.
 */
export function useOptionalApi(): RelayApiClient | null {
  return useContext(ApiContext);
}
