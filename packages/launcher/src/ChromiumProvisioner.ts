import { execFileSync } from 'child_process';
import { existsSync as realExistsSync } from 'fs';
import path from 'path';

import { resolveApiCwd } from './config.js';

/**
 * Chromium provisioner (local-first Playwright fix).
 *
 * Playwright (browser automation) is a REQUIRED MCP for the chat, so the PC must
 * have a local Chromium. The api's required-MCP gate
 * (`McpService.buildAllMcpServers` → `checkMcpRequirements('playwright')`) only
 * passes when `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is set, AND @playwright/mcp
 * needs a real browser to launch.
 *
 * `ensureChromium` runs at `portable start` (wired in `createLauncher`, BEFORE
 * the api child is spawned, so the resolved path is baked into the child env via
 * `buildApiChildEnv`). It:
 *   1. Honors a valid `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if already set (user override).
 *   2. Resolves the Chromium executable the api's installed Playwright expects.
 *   3. Installs it once (`playwright install chromium`) if missing — idempotent;
 *      Playwright's own ms-playwright cache persists it across restarts, so this
 *      is a near-instant no-op on every boot after the first.
 *   4. HARD-FAILS (throws {@link CHROMIUM_INSTALL_HINT}) if it cannot end with a
 *      real browser — Playwright is mandatory, so the launcher surfaces a clear
 *      install hint rather than booting into a runtime whose chat can't start.
 *
 * Fully DI'd (every effect is an injectable seam) so launcher tests never run a
 * real `playwright install` or touch the real fs. `config.ts` (and therefore
 * this module) imports nothing from `@vgit2/shared`, keeping the spawn/health
 * path shared-free (see launcher CLAUDE.md gotcha).
 */

/** Clear, actionable hint shown when Chromium can't be provisioned. */
export const CHROMIUM_INSTALL_HINT = [
  'Playwright Chromium could not be installed.',
  '',
  'Portable uses Playwright (browser automation) in the chat, and it needs a',
  'local Chromium. Install it manually, then re-run `portable start`:',
  '',
  '  cd packages/api && bunx playwright install chromium',
  '',
  'On Linux you may also need the system libraries (uses sudo/apt):',
  '  cd packages/api && bunx playwright install-deps chromium',
  '',
  'Alternatively, point PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH at an existing',
  'Chromium/Chrome binary.',
].join('\n');

export type ExistsImpl = (p: string) => boolean;
/** Resolve the Chromium executable path the api's Playwright expects. */
export type ResolveExecutablePathImpl = () => string;
/** Run `playwright install chromium` (real impl streams progress to the terminal). */
export type InstallChromiumImpl = () => void;

export interface EnsureChromiumDeps {
  /** Base env (read `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`). */
  env?: NodeJS.ProcessEnv;
  /** The api package dir (cwd for resolving + installing Playwright). */
  apiCwd?: string;
  /** Boot log sink. Defaults to console.log. */
  log?: (line: string) => void;
  /** fs.existsSync seam (injected in tests). */
  existsImpl?: ExistsImpl;
  /** Resolve the expected executable path (injected in tests). */
  resolveExecutablePath?: ResolveExecutablePathImpl;
  /** Run the one-time install (injected in tests). */
  installChromium?: InstallChromiumImpl;
}

export interface EnsureChromiumResult {
  /**
   * The resolved Chromium executable path. An empty string means "do not set
   * PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH on the child".
   */
  executablePath: string;
  /** True if an install was actually run during this call. */
  installed: boolean;
  /** Always false (kept for back-compat); provisioning is unconditional. */
  skipped: boolean;
}

/** node/bun `-e` snippet that prints the api Playwright's Chromium executable path. */
const PLAYWRIGHT_PATH_EVAL =
  "process.stdout.write(require('playwright').chromium.executablePath())";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve Playwright's `cli.js` in a layout-agnostic way. `bun/npm install -g` HOIST
 * dependencies to a shared `node_modules`, so the old hardcoded
 * `<apiCwd>/node_modules/playwright/cli.js` (a NESTED layout) is "module not found" in a
 * global install — the drop-in install blocker. Resolve `playwright/package.json` via
 * Node module resolution FROM apiCwd (which walks up to the hoisted location), then take
 * its sibling `cli.js`. Falls back to the nested path for an unusual/dev layout.
 */
function resolvePlaywrightCli(apiCwd: string, existsImpl: ExistsImpl): string {
  try {
    const pkgJson = execFileSync(
      process.execPath,
      ['-e', "process.stdout.write(require.resolve('playwright/package.json'))"],
      { cwd: apiCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
    if (pkgJson) {
      const cli = path.join(path.dirname(pkgJson), 'cli.js');
      if (existsImpl(cli)) return cli;
    }
  } catch {
    // fall through to the nested-layout fallback (dev / non-hoisted)
  }
  return path.join(apiCwd, 'node_modules', 'playwright', 'cli.js');
}

/**
 * Ensure a local Chromium is available for the Playwright MCP and return its
 * executable path (to be forwarded to the api child as
 * `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`). Throws {@link CHROMIUM_INSTALL_HINT}
 * on failure (hard-fail — Playwright is required).
 */
export function ensureChromium(deps: EnsureChromiumDeps = {}): EnsureChromiumResult {
  const env = deps.env ?? process.env;
  const apiCwd = deps.apiCwd ?? resolveApiCwd();
  const log = deps.log ?? ((line: string) => console.log(line));
  const existsImpl = deps.existsImpl ?? realExistsSync;

  const resolveExecutablePath =
    deps.resolveExecutablePath ??
    (() =>
      execFileSync(process.execPath, ['-e', PLAYWRIGHT_PATH_EVAL], {
        cwd: apiCwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim());

  const installChromium =
    deps.installChromium ??
    (() => {
      const cli = resolvePlaywrightCli(apiCwd, existsImpl);
      execFileSync(process.execPath, [cli, 'install', 'chromium'], {
        cwd: apiCwd,
        stdio: 'inherit',
      });
    });

  // 1. Honor an explicit, existing user override.
  const override = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (override && existsImpl(override)) {
    log(`[launcher] ✓ Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH): ${override}`);
    return { executablePath: override, installed: false, skipped: false };
  }

  // 3. Resolve the path the api's Playwright version expects.
  let executablePath: string;
  try {
    executablePath = resolveExecutablePath();
  } catch (err) {
    throw new Error(
      `${CHROMIUM_INSTALL_HINT}\n\n(could not resolve the Playwright Chromium path: ${errMessage(err)})`
    );
  }
  if (!executablePath) {
    throw new Error(`${CHROMIUM_INSTALL_HINT}\n\n(Playwright returned an empty Chromium path)`);
  }

  // 4. Already installed → fast no-op (the common case after first boot).
  if (existsImpl(executablePath)) {
    log(`[launcher] ✓ Chromium present: ${executablePath}`);
    return { executablePath, installed: false, skipped: false };
  }

  // 5. Install once. Hard-fail on error (Playwright is required).
  log('[launcher] Installing Chromium for Playwright browser automation (one-time, ~150MB)…');
  try {
    installChromium();
  } catch (err) {
    throw new Error(
      `${CHROMIUM_INSTALL_HINT}\n\n(\`playwright install chromium\` failed: ${errMessage(err)})`
    );
  }

  // 6. Re-resolve + verify the browser is now present.
  try {
    executablePath = resolveExecutablePath();
  } catch {
    // Keep the pre-install path for the existence check / error message.
  }
  if (!executablePath || !existsImpl(executablePath)) {
    throw new Error(
      `${CHROMIUM_INSTALL_HINT}\n\n(Chromium still not found after install: ${executablePath || '(empty path)'})`
    );
  }

  log(`[launcher] ✓ Chromium installed: ${executablePath}`);
  return { executablePath, installed: true, skipped: false };
}
