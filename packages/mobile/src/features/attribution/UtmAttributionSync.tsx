/**
 * UtmAttributionSync — render-null layer (the `ThemeSync`/`ChatListSync`
 * precedent) that captures campaign UTM and reports attribution to the gateway
 * Mounted by `AppShell` inside `ApiProvider`, so it runs only for
 * a signed-in, fully-provisioned user the moment they reach the authenticated
 * app — covering BOTH a freshly-onboarded user and an already-onboarded one
 * landing on home.
 */

import { useUtmAttribution, type UtmAttributionDeps } from './useUtmAttribution';

export function UtmAttributionSync(props: UtmAttributionDeps = {}): null {
  useUtmAttribution(props);
  return null;
}
