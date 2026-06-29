/**
 * extendSession — keep the sandbox session alive.
 *
 * The "I'm still here" dismiss on the idle warning must EXTEND the session, not
 * merely hide the modal. It `POST`s `/api/activity/ping` to the sandbox; the
 * server's activity-tracker middleware resets the idle timer on any non-ignored
 * REST request, so this ping defers the shutdown. The follow-up
 * `system:idle_warning_cleared` from the server then clears the warning on every
 * device.
 *
 * Framework-free + injectable (the authed `fetch` and the sandbox-URL resolver
 * are passed in), so it is deterministically unit-testable. The request rides the
 * Bearer-authenticated `AuthedFetch` against the mutable sandbox base URL, so it is
 * deferred (a no-op) until provisioning has persisted a sandbox URL.
 */

import { createAuthedFetch, type AuthedFetch } from '../auth/authedFetch';
import { getGatewayUrl } from '../auth/gatewayConfig';
import { getRelayUrl } from '../api/relayUrlStore';
import { GatewayClient } from '../../services/gatewayClient';

/** Sandbox endpoint that records user activity and resets the idle timer. */
export const ACTIVITY_PING_PATH = '/api/activity/ping';

export interface ExtendSessionDeps {
  /** Bearer-authenticated fetch (default: `createAuthedFetch` over the real Gateway). */
  fetchImpl?: AuthedFetch;
  /** Resolve the sandbox base URL (default: SecureStore `getRelayUrl`). */
  resolveSandboxUrl?: () => Promise<string | null>;
}

/**
 * Reset the sandbox idle timer ("I'm still here"). Returns `true` if the ping was
 * sent (sandbox reachable + 2xx), `false` when there is no sandbox URL yet or the
 * request failed — the caller clears the warning regardless (the user acted).
 */
export async function extendSession(deps: ExtendSessionDeps = {}): Promise<boolean> {
  const resolveSandboxUrl = deps.resolveSandboxUrl ?? getRelayUrl;
  const sandboxUrl = await resolveSandboxUrl();
  if (!sandboxUrl) return false;

  const fetchImpl =
    deps.fetchImpl ??
    createAuthedFetch({ gateway: new GatewayClient({ gatewayUrl: getGatewayUrl() }) });

  const base = sandboxUrl.replace(/\/$/, '');
  try {
    const res = await fetchImpl(`${base}${ACTIVITY_PING_PATH}`, { method: 'POST' });
    return res.ok;
  } catch {
    // The user tried to confirm; a transient failure must not crash the UI. The
    // modal still clears, and the server's idle loop will re-warn if needed.
    return false;
  }
}
