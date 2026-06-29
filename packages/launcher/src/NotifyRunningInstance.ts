import { LocalSecretStore } from '@vgit2/shared/secrets';

import { resolveApiBaseUrl } from './config.js';
import { ensureJwtSecret, mintPairingToken, resolvePairingIdentity } from './PairingIdentity.js';
import { resolvePcId } from './TunnelRegistrationAgent.js';

/**
 * Tell a RUNNING `portable` to pick up a `portable link`/`unlink` WITHOUT a
 * restart.
 *
 * `portable link`/`unlink` only mutate the filesystem (the workspace junction +
 * `repo-views.json`). The api discovers local repos by walking the workspace
 * live per request, but an already-running api keeps two in-memory caches that
 * hide the change until restart: the repos-list cache (`ReposCacheService`, 5-min
 * TTL) and the viewed-repos cache (`RepoViewTrackerService`, loaded once). So the
 * link/unlink CLI fires a best-effort loopback POST to `POST /api/repos/rescan`,
 * which drops both for the calling identity — the linked project then shows up on
 * the next repos fetch with no restart.
 *
 * The CLI is a SEPARATE process from the running launcher, but it shares the same
 * machine: it re-derives the SAME data-path JWT the launcher minted (same
 * `JWT_SECRET` + `pcId` from the shared `LocalSecretStore`, same
 * `resolvePairingIdentity`), so the api accepts the token and scopes the
 * invalidation to the same identity the app uses. The api binds loopback, so the
 * request never leaves the PC.
 *
 * Best-effort by design: returns `false` (never throws) when `portable` isn't
 * running (connection refused), the request times out, or anything else fails —
 * the caller then falls back to telling the user to restart.
 */

/** A zero-arg notifier: resolves true when a running `portable` acknowledged the rescan. */
export type NotifyRepoChange = () => Promise<boolean>;

export interface NotifyRepoChangeDeps {
  /** Env to resolve the api port + JWT secret from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Shared secret store (JWT secret + pcId). Defaults to a real {@link LocalSecretStore}. */
  store?: LocalSecretStore;
  /** fetch seam (injected in tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Loopback request timeout (ms). Default 1500 — the api is local, so this is generous. */
  timeoutMs?: number;
}

export async function notifyRunningInstanceOfRepoChange(
  deps: NotifyRepoChangeDeps = {}
): Promise<boolean> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 1500;

  // Mint the same data-path JWT the launcher uses, from the shared local secret
  // store. If this fails (no store access, etc.) there's nothing to notify with.
  let token: string;
  try {
    const store = deps.store ?? new LocalSecretStore();
    const jwtSecret = ensureJwtSecret(store, env);
    const pcId = resolvePcId(store, env);
    const identity = resolvePairingIdentity({ pcId });
    token = mintPairingToken(identity, jwtSecret);
  } catch {
    return false;
  }

  const url = `${resolveApiBaseUrl(env)}/api/repos/rescan`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    // portable not running (ECONNREFUSED) / timeout / network error — best-effort.
    return false;
  } finally {
    clearTimeout(timer);
  }
}
