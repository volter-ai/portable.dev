# @vgit2/launcher — the `portable` CLI (local-first launcher / tunnel-router)

One command runs the local-first PC runtime: it finds your Anthropic + GitHub
credentials (or logs you in right in the terminal), spawns the api on loopback,
opens a Cloudflare tunnel, mints the data-path JWT itself, and shows a **pairing
QR** you scan from the Portable mobile app. No cloud login on the PC — the launcher
owns a per-install `JWT_SECRET` and the api validates the token locally (rev6).

```bash
# From a source checkout (dev):
bun run portable            # repo root  (alias: bun run cli)
bun --cwd packages/launcher start

# Installed globally (see Distribution below):
portable
```

## Commands

| Command            | What it does                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `portable`         | Default. **Auto-links** the current dir (only if it's a git repo inside your home dir), then starts the runtime and shows the pairing QR (or the connected menu). Runs until Ctrl-C. |
| `portable connect` | Same as bare `portable` (the canonical name for "start the runtime").                                                                                                                |
| `portable start`   | Back-compat alias for `connect`.                                                                                                                                                     |
| `portable link`    | Register the **current directory** as a Portable project so it shows up in the app (a git repo is required). Refuses system dirs; warns + confirms before linking your home dir.     |
| `portable unlink`  | Remove the current directory from your Portable projects.                                                                                                                            |
| `portable help`    | Show help (`--help` / `-h` also work).                                                                                                                                               |

**`link` / `unlink` need no restart.** They mutate the filesystem (the workspace
junction + `repo-views.json`) and then fire a best-effort loopback
`POST /api/repos/rescan` to a RUNNING `portable`, which drops its in-memory repo
caches so the change shows up immediately. If `portable` isn't running it falls
back to a "restart to apply" hint.

### Flags

| Flag            | Effect                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--debug`, `-d` | Stream the api logs to this terminal (they're always saved to the log file too) so you can watch connections arrive. The QR is printed **once** (static) instead of the live Ink screen, so the scrolling logs don't redraw over it. |

The command is the first non-flag argument, so `portable --debug`,
`portable connect --debug`, and `portable start --debug` are all equivalent.

## Single instance (takeover)

The launcher pins the api to `127.0.0.1:VGIT_PORT` and registers **one** `pcId`
with the relay, so two runtimes can't coexist. Running `portable` (connect/start)
while another is already up **takes over**: it stops the existing instance — its
launcher, the api child, and cloudflared — waits for the port to free, then boots
fresh. **A second window is just a full restart, regardless of which directory you
launch from.**

Detection is on the `GET /api/health` probe (a portable runtime always answers it),
so it's robust against a stale lock file (`<DATA_DIR>/launcher.lock`) left by a
crash and against PID recycling — it only stops what's actually serving the port.
See `SingletonGuard.ts`.

## Credentials (auto-discovered, else login)

On start the launcher LOOKS for credentials already on your OS and uses them; only
if they're missing does it log you in — all in the plain terminal, before the api
spawns:

- **Anthropic** — `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` env → the local
  secret store → `~/.claude/.credentials.json` → the macOS Keychain. If none is
  found and the `claude` CLI is installed, it runs `claude setup-token`; otherwise
  it prints guidance (AI needs a credential, but boot is never blocked).
- **GitHub** — `GITHUB_TOKEN` / `GH_TOKEN` env → the local store → `gh auth token`
  → `~/.config/gh/hosts.yml` → the git credential helper. If missing it OFFERS the
  OAuth **device flow** (needs `GITHUB_OAUTH_CLIENT_ID`); GitHub is optional and can
  be connected later from the app.

Discovered/obtained credentials are written into the SAME secret-store keys + env
the api child reads, so the api picks them up with no extra wiring.

## Prerequisites

- **Bun** — <https://bun.sh> (runs the launcher + the api; this is a Bun monorepo).
- **cloudflared** — **auto-provisioned** on first start (the official static binary,
  downloaded once via the `cloudflared` npm package, cross-platform). You do NOT
  need to install it via winget/brew/apt. If you already have one, it's reused;
  override the binary with `PORTABLE_CLOUDFLARED_BIN`.
- **Chromium** — **auto-installed** (a Playwright Chromium for the REQUIRED browser
  MCP). On bare Debian/Ubuntu you may need a one-time
  `sudo playwright install-deps chromium` for system libraries (the launcher prints
  the hint).
- **For AI** — a Claude subscription (the `claude` CLI) OR `ANTHROPIC_API_KEY`.

**Platforms:** macOS, Linux, and Windows. On Windows cloudflared is often installed
(winget/MSI) without being added to PATH, so the launcher also probes the default
install dirs (`%ProgramFiles(x86)%\cloudflared`, the winget Links dir, scoop shims).

## Environment knobs

| Var                        | Purpose                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `VGIT_PORT`                | The loopback api port (default `4200`).                                                        |
| `PORTABLE_RELAY_URL`       | The hosted relay to register with (default `https://app.portable-dev.com`; self-host with D7). |
| `PORTABLE_PC_ID`           | Override the stable pcId (else persisted in the local store).                                  |
| `PORTABLE_PC_LABEL`        | Human label for this PC (default: hostname).                                                   |
| `PORTABLE_CLOUDFLARED_BIN` | Full path to a `cloudflared` binary to use instead of the auto-provisioned one.                |
| `WORKSPACE_DIR`            | The dir whose git repos Portable operates on (forwarded to the api child).                     |

## Modules

| File                                                                 | Responsibility                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `cli.ts`                                                             | CLI entry: parse command/flags, acquire the singleton, run `link`/`unlink` or the runtime.              |
| `SingletonGuard.ts`                                                  | Single-instance takeover (stop a running `portable`, then boot fresh).                                  |
| `Launcher.ts`                                                        | Orchestrator: creds → spawn api → health → mint JWT → tunnel → pairing QR → run → shutdown.             |
| `PairingIdentity.ts`                                                 | The local `JWT_SECRET` + stable identity; mints the data-path JWT carried in the QR.                    |
| `CredentialResolver.ts`                                              | Discover Anthropic + GitHub credentials already on the OS (priority ladders).                           |
| `InteractiveCredentialLogin.ts` / `prepareCredentials.ts`            | Login fallback (Claude `setup-token`, GitHub device flow) + the boot orchestrator over discovery+login. |
| `ApiProcess.ts`                                                      | Spawn + supervise the api child; `waitForHealth` poller.                                                |
| `ChromiumProvisioner.ts` / `CloudflaredProvisioner.ts`               | Auto-provision the Playwright Chromium + the cloudflared binary.                                        |
| `CloudflaredTunnel.ts` / `TunnelRouter.ts`                           | Spawn/supervise cloudflared; route each public URL to the registration agent.                           |
| `TunnelRegistrationAgent.ts`                                         | Register/heartbeat `pcId → tunnel URL` with the relay (pcId-keyed, no Clerk).                           |
| `TunnelHealthMonitor.ts`                                             | Self-heal: probe the public relay path and cycle cloudflared on a stale gateway mapping.                |
| `TerminalUi.ts` / `PairingServer.ts`                                 | The Ink pairing QR / connected menu + the loopback-only fallback pairing page.                          |
| `ProjectCommands.ts` / `ProjectLink.ts` / `NotifyRunningInstance.ts` | `link`/`unlink` + the no-restart rescan nudge.                                                          |
| `config.ts`                                                          | Port / path / child-env resolution for the spawned api.                                                 |

## Testing & smoke

```bash
cd packages/launcher && bun test    # unit tests — every effect is a mocked seam
bun run smoke:launcher              # real api spawn, asserts /api/health -> {status:'ok'}
```

Tests use injected seams (cloudflared, the relay, the loopback http server, Ink,
the api spawn, the singleton's process/fs/network effects are all faked) — no real
network, no real child process. The full one-command boot — terminal QR + a real
device scan-and-pair against a live relay — is the post-run live-smoke
(device-deferred).

## Distribution

The launcher ships as an installable CLI (`bun install -g`, no compiled binary —
Bun is the runtime). Build + install + troubleshooting:
[`docs/portable-distribution.md`](../../docs/portable-distribution.md). In short:
`bun run build:portable` bundles `cli.ts` + the api server into
`dist-portable/{cli.js,server.js}`, and `scripts/install-portable.{ps1,sh}` ensure
Bun + PATH and `bun install -g`.

> For the deeper architecture (DI seams, the gate ladder, rev6/rev9 invariants), see
> [`CLAUDE.md`](./CLAUDE.md).
