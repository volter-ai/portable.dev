import fsSync from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

import { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, getUserWorkspaceDir } from '@vgit2/shared/constants';

import { NpxCommandDetector } from './NpxCommandDetector.js';

const require = createRequire(import.meta.url);

/**
 * PlaywrightMcpConfig
 *
 * Handles Playwright MCP server configuration (local Chromium).
 */
export class PlaywrightMcpConfig {
  constructor(
    private npxDetector: NpxCommandDetector,
    private enablePlaywright: boolean = true
  ) {}

  /**
   * Known paths where @playwright/mcp/cli.js may be installed.
   * Checked in order before falling back to require.resolve() or npx.
   */
  private static readonly KNOWN_MCP_PATHS = [
    '/app/packages/api/node_modules/@playwright/mcp/cli.js',
    '/app/node_modules/@playwright/mcp/cli.js',
  ];

  /**
   * Get the appropriate command and args for Playwright MCP server
   * Checks known paths first (reliable in containers), then require.resolve(), then npx fallback
   * FAIL FAST: Throws error if configuration fails, crashing the server
   */
  public getPlaywrightCommand(): { command: string; args: string[] } {
    // Resolve @playwright/mcp's cli.js to a concrete file path and run it with
    // `node <path>` — the only cross-platform-reliable command (npx is the LAST
    // resort: on Windows the npx shim is `npx.cmd`, which the SDK/CLI can't spawn
    // directly, so the MCP just fails — the exact bug we hit on Windows).
    const cliPath = this.resolvePlaywrightMcpCli();
    if (cliPath) {
      console.log(`[PlaywrightMcpConfig] Found @playwright/mcp cli.js: ${cliPath}`);
      return { command: 'node', args: [cliPath] };
    }

    // Last resort: npx. Verify it first (Windows-aware detector). Prefer a real
    // install — npx will fail on Windows if the shim can't be spawned.
    this.npxDetector.verifyNpxAvailable();
    console.warn('[PlaywrightMcpConfig] Falling back to npx for @playwright/mcp');
    return {
      command: this.npxDetector.getCommand(),
      args: ['-y', '@playwright/mcp'],
    };
  }

  /**
   * Resolve `@playwright/mcp/cli.js` to an existing file path, robust to Bun's
   * hoisted `.bun` store and Windows. The package's `exports` map does NOT export
   * `./cli.js`, so `require.resolve('@playwright/mcp/cli.js')` throws
   * `ERR_PACKAGE_PATH_NOT_EXPORTED` — we therefore (1) try `require.resolve` of
   * an EXPORTED specifier (`package.json` / the main entry) and derive the cli.js
   * sibling, then (2) probe computed `node_modules/@playwright/mcp/cli.js` paths
   * relative to this file and the cwd, then (3) the legacy container paths.
   * Returns the first existing path, or `null` to trigger the npx fallback.
   */
  private resolvePlaywrightMcpCli(): string | null {
    const candidates: string[] = [];

    // (1) PREFER the WORKSPACE-installed package (the declared `^0.0.54` dep,
    //     version-locked with the workspace's `playwright` browser lib). Under
    //     Bun, `require.resolve` (below) returns a GLOBAL-cache copy that can be a
    //     DIFFERENT @playwright/mcp version → a `playwright` version mismatch
    //     ("Executable doesn't exist"). So the computed workspace paths come first.
    const here = path.dirname(fileURLToPath(import.meta.url)); // …/services/mcp/config
    candidates.push(
      path.resolve(here, '../../../../node_modules/@playwright/mcp/cli.js'), // packages/api/node_modules
      path.resolve(process.cwd(), 'node_modules/@playwright/mcp/cli.js'),
      path.resolve(process.cwd(), 'packages/api/node_modules/@playwright/mcp/cli.js')
    );

    // (2) require.resolve an EXPORTED specifier → derive cli.js sibling (the
    //     package's `exports` map blocks `./cli.js` directly, but allows the main
    //     entry / package.json). Fallback only — may be a global-cache version.
    for (const spec of ['@playwright/mcp/package.json', '@playwright/mcp']) {
      try {
        const resolved = require.resolve(spec);
        candidates.push(path.join(path.dirname(resolved), 'cli.js'));
      } catch {
        // not resolvable via this specifier — try the next strategy
      }
    }

    // (3) legacy container paths (`/app`).
    candidates.push(...PlaywrightMcpConfig.KNOWN_MCP_PATHS);

    for (const candidate of candidates) {
      try {
        if (candidate && fsSync.existsSync(candidate)) return candidate;
      } catch {
        // ignore a bad candidate and keep probing
      }
    }
    return null;
  }

  /**
   * Build Playwright MCP configuration (local Chromium)
   */
  public async buildPlaywrightConfig(params: {
    userId: string;
    chatId: string;
    repoPath: string;
    playwrightDevice: 'mobile' | 'desktop';
  }): Promise<{
    config: any;
    tunnelMappings: Array<{ port: number; url: string }>;
  }> {
    const { userId, playwrightDevice } = params;

    if (!this.enablePlaywright) {
      return { config: {}, tunnelMappings: [] };
    }

    // Ensure test-results output directory exists
    const userWorkspace = getUserWorkspaceDir(userId);
    const outputDir = path.join(userWorkspace, 'test-results');
    if (!fsSync.existsSync(outputDir)) {
      fsSync.mkdirSync(outputDir, { recursive: true });
      console.log(`[PlaywrightMcpConfig] Created output dir: ${outputDir}`);
    }

    let playwrightConfig: any = {};
    const tunnelMappings: Array<{ port: number; url: string }> = [];

    const { command, args } = this.getPlaywrightCommand();

    // Point @playwright/mcp at a concrete Chromium via its supported
    // `--executable-path` flag. NOTE: @playwright/mcp does NOT read the
    // PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH env var (only Playwright's default
    // browser-cache discovery or `--executable-path`), so the old env injection
    // was a no-op. The launcher (`portable start`) installs Chromium and exports
    // PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH; we only pass `--executable-path` when
    // the binary actually exists, otherwise we let @playwright/mcp auto-discover
    // from the standard ms-playwright cache.
    const chromiumExecutablePath = this.resolveChromiumExecutablePath();

    playwrightConfig = {
      playwright: {
        command,
        args: [
          ...args,
          // Device or viewport configuration
          ...(playwrightDevice === 'mobile'
            ? ['--device', 'iPhone 15']
            : ['--viewport-size', '1280x720']),
          '--image-responses',
          'omit',
          // Video recording with resolution
          ...(playwrightDevice === 'mobile' ? ['--save-video=390x844'] : ['--save-video=1280x720']),
          '--output-dir',
          outputDir,
          // `--no-sandbox` is the only sandbox-relaxation flag @playwright/mcp
          // accepts. The previous `--disable-dev-shm-usage` / `--disable-setuid-sandbox`
          // / `--disable-gpu` were raw Chromium flags (legacy container leftovers) that
          // @playwright/mcp rejects ("error: unknown option") — they crashed the
          // MCP child on launch, so they were removed.
          '--no-sandbox',
          ...(chromiumExecutablePath ? ['--executable-path', chromiumExecutablePath] : []),
        ],
        env: {
          // Browsers are pre-installed by the launcher (or `bun run dev`); never
          // let the MCP child download one at launch time.
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
          DEBUG: 'pw:api',
        },
      },
    };

    return { config: playwrightConfig, tunnelMappings };
  }

  /**
   * Resolve a concrete Chromium executable for local mode, or `undefined` to let
   * @playwright/mcp auto-discover from the standard ms-playwright cache.
   *
   * Priority:
   *   1. PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH (set by the launcher's Chromium
   *      provisioner, or by the user) — only if the file actually exists.
   *   2. The Playwright-managed Chromium for the installed Playwright version
   *      (`require('playwright').chromium.executablePath()`) — only if it exists
   *      (executablePath() returns a path even when the browser isn't installed).
   */
  private resolveChromiumExecutablePath(): string | undefined {
    if (
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH &&
      fsSync.existsSync(PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
    ) {
      return PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    }

    try {
      // Lazy require so a missing/optional Playwright dep never breaks config build.
      const { chromium } = require('playwright');
      const resolved: string | undefined = chromium?.executablePath?.();
      if (resolved && fsSync.existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // Playwright not resolvable here — fall through to auto-discovery.
    }

    return undefined;
  }
}
