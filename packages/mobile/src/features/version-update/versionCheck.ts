/**
 * versionCheck — the framework-free core of the version-update gate. The rule:
 * fetch the gateway's minimum supported
 * version, compare **major.minor only** (patch is irrelevant — patches are
 * backwards-compatible), and FAIL OPEN on any error/timeout/unparseable data so
 * the app never even sees the prompt on a flaky network or a version-service
 * hiccup.
 *
 * Pure + injectable (no React/Expo/native deps) so it unit-tests with a mocked
 * `getMinimumVersion` and a no-op `sleep`.
 */

/**
 * The gate's decision: render the app as-is, or offer the dismissible
 * "Update available" prompt over it (`update-required` — the historical wire
 * name for "a newer version is available"; it no longer hard-blocks, #1522).
 */
export type VersionGateVerdict = 'ok' | 'update-required';

/**
 * Does `appVersion` satisfy `minimumVersion` at the major.minor level?
 *
 * Rule:
 *   - different major → `appMajor > minMajor`
 *   - same major      → `appMinor >= minMinor`
 *   - patch is ignored entirely (1.4.0 ≡ 1.4.9)
 *
 * Unparseable input on either side → `true` (FAIL OPEN — never block on bad
 * data). "App ahead of gateway" (e.g. a freshly-submitted store-review build at
 * 1.6 while the deployed gateway is still 1.5) is therefore NEVER blocked.
 */
export function meetsMinimumVersion(appVersion: string, minimumVersion: string): boolean {
  const [curMaj = 0, curMin = 0] = appVersion.split('.').map(Number);
  const [minMaj = 0, minMin = 0] = minimumVersion.split('.').map(Number);

  // Fail open if either version is unparseable — never block on bad data.
  if (![curMaj, curMin, minMaj, minMin].every((n) => Number.isFinite(n))) {
    return true;
  }

  return curMaj !== minMaj ? curMaj > minMaj : curMin >= minMin;
}

/** Default backoff sleep (real timers; tests inject a no-op). */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Race a promise against a timeout. The timer is ALWAYS cleared (on resolve AND
 * reject), so this never leaks a pending handle into a test's event loop.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('min-version check timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export interface RunVersionGateDeps {
  /** This build's own version (e.g. from `Constants.expoConfig.version`). */
  appVersion: string;
  /** Fetch the gateway minimum version (default: `GatewayClient.getMinVersion`). */
  getMinimumVersion: () => Promise<string>;
  /** Max fetch attempts before failing open (default 3). */
  maxAttempts?: number;
  /** Exponential backoff base (default 1000ms). */
  baseDelayMs?: number;
  /** Per-attempt timeout (default 5000ms). */
  timeoutMs?: number;
  /** Backoff sleep (injectable for deterministic tests). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run the version gate with retry + timeout, FAILING OPEN on exhaustion.
 *
 * A successful response decides the verdict immediately (`update-required` is
 * returned without retrying — a real "you're behind" answer is authoritative).
 * Only errors/timeouts retry with exponential backoff; once the attempt budget
 * is spent the verdict is `'ok'` (never block on an unreachable gateway).
 */
export async function runVersionGate(deps: RunVersionGateDeps): Promise<VersionGateVerdict> {
  const { appVersion, getMinimumVersion } = deps;
  const maxAttempts = deps.maxAttempts ?? 3;
  const baseDelayMs = deps.baseDelayMs ?? 1000;
  const timeoutMs = deps.timeoutMs ?? 5000;
  const sleep = deps.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const minimumVersion = await withTimeout(getMinimumVersion(), timeoutMs);
      return meetsMinimumVersion(appVersion, minimumVersion) ? 'ok' : 'update-required';
    } catch {
      // Exhausted the budget → fail open (the app is never blocked on a flaky
      // network / version-service outage).
      if (attempt >= maxAttempts) return 'ok';
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }

  return 'ok';
}
