/**
 * Launcher configuration.
 *
 * Resolves everything the `portable start` launcher needs from the environment
 * at CALL TIME (so tests can toggle env between runs): the loopback bind host,
 * the api port, the path to the api server entry, and the env handed to the
 * spawned api child. The launcher is the local tunnel-router gateway — it binds
 * the api to 127.0.0.1 and owns the cloudflared tunnel that is the
 * single public ingress to this PC.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import dotenv from 'dotenv';

/** Default api port when VGIT_PORT is unset. Mirrors packages/api/server.ts. */
export const DEFAULT_VGIT_PORT = 4200;

/** Loopback host the api binds to in local mode (threat model: "api binds localhost"). */
export const LOCAL_BIND_HOST = '127.0.0.1';

/**
 * Default hosted relay (online gateway) the PC registers its tunnel URL with.
 * Override via `PORTABLE_RELAY_URL` to point at a self-hosted relay.
 * Defaults to the staging relay so `portable start` works without setting the
 * env explicitly.
 */
export const DEFAULT_RELAY_BASE_URL = 'https://app.portable-dev.com';

/**
 * Resolve the hosted-relay base URL the registration agent talks to
 * (`/tunnel/register` + `/tunnel/heartbeat`). Reads `PORTABLE_RELAY_URL` at CALL
 * TIME (self-host); falls back to {@link DEFAULT_RELAY_BASE_URL}. The trailing
 * slash is stripped so callers can append paths directly.
 */
export function resolveRelayBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PORTABLE_RELAY_URL?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_RELAY_BASE_URL).replace(/\/$/, '');
}

/**
 * Whether this launcher should PUBLISH its launcher-minted data-path JWT to the
 * gateway on tunnel registration (the Apple-reviewer opt-in). Read at CALL TIME
 * from `PORTABLE_REVIEWER_PUBLISH`; `'true'`/`'1'` = on, anything else / unset = OFF.
 *
 * ⚠️ A NORMAL PC NEVER publishes its JWT. This is OPT-IN, default OFF, and ONLY for
 * the disposable Apple-reviewer EC2 box — so the operator never needs the
 * `JWT_SECRET` and no JWT is stored in GitHub (the reviewer route reads the
 * published token from the relay). Default OFF keeps the gateway/registry holding
 * NO data-path JWTs for every existing PC (the invariant): the register body
 * carries no `reviewerToken`, byte-unchanged from today.
 */
export function resolveReviewerPublish(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PORTABLE_REVIEWER_PUBLISH?.trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the api server entry. Dev/monorepo spawns the api from SOURCE
 * (`packages/launcher/src` -> `packages/api/src/server.ts`); the packaged artifact
 * (PRD: tasks/prd-portable-distribution.md) ships `cli.js` + `server.js` as SIBLINGS
 * in `dist/`, so when the source entry is absent we resolve the sibling bundle.
 * `PORTABLE_API_ENTRY` overrides both (tests / custom layouts).
 */
export function resolveApiServerEntry(): string {
  const override = process.env.PORTABLE_API_ENTRY?.trim();
  if (override) return override;
  const sourceEntry = path.resolve(HERE, '../../api/src/server.ts');
  if (fs.existsSync(sourceEntry)) return sourceEntry; // dev: api from source
  return path.resolve(HERE, 'server.js'); // packaged: sibling bundle in dist/
}

/**
 * Working directory for the spawned api process. Dev: `packages/api` (so the api's
 * own node_modules + cwd-relative MCP fallbacks resolve). Packaged: the artifact dir
 * (`HERE`), where the flat node_modules + sibling `server.js` live.
 */
export function resolveApiCwd(): string {
  const sourceCwd = path.resolve(HERE, '../../api');
  if (fs.existsSync(path.join(sourceCwd, 'src', 'server.ts'))) return sourceCwd; // dev
  return HERE; // packaged: dist dir (flat node_modules sibling)
}

/** Resolve the api port from VGIT_PORT (falls back to the default). */
export function resolveApiPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VGIT_PORT?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_VGIT_PORT;
}

/** The loopback base URL the api is reachable at locally. */
export function resolveApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `http://${LOCAL_BIND_HOST}:${resolveApiPort(env)}`;
}

/** Extra env the launcher injects into the spawned api child. */
export interface ApiChildEnvOverrides {
  /**
   * The local data-path JWT secret the launcher MINTS the pairing JWT with.
   * It MUST be passed to the api child so the api validates the
   * launcher-minted JWT with the SAME secret (`@vgit2/shared/jwt` reads
   * `JWT_SECRET` from the env at startup).
   */
  jwtSecret?: string;
  /** The resolved stable pcId — exposed to the api as `PORTABLE_PC_ID`. */
  pcId?: string;
  /** The hosted-relay base URL (self-host) — exposed as `PORTABLE_RELAY_URL`. */
  relayBaseUrl?: string;
  /**
   * Debug mode (`portable start --debug`) — forwarded to the api child as
   * `PORTABLE_DEBUG=1` so the api emits the extra per-connection logs (e.g. the
   * Socket.IO "User connected" line) that the launcher streams to the terminal.
   * Off by default; the api logs nothing extra unless this is set.
   */
  debug?: boolean;
  /**
   * The local Chromium executable resolved/installed by the Chromium provisioner
   * (`ensureChromium`). Forwarded to the api child as
   * `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` so the REQUIRED Playwright MCP gate
   * (`McpService` → `checkMcpRequirements('playwright')`) passes and the MCP
   * launches a real browser.
   */
  chromiumExecutablePath?: string;
  /**
   * The operator's `WORKSPACE_DIR`, resolved by the launcher from
   * its shell env or the monorepo-root `.env` ({@link resolveOperatorWorkspaceDir}).
   * Forwarded to the api child as `WORKSPACE_DIR` so portable operates on the repos
   * the user already has cloned. Undefined when unset everywhere → the api keeps its
   * own default (`~/claude-workspace`). The raw value is forwarded verbatim; tilde
   * expansion happens on the child side in `@vgit2/shared/constants` (`expandTilde`).
   */
  workspaceDir?: string;
}

/**
 * Absolute path to the monorepo-root `.env` (two levels above `packages/launcher`).
 * The default source {@link resolveOperatorWorkspaceDir} reads when `WORKSPACE_DIR`
 * is not already exported in the launcher's shell env.
 */
export function defaultRootEnvPath(): string {
  // packages/launcher/src -> monorepo root
  return path.resolve(HERE, '../../../.env');
}

/**
 * Resolve the operator's `WORKSPACE_DIR` for forwarding to the api child.
 * A shell-exported `WORKSPACE_DIR` wins (standard precedence); otherwise the
 * monorepo-root `.env` is read DIRECTLY here, because of two independent gaps that
 * otherwise drop the value silently:
 *   - the launcher runs with `cwd=packages/launcher` and loads no `.env` of its own
 *     (so a root `.env` never reaches the launcher process), and
 *   - the api child cannot pick it up either: {@link buildApiChildEnv} always sets
 *     `VGIT_PORT`, which flips `BUN_LOADED_ENV_FILE` true in the child, so
 *     `@vgit2/shared/constants` SKIPS parsing the root `.env`.
 * So this targeted read is the ONLY path by which an operator's `.env` `WORKSPACE_DIR`
 * reaches the api child (forwarded via {@link ApiChildEnvOverrides.workspaceDir}).
 * Returns `undefined` when unset everywhere (the api keeps its own default). The raw
 * value is returned verbatim — tilde expansion is done on the child side.
 */
export function resolveOperatorWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  rootEnvPath: string = defaultRootEnvPath()
): string | undefined {
  const fromEnv = env.WORKSPACE_DIR?.trim();
  if (fromEnv) return fromEnv;
  try {
    const parsed = dotenv.parse(fs.readFileSync(rootEnvPath));
    const fromFile = parsed.WORKSPACE_DIR?.trim();
    return fromFile && fromFile.length > 0 ? fromFile : undefined;
  } catch {
    // No root .env (or unreadable) — fall back to the api's own default.
    return undefined;
  }
}

/**
 * Load the operator's `.env` into `process.env` so EVERY launcher knob — `PORTABLE_PC_ID`,
 * `PORTABLE_REVIEWER_PUBLISH`, `PORTABLE_RELAY_URL`, `WORKSPACE_DIR`, and the Anthropic/GitHub
 * credential vars — works from a `.env` file, not just an EXPORTED shell var. The launcher runs
 * with `cwd=packages/launcher` and otherwise loads no `.env` of its own, so before this only the
 * targeted {@link resolveOperatorWorkspaceDir} read surfaced `WORKSPACE_DIR` — every other var in
 * an operator's `.env` was silently ignored (the "`applePC` in .env got a generated pcId" surprise).
 *
 * Best-effort + **`override:false` semantics** (an already-exported var ALWAYS wins), never throws.
 * Two candidate locations, in order (first definition of a key wins, exports beat both):
 *   - `<cwd>/.env`             — the dir the operator ran `portable` from (global-install case);
 *   - the monorepo-root `.env` — {@link defaultRootEnvPath} (dev-from-source, where cwd is the
 *     launcher package). On an EC2 run-from-source both resolve to the same repo-root file.
 */
export function loadOperatorEnv(
  env: NodeJS.ProcessEnv = process.env,
  paths: string[] = [path.join(process.cwd(), '.env'), defaultRootEnvPath()],
  readFileImpl: (p: string) => Buffer | string = (p) => fs.readFileSync(p)
): void {
  for (const p of paths) {
    try {
      const parsed = dotenv.parse(readFileImpl(p));
      for (const [key, value] of Object.entries(parsed)) {
        // No-override: an explicit shell export (or an earlier candidate file) wins.
        if (env[key] === undefined) env[key] = value;
      }
    } catch {
      // No `.env` at this path (or unreadable) — skip it.
    }
  }
}

/**
 * Build the env for the spawned api child. The runtime is always local-first, so
 * we only pin the bind host to loopback; we also strip DEV_BACKEND_PORT so the api
 * listens on VGIT_PORT directly (no Vite-proxy split — the launcher serves
 * API + Socket.IO only, no web bundle).
 *
 * The launcher OWNS the JWT identity (Clerk is gone from the PC). It
 * mints the pairing JWT with a local `JWT_SECRET` and passes that
 * SAME secret to the api child so the api's `verifyAuthToken`
 * (`@vgit2/shared/jwt`, reads `JWT_SECRET` at startup) accepts the token. The
 * resolved `pcId` (`PORTABLE_PC_ID`) and relay base (`PORTABLE_RELAY_URL`) are
 * forwarded too so the api shares the launcher's routing identity.
 */
export function buildApiChildEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: ApiChildEnvOverrides = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  env.API_BIND_HOST = LOCAL_BIND_HOST;
  env.VGIT_PORT = String(resolveApiPort(base));
  // The api uses DEV_BACKEND_PORT (= VGIT_PORT - 1) only for the Vite dev split.
  // The launcher runs the api alone, so it must listen on VGIT_PORT itself.
  delete env.DEV_BACKEND_PORT;

  // Share the launcher's data-path identity with the api child.
  if (overrides.jwtSecret) {
    env.JWT_SECRET = overrides.jwtSecret;
  }
  if (overrides.pcId) {
    env.PORTABLE_PC_ID = overrides.pcId;
  }
  if (overrides.relayBaseUrl) {
    env.PORTABLE_RELAY_URL = overrides.relayBaseUrl;
  }
  // --debug: let the api emit its extra per-connection diagnostics (off by default).
  if (overrides.debug) {
    env.PORTABLE_DEBUG = '1';
  }
  // Local Chromium for the Playwright MCP (the api reads
  // PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH at module load). Conditional-set so an
  // empty resolution leaves any inherited value from `{ ...base }` untouched.
  if (overrides.chromiumExecutablePath) {
    env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = overrides.chromiumExecutablePath;
  }
  // Forward the operator's WORKSPACE_DIR (resolved by the launcher from
  // its shell env or the root .env — see resolveOperatorWorkspaceDir) so the api
  // child operates on the repos the user already has on disk. Conditional-set so an
  // unresolved value leaves any inherited base value intact.
  if (overrides.workspaceDir) {
    env.WORKSPACE_DIR = overrides.workspaceDir;
  }
  return env;
}
