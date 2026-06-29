/**
 * Public surface of the API feature: the authed sandbox HTTP client,
 * the TanStack Query wiring (`ApiProvider`/`useApi`), the online-aware query
 * client, and the typed endpoint hooks.
 */

export {
  RelayApiClient,
  ApiHttpError,
  NoRelayUrlError,
  NoAuthTokenError,
  type RelayApiClientOptions,
} from './relayClient';
export {
  BaseUrlResolver,
  MissingGatewayUrlError,
  GATEWAY_PATH_PREFIXES,
  targetForPath,
  getGatewayUrl,
  getRelayUrl,
  type BaseUrlTarget,
  type BaseUrlResolverDeps,
} from './baseUrls';
export {
  createQueryClient,
  configureQueryOnlineManager,
  backoffDelay,
  type NetInfoLike,
} from './queryClient';
export { ApiProvider, useApi, type ApiProviderProps } from './ApiProvider';
export { queryKeys } from './keys';
export * from './hooks';
