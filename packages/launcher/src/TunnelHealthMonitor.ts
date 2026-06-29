/**
 * Tunnel self-heal: continuously verify this PC is reachable through the PUBLIC
 * relay path the mobile app actually uses, and cycle cloudflared when it isn't.
 *
 * WHY a public probe (not a local / direct-tunnel one). The launcher already
 * supervises cloudflared (restart-on-crash) and the registration agent already
 * heartbeats the gateway. But there's a failure class neither catches: the
 * **local api is perfectly healthy and cloudflared is alive, yet the gateway's
 * `TunnelRegistry` points at a dead/stale tunnel URL** — e.g. cloudflared rotated
 * its hostname and the re-register was rate-limited, or the 15s TTL lapsed
 * with no successful re-register. The phone then gets a Cloudflare dead-origin
 * 502/530 (or a "no PC" 404) from `app.portable-dev.com/t/<pcId>/...` even though
 * everything on the PC looks fine. A local `/api/health` check passes, and a probe
 * of the *direct* `*.trycloudflare.com` URL also passes — only an end-to-end probe
 * of the RELAY endpoint exposes the broken mapping.
 *
 * So this monitor periodically `GET`s `<relayHealthUrl>` (the same
 * `<gatewayBase>/t/<pcId>/api/health` path the app hits — unauthenticated on the
 * api, so no token needed) and, on sustained failure WHILE the loopback api is
 * healthy, calls {@link StartTunnelHealthMonitorOptions.cycle} to rotate
 * cloudflared. A rotation mints a fresh hostname and re-fires the registration
 * agent, which republishes the mapping and recovers the relay.
 *
 * Guards against making things worse:
 *  - It only blames the tunnel when the **local api probe passes** — if the api
 *    itself is down, that's the api-death path's job, not a tunnel cycle.
 *  - It requires `failureThreshold` consecutive failures before cycling, so a
 *    one-off blip (or cloudflared's own few-second restart) doesn't trigger one.
 *  - After a cycle it waits a `cooldownMs` quiet period (the new tunnel needs a
 *    few seconds to come up + re-register + propagate before a probe is meaningful)
 *    and ESCALATES that cooldown exponentially (up to `maxCooldownMs`) while cycles
 *    keep failing to recover — so a gateway outage or a register rate-limit can't
 *    spin us into a tight cycle loop. A single healthy probe resets everything.
 *
 * Self-scheduling single timer (mirrors {@link TunnelRegistrationAgent}); all
 * `fetch`/timer seams are injected so the whole loop is unit-tested with a stubbed
 * relay + manual timers (no real network/clock).
 */

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;
type SetTimer = (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
type ClearTimer = (handle: ReturnType<typeof setTimeout>) => void;

/** Default cadence between health probes (ms). */
export const DEFAULT_HEALTH_PROBE_INTERVAL_MS = 30_000;
/** Default consecutive public failures (api healthy) before a cycle. */
export const DEFAULT_HEALTH_FAILURE_THRESHOLD = 2;
/** Default quiet period after a cycle before probing resumes (ms). */
export const DEFAULT_HEALTH_COOLDOWN_MS = 30_000;
/** Default ceiling for the escalating post-cycle cooldown (ms). */
export const DEFAULT_HEALTH_MAX_COOLDOWN_MS = 300_000;
/** Default per-probe network timeout (ms). */
export const DEFAULT_HEALTH_REQUEST_TIMEOUT_MS = 8_000;

export interface TunnelHealthMonitorHandle {
  /** Stop probing. Idempotent. */
  stop(): void;
}

export interface StartTunnelHealthMonitorOptions {
  /**
   * The PUBLIC relay health URL the app uses — `<gatewayBase>/t/<pcId>/api/health`.
   * A `GET` should return HTTP 200 with `{ status: 'ok' }`; anything else (502/530
   * dead origin, 404 no-PC, timeout, network error) counts as a public failure.
   */
  relayHealthUrl: string;
  /**
   * The loopback api health URL — `http://127.0.0.1:<port>/api/health`. Probed
   * FIRST: only when the local api is healthy do we attribute a relay failure to
   * the tunnel/gateway (and consider cycling).
   */
  localHealthUrl: string;
  /** Force a cloudflared rotation (new hostname → re-register). Wired to TunnelRouter.cycle. */
  cycle: () => void;
  /**
   * Is a mobile device CURRENTLY connected through the relay? When true, the
   * end-to-end relay→tunnel→api path is demonstrably working (the device's live
   * Socket.IO connection proves it), so a failing UNAUTHENTICATED public probe is
   * almost certainly a transient flap — NOT a dead mapping. Cycling cloudflared
   * here would only DROP that live device and cold-start a fresh tunnel that fails
   * the probe again (the reconnection loop). So the monitor suppresses the cycle
   * while a device is connected; genuine self-heal still fires when NO device is
   * connected (the only case a dead mapping actually strands the phone). Default
   * `() => false` (no suppression). Wired by the Launcher to the live
   * device-presence it already polls.
   */
  isDeviceConnected?: () => boolean;
  /** Probe cadence (ms). Default {@link DEFAULT_HEALTH_PROBE_INTERVAL_MS}. */
  intervalMs?: number;
  /** Consecutive failures (api healthy) before cycling. Default {@link DEFAULT_HEALTH_FAILURE_THRESHOLD}. */
  failureThreshold?: number;
  /** Quiet period after a cycle before resuming probes (ms). Default {@link DEFAULT_HEALTH_COOLDOWN_MS}. */
  cooldownMs?: number;
  /** Ceiling for the escalating cooldown (ms). Default {@link DEFAULT_HEALTH_MAX_COOLDOWN_MS}. */
  maxCooldownMs?: number;
  /** Per-probe network timeout (ms). Default {@link DEFAULT_HEALTH_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
  /** fetch seam (injected in tests). Defaults to global fetch. */
  fetchImpl?: FetchImpl;
  /** setTimeout seam (injected in tests). */
  setTimeoutImpl?: SetTimer;
  /** clearTimeout seam (injected in tests). */
  clearTimeoutImpl?: ClearTimer;
  /** Line sink. Defaults to console.log. */
  log?: (line: string) => void;
}

/**
 * Start the tunnel self-heal monitor. Returns a handle whose `stop()` cancels it.
 * The first probe fires after `intervalMs` (giving the tunnel time to come up +
 * register at boot), then it self-schedules.
 */
export function startTunnelHealthMonitor(
  options: StartTunnelHealthMonitorOptions
): TunnelHealthMonitorHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_HEALTH_PROBE_INTERVAL_MS;
  const failureThreshold = options.failureThreshold ?? DEFAULT_HEALTH_FAILURE_THRESHOLD;
  const cooldownMs = options.cooldownMs ?? DEFAULT_HEALTH_COOLDOWN_MS;
  const maxCooldownMs = options.maxCooldownMs ?? DEFAULT_HEALTH_MAX_COOLDOWN_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_HEALTH_REQUEST_TIMEOUT_MS;
  const isDeviceConnected = options.isDeviceConnected ?? (() => false);
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const setTimeoutImpl = options.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimeoutImpl = options.clearTimeoutImpl ?? ((h) => clearTimeout(h));
  const log = options.log ?? ((line) => console.log(line));

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive relay failures (with a healthy api) since the last good probe / cycle. */
  let consecutiveFailures = 0;
  /** Consecutive cycles that have NOT been followed by a healthy probe (drives backoff). */
  let unrecoveredCycles = 0;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeoutImpl(() => {
      void tick();
    }, delayMs);
    if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  };

  /** GET a health URL; true only on HTTP 200 + `{ status: 'ok' }`. Never throws. */
  const probe = async (url: string): Promise<boolean> => {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const abortTimer = controller
      ? setTimeoutImpl(() => controller.abort(), requestTimeoutMs)
      : null;
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller?.signal,
      });
      if (!res.ok) return false;
      const body = (await res.json().catch(() => null)) as { status?: string } | null;
      return body?.status === 'ok';
    } catch {
      return false;
    } finally {
      if (abortTimer !== null) clearTimeoutImpl(abortTimer);
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;

    // 1. Is the local api healthy? If not, this is NOT a tunnel problem — skip.
    const localOk = await probe(options.localHealthUrl);
    if (stopped) return;
    if (!localOk) {
      // The api itself is down/restarting; the api-death path owns that. Reset the
      // failure streak so we don't cycle the moment the api comes back.
      consecutiveFailures = 0;
      schedule(intervalMs);
      return;
    }

    // 2. Is the PUBLIC relay path healthy (what the phone actually sees)?
    const relayOk = await probe(options.relayHealthUrl);
    if (stopped) return;

    if (relayOk) {
      if (consecutiveFailures > 0 || unrecoveredCycles > 0) {
        log('[health] public ingress healthy again');
      }
      consecutiveFailures = 0;
      unrecoveredCycles = 0;
      schedule(intervalMs);
      return;
    }

    // 3. Local healthy, relay unhealthy → the tunnel/gateway mapping is broken.
    consecutiveFailures += 1;
    log(
      `[health] public ingress unreachable while the api is healthy ` +
        `(${consecutiveFailures}/${failureThreshold})`
    );

    if (consecutiveFailures < failureThreshold) {
      schedule(intervalMs);
      return;
    }

    // Threshold hit — but if a device is CONNECTED right now, the relay path
    // demonstrably works end-to-end (its live socket rides the same tunnel), so a
    // failing public probe is a transient flap, not a dead mapping. Cycling would
    // tear down that working tunnel and drop the device, and the fresh cold tunnel
    // would just fail the probe again — the reconnection loop. Suppress the cycle
    // while connected; self-heal still fires once no device is connected (the only
    // case a dead mapping actually strands the phone).
    if (isDeviceConnected()) {
      log(
        '[health] public probe failing but a device is connected — NOT cycling ' +
          '(relay works end-to-end; self-heal suppressed)'
      );
      consecutiveFailures = 0;
      schedule(intervalMs);
      return;
    }

    // Threshold hit, no device connected — rotate cloudflared to re-mint the
    // hostname + re-register.
    consecutiveFailures = 0;
    unrecoveredCycles += 1;
    log(`[health] cycling the tunnel to recover public ingress (cycle #${unrecoveredCycles})`);
    try {
      options.cycle();
    } catch (err) {
      log(`[health] cycle error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Quiet period before re-probing; escalate it while cycles keep not recovering
    // (e.g. the gateway is down or rate-limiting our re-registers) so we never spin.
    const cooldown = Math.min(maxCooldownMs, cooldownMs * 2 ** (unrecoveredCycles - 1));
    schedule(cooldown);
  };

  schedule(intervalMs);

  return {
    stop: () => {
      stopped = true;
      if (timer !== null) {
        try {
          clearTimeoutImpl(timer);
        } catch {
          // ignore
        }
        timer = null;
      }
    },
  };
}
