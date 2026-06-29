/**
 * Report UTM attribution to the gateway.
 *
 * Bearer-authenticated: the gateway derives the userId + email from the token
 * and (a) ensures the user's `user_attribution` row exists — binding email + any
 * captured campaign UTM — and (b) marks `first_use_at`, so a mobile user finally
 * counts as a "verified signup". Fire-and-forget: resolves `false` on ANY failure
 * (no token / network / non-2xx) so the caller can retry on the next launch, and
 * NEVER throws.
 */

import { GatewayClient } from '../../services/gatewayClient';
import { getGatewayUrl } from '../auth/gatewayConfig';
import { getAuthToken } from '../auth/secureAuthStore';

import type { UtmFields } from './utm';
import type { MobileRnUtmRequest } from '@vgit2/shared/types';

export interface ReportAttributionDeps {
  /** Captured first-touch UTM (or null/undefined for an organic install). */
  utm?: UtmFields | null;
  /** Injectable gateway client (defaults to one built from the live gateway URL). */
  gateway?: Pick<GatewayClient, 'reportUtm'>;
  /** Injectable authToken reader (defaults to SecureStore `getAuthToken`). */
  getToken?: () => Promise<string | null>;
}

/** Drop empty/undefined UTM fields so the wire body carries only real values. */
function toRequestBody(utm: UtmFields | null | undefined): MobileRnUtmRequest {
  const body: MobileRnUtmRequest = {};
  if (!utm) return body;
  if (utm.utm_source) body.utm_source = utm.utm_source;
  if (utm.utm_medium) body.utm_medium = utm.utm_medium;
  if (utm.utm_campaign) body.utm_campaign = utm.utm_campaign;
  if (utm.utm_content) body.utm_content = utm.utm_content;
  if (utm.utm_term) body.utm_term = utm.utm_term;
  if (utm.landing_url) body.landing_url = utm.landing_url;
  return body;
}

export async function reportUtmAttribution(deps: ReportAttributionDeps = {}): Promise<boolean> {
  const getToken = deps.getToken ?? getAuthToken;

  let token: string | null;
  try {
    token = await getToken();
  } catch {
    return false;
  }
  if (!token) return false;

  const gateway = deps.gateway ?? new GatewayClient({ gatewayUrl: getGatewayUrl() });
  try {
    await gateway.reportUtm(token, toRequestBody(deps.utm));
    return true;
  } catch {
    return false;
  }
}
