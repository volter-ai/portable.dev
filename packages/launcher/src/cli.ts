#!/usr/bin/env bun
/**
 * `portable` CLI.
 *
 * Usage:
 *   portable start            start the local-first runtime (api + tunnel + pairing QR)
 *   portable start --debug    same, but ALSO stream the api logs to this terminal
 *   portable start --dev      same, but register against the staging relay
 *                             (app.portable-dev.com) instead of production
 *   portable help             show this help
 *   portable --version        print the installed CLI version and exit
 *
 * Run via `bun run portable` (root) or `bun --cwd packages/launcher start`.
 *
 * Clerk is GONE from the PC — the launcher mints the data-path JWT itself and
 * shows the pairing QR in the terminal (Ink). The api child's ongoing stdout is
 * routed to a launcher LOG FILE (not the Ink-owned terminal) so they never
 * interleave. With `--debug` the api logs are ALSO teed to this terminal (so you
 * can watch connections arrive); the live Ink QR is then replaced with a one-shot
 * static QR print so the streamed logs don't fight Ink for the terminal.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveDataDir } from '@vgit2/shared/secrets';

import { DEV_RELAY_BASE_URL, loadOperatorEnv, resolveCliVersion } from './config.js';
import { createLauncher } from './Launcher.js';
import { autoLinkIfEligible, runLinkCommand, runUnlinkCommand } from './ProjectCommands.js';
import { acquireSingleton } from './SingletonGuard.js';

const HELP = `portable — local-first launcher / tunnel-router

Usage:
  portable            Link the current project (if it's a git repo under your home
  portable connect    dir) and start the local runtime: find your Anthropic + GitHub
                     credentials already on this machine (and, if missing, log you
                     in right here in the terminal), spawn the api on
                     127.0.0.1:VGIT_PORT (API + Socket.IO only), bring up the
                     cloudflared tunnel, mint the data-path JWT, and show the
                     pairing QR (or the connected menu). Runs until Ctrl-C.
                     (\`portable start\` is a back-compat alias.)
  portable link      Register the CURRENT directory as a Portable project so it
                     shows up in the app (a git repo is required). Refuses system
                     dirs; warns + confirms before linking your home directory.
  portable unlink    Remove the current directory from your Portable projects.
  portable help      Show this help.
  portable --version Print the installed CLI version and exit (also -v / \`portable version\`).

Auto-link: just typing \`portable\` in a project folder links it for you — but ONLY
when that folder is a git repo INSIDE your home directory (never your home dir
itself, never \`/\` or \`C:\\WINDOWS\\System32\`). Use \`portable link\` to link a
project elsewhere, or \`portable unlink\` to drop one.

Single instance: running \`portable\` (connect/start) while one is already running
TAKES OVER — it stops the existing instance and boots fresh, no matter which
directory you launch from. So a second window is just a full restart.

Flags:
  --debug, -d        Stream the api logs to this terminal (they're always saved
                     to the log file too) so you can watch connections arrive.
                     The pairing QR is printed once instead of the live screen,
                     so the scrolling logs don't redraw over it.
  --dev              Register against the STAGING relay (${DEV_RELAY_BASE_URL})
                     instead of the production default. Ignored if
                     PORTABLE_RELAY_URL is already set (env / .env always wins).

Credentials (auto-discovered, else login):
  On start the launcher LOOKS for credentials already on your OS and uses them:
    - Anthropic: ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN env → the local
      store → ~/.claude/.credentials.json → the macOS Keychain.
    - GitHub:    GITHUB_TOKEN / GH_TOKEN env → the local store → \`gh auth token\`
      → ~/.config/gh/hosts.yml → the git credential helper.
  If no Anthropic credential is found and the \`claude\` CLI is installed, it runs
  \`claude setup-token\` for you (else it prints guidance — AI needs one, but boot
  is never blocked). If GitHub is missing it OFFERS the OAuth device flow
  (needs GITHUB_OAUTH_CLIENT_ID); GitHub is optional — you can connect it later
  from the Portable app.

Prerequisites:
  - Bun (https://bun.sh)
  - cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  - For AI: a Claude subscription (the \`claude\` CLI) OR ANTHROPIC_API_KEY.

No Clerk sign-in is needed on the PC: the launcher mints the pairing JWT locally
with a per-install JWT_SECRET and the PC validates it itself. Scan the QR shown in
the terminal (or open the printed http://localhost:<port>/ page) from the app.

Platforms: macOS, Linux, and Windows. On Windows cloudflared is often installed
(winget/MSI) without being added to PATH — the launcher probes the default install
dirs automatically; set PORTABLE_CLOUDFLARED_BIN if yours lives elsewhere.
`;

/**
 * Open a launcher log file under the local data dir and return a line sink for
 * the api child's stdout. The api logs are ALWAYS saved to the file (so they
 * don't fight the Ink-owned terminal); when `debug` is set they are ALSO teed to
 * this terminal so the user can watch connections arrive. Falls back to a no-op
 * file sink on any FS error (never block boot on logging) — the terminal tee
 * still works in debug mode even if the file can't be opened.
 */
function openApiLogSink(opts: { debug: boolean }): (line: string) => void {
  let fileSink: (line: string) => void = () => {};
  try {
    const logDir = path.join(resolveDataDir(), 'logs');
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(logDir, `api-${stamp}.log`);
    const stream = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
    process.stdout.write(
      `[launcher] api logs → ${logPath}${opts.debug ? ' (also streaming below)' : ''}${os.EOL}`
    );
    fileSink = (line: string) => {
      stream.write(`${line}${os.EOL}`);
    };
  } catch {
    // Logging is best-effort — never block boot. Fall back to dropping api lines.
  }
  if (!opts.debug) return fileSink;
  // --debug: tee every api line to the terminal too (the static QR print leaves
  // room for these to scroll below it).
  return (line: string) => {
    fileSink(line);
    process.stdout.write(`${line}${os.EOL}`);
  };
}

/** Read `--bridge <path>` from argv (the launcher embeds the absolute bridge path). */
function readBridgeFlag(args: string[]): string | undefined {
  const i = args.indexOf('--bridge');
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // The command is the first non-flag positional (default 'connect'), so
  // `portable --debug`, `portable connect --debug`, and bare `portable` all work.
  const command = args.find((a) => !a.startsWith('-')) ?? 'connect';

  // ── claude-spawned subcommands: dispatch BEFORE loadOperatorEnv ─────────────
  // These run inside the user's OWN `claude` sessions (with the PROJECT cwd), so
  // loading the project `.env` here is both pointless and a footgun (a project
  // DATA_DIR would redirect where they look for the bridge). They read the
  // launcher-embedded absolute `--bridge` path from argv, not the env (B2).
  //
  // `portable hook-relay` (rev12 D53) — the lifecycle-hook relay. Silent (NEVER
  // stdout — SessionStart hook stdout is injected into the model context), exits
  // 0 fast, before any launcher banner/singleton/link logic.
  if (command === 'hook-relay') {
    const { runHookRelay } = await import('./HookRelay.js');
    await runHookRelay({ bridgePath: readBridgeFlag(args) });
    return;
  }

  // `portable mcp-sidecar` (rev12 D58) — the zero-tool MCP sidecar, spawned by
  // every terminal `claude` session. stdout is OWNED by the MCP stdio protocol —
  // no banner, no logs; runs until the parent CLI closes stdin.
  if (command === 'mcp-sidecar') {
    const { runMcpSidecar } = await import('./McpSidecar.js');
    await runMcpSidecar({ bridgePath: readBridgeFlag(args) });
    return;
  }

  // Load the operator's `.env` into process.env FIRST so every launcher knob
  // (PORTABLE_PC_ID / PORTABLE_REVIEWER_PUBLISH / PORTABLE_RELAY_URL / WORKSPACE_DIR /
  // ANTHROPIC_API_KEY / GITHUB_TOKEN …) works from a `.env` file, not just an exported
  // shell var. Best-effort, never overrides an already-exported var, never throws.
  loadOperatorEnv();

  const wantsHelp = args.includes('help') || args.includes('--help') || args.includes('-h');
  const wantsVersion = args.includes('--version') || args.includes('-v') || command === 'version';
  const debug = args.includes('--debug') || args.includes('-d');
  const wantsDev = args.includes('--dev');

  if (wantsHelp) {
    process.stdout.write(HELP);
    return;
  }

  // `portable --version` / `-v` / `portable version`: print-and-exit, no runtime.
  if (wantsVersion) {
    process.stdout.write(`portable ${resolveCliVersion()}\n`);
    return;
  }

  // `--dev`: point the registration agent at the staging relay instead of the
  // production default. An already-set PORTABLE_RELAY_URL (shell export or
  // operator .env, both loaded by loadOperatorEnv above) always wins — this is
  // just a shorthand default-switcher, not a hard override.
  if (wantsDev && !process.env.PORTABLE_RELAY_URL) {
    process.env.PORTABLE_RELAY_URL = DEV_RELAY_BASE_URL;
  }

  // Project-management subcommands: act on the cwd, print, and exit (no runtime).
  if (command === 'link') {
    await runLinkCommand();
    return;
  }
  if (command === 'unlink') {
    await runUnlinkCommand();
    return;
  }

  // `connect` (default) + the `start` back-compat alias both start the runtime.
  if (command !== 'connect' && command !== 'start') {
    process.stderr.write(`portable: unknown command '${command}'\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  // Single-instance takeover: if another `portable` is already running on the api
  // port, stop it (its launcher + api child + cloudflared) and take over — so
  // typing `portable` in a second window is a full restart, regardless of cwd.
  // Best-effort: never blocks boot (a failure degrades to the api's own
  // EADDRINUSE). Released on shutdown so the lock doesn't outlive us.
  const singleton = await acquireSingleton();
  const releaseSingleton = () => singleton.release();
  process.once('exit', releaseSingleton);

  // Auto-link the current project (silent; only a git repo under home, not home
  // itself). Runs BEFORE the api spawns so it's discovered on this very boot.
  autoLinkIfEligible();

  let launcher;
  try {
    launcher = await createLauncher({ apiLog: openApiLogSink({ debug }), debug });
  } catch (err) {
    // createLauncher can hard-fail before anything starts — e.g. Chromium could
    // not be provisioned for the REQUIRED Playwright MCP (CHROMIUM_INSTALL_HINT).
    // Nothing has spawned yet, so there's nothing to tear down.
    console.error(`[launcher] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  try {
    await launcher.runUntilSignal();
  } catch (err) {
    console.error(`[launcher] fatal: ${err instanceof Error ? err.message : String(err)}`);
    // Best-effort teardown so a half-started api child isn't orphaned.
    await launcher.shutdown().catch(() => {});
    process.exitCode = 1;
  }
}

void main();
