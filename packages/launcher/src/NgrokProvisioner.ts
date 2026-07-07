/**
 * NgrokProvisioner — preflight the opt-in `--ngrok` tunnel provider.
 *
 * Unlike {@link CloudflaredProvisioner} (which AUTO-DOWNLOADS the cloudflared binary),
 * ngrok is an EXPLICIT power-user opt-in: the user must already have ngrok installed
 * AND authenticated. This provisioner does NOT download anything — it only VERIFIES
 * those two preconditions and returns the binary path, or **HARD-FAILS** (throws) so
 * the launcher aborts with a clear message. There is deliberately NO silent fallback
 * to cloudflared: the user asked for ngrok, so a broken ngrok setup must fail loudly.
 *
 * Preconditions (both required, in order):
 *   1. the ngrok binary resolves (`PORTABLE_NGROK_BIN` → PATH / win32 probe) and runs;
 *   2. the agent is authenticated — `NGROK_AUTHTOKEN` is set, OR an ngrok config file
 *      with an `authtoken` exists (written by `ngrok config add-authtoken`).
 *
 * Fully DI'd (`detectImpl`/`existsImpl`/`readFileImpl`/`readdirImpl`/`env`/`platform`/
 * `homedir`) so tests never spawn a real binary or touch the real fs.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { detectNgrok, NGROK_SETUP_HINT, resolveNgrokBin } from './NgrokTunnel.js';

type ExistsImpl = (p: string) => boolean;
type ReadFileImpl = (p: string) => string;
type ReaddirImpl = (dir: string) => string[];

const realExistsSync: ExistsImpl = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

const realReadFile: ReadFileImpl = (p) => fs.readFileSync(p, 'utf8');

const realReaddir: ReaddirImpl = (dir) => fs.readdirSync(dir);

/** User-facing instruction shown when ngrok is present but NOT authenticated. */
export const NGROK_AUTH_HINT =
  'ngrok is installed but not authenticated. `--ngrok` needs an authtoken.\n' +
  'Authenticate once:  ngrok config add-authtoken <YOUR_TOKEN>\n' +
  '  (get a token at https://dashboard.ngrok.com/get-started/your-authtoken)\n' +
  'Or export NGROK_AUTHTOKEN=<YOUR_TOKEN> before running `portable --ngrok`.\n' +
  'Or drop `--ngrok` to use the default cloudflared tunnel (no account needed).';

/**
 * Candidate ngrok config-file paths, most-specific first. Covers ngrok v3 defaults
 * per-platform plus the legacy `~/.ngrok2/ngrok.yml`, and honors an explicit
 * `NGROK_CONFIG` override. Presence of an `authtoken:` line in any of them counts as
 * authenticated.
 */
export function ngrokConfigCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: () => string = os.homedir,
  readdirImpl: ReaddirImpl = realReaddir
): string[] {
  const home = (() => {
    try {
      return homedir();
    } catch {
      return '';
    }
  })();
  const candidates: string[] = [];
  const override = env.NGROK_CONFIG?.trim();
  if (override) candidates.push(override);

  if (platform === 'darwin' && home) {
    candidates.push(path.join(home, 'Library', 'Application Support', 'ngrok', 'ngrok.yml'));
  } else if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? (home ? path.join(home, 'AppData', 'Local') : '');
    if (base) {
      candidates.push(path.join(base, 'ngrok', 'ngrok.yml'));
      // MSIX ngrok (winget / Microsoft Store): filesystem virtualization redirects the
      // agent's writes to %LOCALAPPDATA%\ngrok\ngrok.yml into the package's LocalCache —
      // `ngrok config check` reports the classic path, but external processes (us) only
      // see the file under Packages\ngrok.ngrok_<hash>\LocalCache\Local\ngrok\ngrok.yml.
      const packagesDir = path.join(base, 'Packages');
      try {
        for (const name of readdirImpl(packagesDir)) {
          if (!name.toLowerCase().startsWith('ngrok.ngrok_')) continue;
          candidates.push(
            path.join(packagesDir, name, 'LocalCache', 'Local', 'ngrok', 'ngrok.yml')
          );
        }
      } catch {
        // Packages dir missing/unreadable — the classic candidates still apply.
      }
    }
  } else if (home) {
    // Linux + other POSIX: XDG config dir.
    const xdg = env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config');
    candidates.push(path.join(xdg, 'ngrok', 'ngrok.yml'));
  }
  // Legacy location (all platforms).
  if (home) candidates.push(path.join(home, '.ngrok2', 'ngrok.yml'));

  return candidates;
}

export interface NgrokAuthDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
  existsImpl?: ExistsImpl;
  readFileImpl?: ReadFileImpl;
  readdirImpl?: ReaddirImpl;
}

/**
 * Whether the ngrok agent is authenticated: `NGROK_AUTHTOKEN` set, or an ngrok config
 * file containing an `authtoken` entry exists. Never throws (an unreadable candidate
 * is skipped).
 */
export function isNgrokAuthenticated(deps: NgrokAuthDeps = {}): boolean {
  const env = deps.env ?? process.env;
  if ((env.NGROK_AUTHTOKEN?.trim().length ?? 0) > 0) return true;

  const existsImpl = deps.existsImpl ?? realExistsSync;
  const readFileImpl = deps.readFileImpl ?? realReadFile;
  const candidates = ngrokConfigCandidates(
    env,
    deps.platform ?? process.platform,
    deps.homedir,
    deps.readdirImpl
  );
  for (const p of candidates) {
    try {
      if (!existsImpl(p)) continue;
      const contents = readFileImpl(p);
      // The authtoken key in ngrok.yml (v3: `authtoken:`, legacy also `authtoken:`).
      if (/^\s*authtoken\s*:\s*\S+/m.test(contents)) return true;
    } catch {
      // Unreadable candidate — skip it.
    }
  }
  return false;
}

export interface EnsureNgrokDeps {
  /** Base env (read `PORTABLE_NGROK_BIN` / `NGROK_AUTHTOKEN` / `NGROK_CONFIG`). */
  env?: NodeJS.ProcessEnv;
  /** Boot log sink. Defaults to console.log. */
  log?: (line: string) => void;
  /** ngrok presence-detection seam (injected in tests). Defaults to {@link detectNgrok}. */
  detectImpl?: (bin: string) => Promise<boolean>;
  /** ngrok binary resolver seam (injected in tests). Defaults to {@link resolveNgrokBin}. */
  resolveBin?: (env: NodeJS.ProcessEnv) => string;
  /** Authentication check seam (injected in tests). Defaults to {@link isNgrokAuthenticated}. */
  isAuthenticated?: (env: NodeJS.ProcessEnv) => boolean;
}

/**
 * Ensure ngrok is available AND authenticated, and return the binary path to spawn.
 * **HARD-FAILS** (throws) when either precondition is missing — the launcher surfaces
 * the thrown hint as a fatal and aborts (no fallback to cloudflared).
 */
export async function ensureNgrok(deps: EnsureNgrokDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  const resolveBin = deps.resolveBin ?? ((e: NodeJS.ProcessEnv) => resolveNgrokBin(e));
  const detectImpl = deps.detectImpl ?? ((bin: string) => detectNgrok(bin));
  const isAuthenticated =
    deps.isAuthenticated ?? ((e: NodeJS.ProcessEnv) => isNgrokAuthenticated({ env: e }));

  const bin = resolveBin(env);

  // 1. Binary must be present + runnable.
  const present = await detectImpl(bin);
  if (!present) {
    throw new Error(NGROK_SETUP_HINT);
  }

  // 2. Agent must be authenticated (authtoken).
  if (!isAuthenticated(env)) {
    throw new Error(NGROK_AUTH_HINT);
  }

  log(`[launcher] ✓ ngrok present + authenticated: ${bin}`);
  return bin;
}
