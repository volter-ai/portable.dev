/**
 * CloudflaredProvisioner — auto-provision the `cloudflared` binary.
 *
 * Mirrors {@link ChromiumProvisioner}: instead of requiring the user to install
 * cloudflared themselves (winget/brew/apt), we treat it as a GENUINE auto-provisioned
 * dependency via the `cloudflared` npm package, which downloads the OFFICIAL static
 * binary from Cloudflare's releases ONCE, cross-platform (macOS/Linux/Windows) — the
 * same model Playwright uses for Chromium. Pin the version with `CLOUDFLARED_VERSION`.
 *
 * Resolution order (first hit wins, never throws):
 *   1. `PORTABLE_CLOUDFLARED_BIN` override (any platform).
 *   2. the package's managed binary (`cloudflared`.bin) — download once if missing.
 *   3. fallback to an already-installed cloudflared on PATH / the win32 dir probe
 *      ({@link resolveCloudflaredBin}) when the auto-download is unavailable (offline).
 *
 * Fully DI'd (`loadModule`/`existsImpl`/`resolveFallback`) so tests never download a
 * real binary or touch the real fs.
 */
import fs from 'fs';

import { resolveCloudflaredBin } from './CloudflaredTunnel.js';

type ExistsImpl = (p: string) => boolean;

const realExistsSync: ExistsImpl = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

/** The slice of the `cloudflared` npm package this provisioner uses. */
export interface CloudflaredModule {
  /** Path the managed binary lives at (under the package dir). */
  bin: string;
  /** Download the binary to `to` (defaults to {@link bin}); returns the path. */
  install: (to: string) => Promise<string> | string;
}

export interface EnsureCloudflaredDeps {
  /** Base env (read `PORTABLE_CLOUDFLARED_BIN` / `CLOUDFLARED_VERSION`). */
  env?: NodeJS.ProcessEnv;
  /** Boot log sink. Defaults to console.log. */
  log?: (line: string) => void;
  /** fs.existsSync seam (injected in tests). */
  existsImpl?: ExistsImpl;
  /** Load the `cloudflared` package (injected in tests; real default uses dynamic import). */
  loadModule?: () => Promise<CloudflaredModule>;
  /** Fallback bin resolver when auto-provision is unavailable (injected in tests). */
  resolveFallback?: (env: NodeJS.ProcessEnv) => string;
}

/**
 * Ensure a cloudflared binary is available and return the path to spawn. Auto-downloads
 * it via the `cloudflared` package when missing; never throws (a download failure
 * degrades to the PATH fallback + the existing missing-binary hint at spawn time).
 */
export async function ensureCloudflared(deps: EnsureCloudflaredDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  const existsImpl = deps.existsImpl ?? realExistsSync;
  const resolveFallback =
    deps.resolveFallback ?? ((e: NodeJS.ProcessEnv) => resolveCloudflaredBin(e));

  // 1. Explicit override always wins.
  const override = env.PORTABLE_CLOUDFLARED_BIN?.trim();
  if (override) {
    log(`[launcher] cloudflared (PORTABLE_CLOUDFLARED_BIN): ${override}`);
    return override;
  }

  // 2. Auto-provision via the cloudflared package (official binary, cross-platform).
  try {
    const mod = deps.loadModule
      ? await deps.loadModule()
      : ((await import('cloudflared')) as unknown as CloudflaredModule);
    const binPath = mod?.bin;
    if (binPath && existsImpl(binPath)) {
      log(`[launcher] ✓ cloudflared present: ${binPath}`);
      return binPath;
    }
    if (binPath && typeof mod.install === 'function') {
      log('[launcher] Installing cloudflared (one-time download)…');
      const installed = (await mod.install(binPath)) || binPath;
      if (existsImpl(installed)) {
        log(`[launcher] ✓ cloudflared installed: ${installed}`);
        return installed;
      }
    }
  } catch (err) {
    log(
      `[launcher] cloudflared auto-provision unavailable (${
        err instanceof Error ? err.message : String(err)
      }); falling back to an installed cloudflared.`
    );
  }

  // 3. Fallback: an already-installed cloudflared (PATH / win32 probe).
  return resolveFallback(env);
}
