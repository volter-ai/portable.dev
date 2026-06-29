# CLAUDE.md — `@vgit2/launcher` (`portable` launcher / tunnel-router)

Rules for Claude Code in `packages/launcher`. **In addition** to the root
[`CLAUDE.md`](../../CLAUDE.md).

## What this package is

The **one-command launcher** for the local-first PC runtime (`portable start`).
It is also the **local tunnel-router**: it spawns the api on loopback, owns the
cloudflared lifecycle + the `pcId`-keyed registration agent, **mints the data-path
JWT itself**, and shows the **pairing QR** in the terminal.

The PC's identity is its **stable `pcId`** plus a **local `JWT_SECRET`**
(`launcher:jwt-secret` in the shared `LocalSecretStore`, generated + persisted on
first boot). The launcher mints the data-path JWT with `@vgit2/shared/jwt`
(`generateAuthToken`), and the api validates it locally (`verifyAuthToken`) with the
SAME secret — forwarded to the api child via `buildApiChildEnv` (`JWT_SECRET` +
`PORTABLE_PC_ID` + `PORTABLE_RELAY_URL`). The gateway never holds the secret or sees
the JWT; it only relays. Tunnel registration is **`pcId`-keyed: no Authorization
header, no shared secret** — hardened gateway-side by a `*.trycloudflare.com` URL
allowlist + a register rate-limit. Clerk lives ONLY in the mobile app, not the launcher.

## Architecture (DI everywhere)

Every collaborator is injected so the full lifecycle is testable with fakes (no real
api child, no real cloudflared, no real Ink/http).

- **`Launcher`** — orchestrator. `boot()` = `prepareCredentials()` (FIRST, before the
  api spawns + before Ink, so prompts own the plain terminal and the api child sees
  the creds) → `apiProcess.start()` → `waitForHealth` → mint JWT → `tunnel.start()` →
  serve loopback pairing page → render terminal QR. `runUntilSignal()` adds
  SIGINT/SIGTERM + api-death handling, then `shutdown()` (Ink unmount → pairing server
  → tunnel → api). `createLauncher()` (async) wires the real impls: ensures the local
  `JWT_SECRET`, resolves the pcId + relay, awaits `ensureCloudflared`, runs
  `ensureChromium` (the required Playwright browser; hard-fails before anything spawns),
  wires `prepareCredentials`, and passes the JWT secret/pcId/relay + the resolved
  Chromium path into the `ApiProcess` child env.

- **`PairingIdentity.ts`** — the data-path credential. `ensureJwtSecret(store, env)`
  reads `JWT_SECRET` from env → the shared `LocalSecretStore` (`launcher:jwt-secret`)
  → else generates + persists a 48-byte hex secret. `resolvePairingIdentity({pcId,
githubLogin?})` builds the stable local identity (`userId = pcId`, `username =
GitHub login || sanitized hostname` — **always non-empty**, the Socket.IO handshake
  requires it; `email = local@<host>`). `mintPairingToken(identity, secret)` →
  `generateAuthToken` (HS256, 72h sliding); the api renews actively-used tokens via the
  `X-Renewed-Token` header.

- **Credential resolution** (boot-time Anthropic + GitHub):
  - **`CredentialResolver.ts`** — OS-credential **discovery** ("find the keys already
    on the user's OS and use them"). Pure, seam-injected (`readFile`/`runCommand`/
    `platform`/`homedir` injected — no real fs/CLI/Keychain in tests). First hit wins,
    never throws on a missing source:
    - **Anthropic:** `ANTHROPIC_API_KEY` env → `CLAUDE_CODE_OAUTH_TOKEN` env → store
      `ai-credentials:claude-oauth-token` → `~/.claude/.credentials.json`
      (`claudeAiOauth.accessToken`) → macOS Keychain (`security find-generic-password`,
      darwin-guarded).
    - **GitHub:** `GITHUB_TOKEN`/`GH_TOKEN` env → store `github-oauth:token` →
      `gh auth token` → `~/.config/gh/hosts.yml` → `git credential fill`.

    `persistAnthropic`/`persistGitHub` copy a non-canonical hit INTO the same store key
    the api reads (idempotent). An `api-key` hit is NOT stored (it stays in
    `ANTHROPIC_API_KEY`, already forwarded to the api child env).

  - **`InteractiveCredentialLogin.ts`** — the **login fallback** when discovery misses,
    run in the PLAIN terminal before the api spawns + before Ink. All effects
    seam-injected. **Anthropic:** if the `claude` binary is on PATH, run `claude
setup-token` (inherited stdio), then re-discover + persist; if absent, a loud
    warning but never crashes boot. **GitHub:** offers the OAuth **device flow** (RFC
    8628, implemented locally — writes the same `github-oauth:token` key); needs
    `GITHUB_OAUTH_CLIENT_ID`, default-NO offer, fully skippable (connect later from the app).
  - **`prepareCredentials.ts`** — the boot orchestrator: per credential **discover →
    persist → (if missing) interactive login**. `skipInteractive` opt for CI.
  - **`LocalCredentialGuidance.ts`** — boot-time status reporter. `resolveCredentialStatus`
    mirrors the api's resolvers (same store keys + env); `reportCredentialGuidance` prints
    plain-log guidance when missing. **Never hard-blocks** (an API key / env GitHub token
    is enough, and GitHub can be linked later from the app).

  > **How creds reach the api child:** the launcher writes discovered/obtained creds
  > into the shared `LocalSecretStore` under the SAME namespaced keys the api reads
  > (`ai-credentials:claude-oauth-token`, `github-oauth:token`), and the api child
  > inherits the launcher's env (`buildApiChildEnv` forwards everything, including
  > `ANTHROPIC_API_KEY`). So `LocalAiCredentialsService` / `LocalGitHubAuthService`
  > resolve whatever the launcher discovered with no api change.

- **`TerminalUi.ts`** — the steady-state Ink UI. **ONE `render()` instance for the
  whole session**: `startLauncherUi` mounts `RootScreen` (switches on a `phase` prop:
  `pairing` → `PairingView` QR, `connected` → `ConnectedMenuView` menu) and returns a
  handle `{ stop(), showConnected(state) }`. ⚠️ **The pairing→connected transition is
  `instance.rerender(...)`, NOT a second `render()`** — calling `render()` again leaves
  the old frame in scrollback and starts a fresh region below it.
  - **QR render** (`renderTerminalQr`) — the standard `qrcode`
    `{type:'terminal',small:true}` half-block render (two stacked module-rows per cell
    so each module is square, which scanners need). Cost is **width** (~80 cols for a
    JWT payload); narrower terminals wrap it (won't scan) and the loopback SVG page is
    the fallback. The QR is intentionally NOT boxed (a border widens it past scan-safe);
    bordered chrome is reserved for the menu. Pre-rendered async BEFORE the mount so the
    components stay synchronous.
  - **Connected menu** (`ConnectedMenuView`) — bordered, with a status line (`● label ·
pcId`, "Last connected: <relative>"): **`1`** reveals the pairing QR (re-pair),
    **`2`/`q`/Ctrl-C** quits via `onQuit` (threaded `runUntilSignal → boot({onQuit})`).
  - **Detection + live swap** — the api stamps `<DATA_DIR>/pairing-state.json`
    (`PairingStateStore`) best-effort + throttled on each authed Socket.IO connection.
    The launcher reads it at boot to pick the initial phase AND, on a first-run QR, arms
    `ConnectionWatcher.ts` (~2s poll) → on the first connect calls `ui.showConnected(state)`
    → `rerender` to the menu with no restart. `--debug` keeps the one-shot static print
    (the live region would clobber streamed logs).

- **`PairingServer.ts`** — the loopback-only pairing fallback page. ⚠️ It binds the
  launcher's OWN port (127.0.0.1, **never** the tunneled api port — a `/t/<pcId>/...`
  pairing page would leak the JWT through the relay) and serves HTML with the same QR
  as an inline SVG. The raw JWT is NEVER in the page body, only inside the QR. Everything
  but `/` 404s.

- **`ApiProcess`** — spawns `bun packages/api/src/server.ts` with `buildApiChildEnv(env,
overrides)` (pins `API_BIND_HOST=127.0.0.1` + `VGIT_PORT`, drops `DEV_BACKEND_PORT`).
  Forwards the launcher's `JWT_SECRET` + `PORTABLE_PC_ID` + `PORTABLE_RELAY_URL` so the
  api validates the launcher-minted JWT with the same secret, plus
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` (from `ChromiumProvisioner`) so the api's
  required Playwright MCP gate passes. `waitForHealth(baseUrl)` polls `GET /api/health`
  until `{status:'ok'}` and aborts early via the `isAlive()` probe. `stop()` = SIGTERM
  → SIGKILL after a grace period.

- **`ChromiumProvisioner.ts`** (`ensureChromium`) — Playwright is a **required** MCP for
  chat, so the PC needs a local Chromium. `createLauncher` runs it SYNC, BEFORE
  constructing `ApiProcess`, and feeds the resolved path into the child env (the api
  reads `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` at module load). It: (1) skips when a valid
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is already set (user override); (2) resolves the
  executable the api's Playwright version expects; (3) runs `playwright install chromium`
  ONCE if missing (idempotent — Playwright's own cache persists it) — resolving the
  installer via `require.resolve('playwright/package.json')` → sibling `cli.js`, NOT a
  hardcoded nested path, so it works in a hoisted `bun install -g` layout; (4)
  **HARD-FAILS** with `CHROMIUM_INSTALL_HINT` if it can't end with a real browser. All
  effects are injected seams, so tests/CI/smoke never run a real install. Linux may need
  `playwright install-deps chromium` for system libs (documented in the hint, not auto-run).

- **`CloudflaredProvisioner.ts`** (`ensureCloudflared`) — auto-provisions cloudflared
  cross-platform so the user need NOT install it via winget/brew/apt. Uses the
  `cloudflared` npm package (a real, pinned dep) to download the official static binary
  ONCE. Order (first hit wins, never throws): `PORTABLE_CLOUDFLARED_BIN` override → the
  package's managed binary (download once if missing; pin via `CLOUDFLARED_VERSION`) →
  the `resolveCloudflaredBin` fallback (installed cloudflared on PATH / win32 dir probe)
  when the download is unavailable (offline). `createLauncher` awaits it and passes the
  resolved path as the `TunnelRouter`'s `cloudflaredBin`.

- **`CloudflaredTunnel`** — spawns + supervises `cloudflared tunnel --no-autoupdate
--url <localUrl>`, parses the rotating `*.trycloudflare.com` URL from stderr, and
  **restarts on crash** (a restart yields a NEW hostname, so the stale URL is dropped
  and `onUrl` fires again). **`cycle()`** forces that rotation on demand (kills the child
  WITHOUT setting `stopped`, so the supervisor respawns it → new host → re-register) —
  the self-heal hook `TunnelHealthMonitor` calls when the relay path is unreachable.
  A missing binary makes `start()` throw `CLOUDFLARED_INSTALL_HINT` (clear install
  steps incl. Windows `winget install --id Cloudflare.cloudflared`).
  **`resolveCloudflaredBin(env, platform, existsImpl)`** picks the executable to spawn:
  honors `PORTABLE_CLOUDFLARED_BIN`, then on **Windows** probes the well-known install
  dirs (`%ProgramFiles%`/`%ProgramFiles(x86)%\cloudflared`, the winget Links dir, scoop
  shims) because the winget/MSI installer frequently does NOT add cloudflared to PATH —
  so a bare `spawn('cloudflared')` ENOENTs even when installed. On macOS/Linux it stays
  the bare `'cloudflared'` (PATH lookup). `parseTrycloudflareUrl(line)` is the standalone,
  unit-tested URL extractor.

- **`TunnelRouter`** — cloudflared + registration-agent ownership seam. `start()` creates
  - starts a `CloudflaredTunnel` fronting the loopback api and routes **every** captured
    URL (first + each rotation/restart) to the `onTunnelUrl` registration-agent seam. A
    missing-cloudflared error propagates out so the launcher surfaces the install hint; a
    slow first URL is logged, not fatal. `stop()` tears down cloudflared then calls the
    `onStop` seam (the agent's heartbeat teardown). Inject `makeCloudflaredTunnel` to fake
    cloudflared in tests.

- **`PublicUrlVerifier.ts`** (`waitForPublicDns` / `verifyPublicUrl`) — public-URL
  readiness via pure `node:dns` + `fetch` (no `dig`/`curl` subprocesses). `waitForPublicDns`
  polls a `Resolver` pinned to the public resolvers (`1.1.1.1`/`8.8.8.8`, via `resolve4`
  which — unlike `lookup` — ignores `/etc/hosts` + the OS cache) until an A record appears;
  `verifyPublicUrl` waits for DNS then GETs the health path until 2xx/3xx. **Why it
  matters even for quick tunnels:** `*.trycloudflare.com` is NOT a wildcard (each tunnel's
  random hostname only enters DNS once cloudflared registers it) and the zone has a 30-min
  negative-cache TTL — so a resolver that queries too early caches an NXDOMAIN for up to
  30 min (or a transient edge 530 once DNS is up but the route isn't).

- **`TunnelRegistrationAgent`** — the PC-side registration agent. Driven by the router's
  `onTunnelUrl` seam: on every fresh URL it `POST /tunnel/register {pcId, currentUrl,
label, ttlMs}` to the hosted relay. **`verifyUrl` gate (cached-wrong fix):** when
  `createLauncher` wires it (to `verifyPublicUrl(url, {path:'/api/health', ...})`), the
  agent AWAITS it on each fresh URL **before** the register POST — the launcher fetching
  `https://<url>/api/health` proves the authoritative record exists + the edge route is
  live, so the gateway's first resolution lands on a real record on a live route. It is
  **fail-open** (verify timeout/throw → register anyway, logged) and **generation-checked**
  (a rotation mid-verify supersedes it). Registration is **`pcId`-keyed with NO
  `Authorization` header and NO shared secret** — the capability is possession of the QR
  (which carries the `pcId`); the relay hardens open registration with a
  `*.trycloudflare.com` URL allowlist + a register rate-limit, so a register `401`/`403`
  means **rejected URL / rate-limited**, not bad identity (non-transient — stops until the
  next rotation). While live it periodically `POST /tunnel/heartbeat` (also no auth header);
  a heartbeat `404` (TTL lapsed) transparently re-registers. A **generation token**
  supersedes in-flight work for an old URL on rotation, so a stale retry can never
  re-publish a dead URL. Relay base via `resolveRelayBaseUrl()` (`PORTABLE_RELAY_URL`,
  self-host; default `https://app.portable-dev.com`); `getEndpoint()` = `${relay}/t/${pcId}`;
  pcId via `resolvePcId(store, env)` (`PORTABLE_PC_ID` → persisted `tunnel:pc-id` →
  generated `pc_<uuid>`); label via `resolvePcLabel(env)` (`PORTABLE_PC_LABEL` → hostname).

  > **`PORTABLE_REVIEWER_PUBLISH` (opt-in, default OFF — Apple-reviewer box ONLY).**
  > When set, `boot()` threads the launcher-minted JWT to the agent's `reviewerToken`
  > option and the agent adds it to the `/tunnel/register` body so the gateway stores it
  > per `pcId` and the reviewer route serves it — so the operator never needs `JWT_SECRET`
  > and no JWT is stored in GitHub. The heartbeat body NEVER carries the token. ⚠️ **A
  > normal PC NEVER publishes its JWT** — default OFF leaves the register body
  > byte-unchanged. This is ONLY for the disposable Apple-reviewer box.

- **`TunnelHealthMonitor`** (`startTunnelHealthMonitor`, tunnel self-heal) — fixes a
  failure class that crash-restart + heartbeats miss: **the local api + cloudflared are
  healthy, yet the gateway's `TunnelRegistry` points at a DEAD/STALE tunnel URL** (a
  rotation hit the register rate-limit, or the TTL lapsed with no successful re-register)
  — the phone then gets a Cloudflare 502/530 (or "no PC" 404) from the relay while
  everything on the PC looks fine. Only an end-to-end probe of the **relay** endpoint
  exposes it, so the monitor periodically `GET`s `<gatewayBase>/t/<pcId>/api/health`
  (unauthenticated on the api, so no token) and, on `failureThreshold` (2) consecutive
  failures WHILE the loopback `/api/health` is healthy, calls **`TunnelRouter.cycle()`**
  → new hostname → re-register → relay recovers. Guards against spinning: blames the
  tunnel only when the local api is healthy, requires consecutive failures, and after a
  cycle waits an exponentially escalating cooldown (30s → 300s) while cycles keep not
  recovering; a single healthy probe resets everything. **⚠️ It must NOT cycle while a
  device is CONNECTED** (`isDeviceConnected` seam, wired from the live `device-presence.json`
  list): a connected device's live Socket.IO ride proves the relay→tunnel→api path works,
  so a failing public probe is a transient flap — cycling would tear down the working
  tunnel, drop the device, and the fresh cold tunnel would fail the probe again → a phone
  reconnection loop. `Launcher.boot()` starts it; `shutdown()` stops it.

- **`SingletonGuard.ts`** (`acquireSingleton`) — **single-instance takeover** so typing
  `portable` in a second window is a full restart (the first instance is stopped, the
  second boots fresh), regardless of directory. The launcher pins the api to
  `127.0.0.1:VGIT_PORT` and registers ONE pcId, so two runtimes can't coexist. `cli.ts`
  calls it BEFORE `createLauncher`. Detection is authoritative on the **`GET /api/health`
  probe** (not the lock file alone — robust against a stale lock and PID recycling). The
  lock file `<DATA_DIR>/launcher.lock` (`{pid,port,startedAt}`) supplies the launcher pid
  to tree-kill (its children are the api child + cloudflared); a port-owner lookup
  (`netstat -ano`/`lsof -ti`) is the fallback. Tree-kill is cross-platform: **Windows
  `taskkill /T /F`**, **POSIX SIGTERM→SIGKILL**. After the kill it WAITS for the port to
  free (~12s cap) before booting ours. **Never throws into boot.** `release()` (wired to
  `process.once('exit')`) removes the lock only if it's still ours.

## Gotchas

- **The api must bind loopback.** `packages/api/src/server.ts` honors `API_BIND_HOST`
  (set by `buildApiChildEnv`). When unset (e.g. a bare `bun run dev`) it keeps Node's
  default (all interfaces) — only the launcher pins 127.0.0.1.

- **D30 invariant — do NOT introduce a private `CLAUDE_CONFIG_DIR`, and do NOT override
  `HOME`.** `buildApiChildEnv` spreads `{ ...base }` so `HOME` passes through to the api
  child unchanged, and the launcher never sets `CLAUDE_CONFIG_DIR`/`CLAUDE_CACHE_DIR`/
  `CLAUDE_LOG_DIR`. This is load-bearing: Claude Code state lives in the host user's real
  `~/.claude`, shared with the user's own terminal `claude` on the same machine, which is
  what makes `~/.claude/skills` and `~/.claude/projects` transcripts visible to portable.
  An env-build refactor must not drop the `HOME` pass-through (guarded by a launcher unit
  test in `ApiProcess.test.ts`).

- **`config.ts` resolves at CALL TIME** (reads env per call) so tests can vary `VGIT_PORT`
  between runs. Mirror that for any new resolver.

- **Scripts/health pieces avoid `@vgit2/shared`.** `ApiProcess.ts` + `config.ts` import
  NOTHING from `@vgit2/shared`, so `scripts/smoke-launcher.ts` can import them from the
  repo root (where the workspace package isn't hoisted). Keep the spawn/health path
  shared-free; the shared-touching pieces are `Launcher`/`PairingIdentity`/
  `LocalCredentialGuidance` (secret store + `@vgit2/shared/jwt`) and `cli.ts`.

- **Ink/JSX:** `TerminalUi.ts` uses `React.createElement` (aliased `h`), NOT JSX — the
  tsconfig has no `jsx` setting. Pre-render the QR string BEFORE mounting Ink so the
  component stays synchronous. ⚠️ One `render()` per session — transition with
  `instance.rerender(...)`, never a second `render()`. The api child's stdout is routed
  to the launcher LOG FILE (the `apiLog` seam, `cli.ts`) so it never interleaves with the
  Ink-owned terminal.

- **`--debug` (`portable start --debug` / `-d`):** for watching connections arrive.
  `cli.ts` parses the flag (the command is the first non-flag positional) and: (1)
  `openApiLogSink` **tees** every `[api]` line to the terminal as well as the log file;
  (2) `createLauncher({ debug })` swaps the live Ink screen for a one-shot static QR print
  (the live app clears+redraws its region every render and would clobber streamed logs);
  (3) the api child is given `PORTABLE_DEBUG=1` so it emits its extra per-connection
  diagnostics (one gated line in `SocketIOService`, OFF by default).

- **⚠️ The pairing page is loopback-ONLY.** `PairingServer` binds 127.0.0.1 on the
  launcher's OWN port — NEVER the tunneled api port. A pairing/QR endpoint on the api
  would be reachable via `/t/<pcId>/...` and leak the JWT through the relay. Do NOT add a
  pairing endpoint to the api.

- **Tests live in `tests/`** (mapped to the `other-pkgs` shard by `scripts/test-shard.sh`).
  `tsconfig.json` excludes `tests/**` + `*.test.ts` so `bun:test` globals don't break `tsc`.

- **Reuse the SAME `LocalSecretStore` instance** for any new local secret consumer (the
  JWT secret `launcher:jwt-secret`, Claude OAuth, GitHub token, connection creds all share
  it under namespaced keys).

- **`portable link`/`unlink` nudge a RUNNING api — no restart needed.** `ProjectLink` only
  mutates the filesystem (the workspace junction + `repo-views.json`). The api walks
  `WORKSPACE_DIR` LIVE per request, but a running api keeps two in-memory caches
  (repos-list + viewed-repos) that would hide a fresh link until restart. So
  `ProjectCommands` fire a best-effort loopback `POST /api/repos/rescan` via
  `NotifyRunningInstance.ts`: it re-derives the SAME data-path JWT the running launcher
  minted (shared `JWT_SECRET` + `pcId`) and calls the loopback api, which drops both caches
  for that identity. It NEVER throws — when `portable` isn't running (ECONNREFUSED) the CLI
  falls back to the "restart" hint. The endpoint stays behind the JWT middleware (reachable
  via `/t/<pcId>` over the relay, so it must never be unauthenticated).

## Dev loop (run from SOURCE — no build/install per change)

For development you do NOT need the `build:portable` → pack → `bun install -g` cycle (that's
only for distribution validation). Iterate from source:

- **Full end-to-end:** `bun run portable` (alias `bun run cli`) = `bun --cwd packages/launcher
start` → `bun src/cli.ts start`. The packaged-mode entry resolution (`config.ts`
  `resolveApiServerEntry`) returns the **source** `packages/api/src/server.ts` in a checkout,
  so it spawns the api from source too — edits to BOTH the launcher and the api take effect
  immediately.
- **Fast UI iteration (no runtime):** `bun run cli:preview [cols] [rows] [phase] [device]`
  (`scripts/preview.ts`) headlessly renders a screen to a non-TTY fake stdout, captures the
  last full frame, strips ANSI, and prints it as plain text — the quickest way to eyeball
  the connected/booting/pairing layout. DEV-only, never bundled.

## Distribution (installable `portable` CLI)

The launcher ships as an installable CLI (`bun install -g`, no compiled binary — Bun is the
runtime). Full how-to + troubleshooting: [`docs/portable-distribution.md`](../../docs/portable-distribution.md).
In short:

- **Build:** `bun run build:portable` (`scripts/build-portable.ts`) bundles the launcher CLI
  (`cli.ts`) + the api server into `dist-portable/{cli.js,server.js}` — first-party (`@vgit2/*`
  - relative) INLINED, third-party node_modules EXTERNAL (load-bearing: native + path-spawned
    sidecars must stay real packages), deps PINNED to exact versions. The packaged artifact
    spawns its sibling `server.js` via the packaged-mode branch in `config.ts`. The dep set is
    the launcher+api+shared union MINUS an `EXCLUDE_FROM_DIST` list (deps no bundle reaches): a
    dep referenced by a bundle MUST NOT be excluded (the build would surface it loudly).
- **Install:** `scripts/install-portable.{ps1,sh}` ensure Bun + Bun's global-bin dir
  (`~/.bun/bin`) on PATH, then `bun install -g`. **The PATH step matters:** a WinGet/MSI Bun
  install skips wiring `~/.bun/bin`, so the `portable` shim is unfindable without it. Hardened
  for fresh machines: resolve the just-installed Bun explicitly, **refuse to install over a
  RUNNING `portable`** (the Windows lock below), run `bun install -g --prefer-offline` under an
  inactivity watchdog with retries (a stalled npm-registry connection is killed + retried), and
  **verify the installed shim actually RESOLVES**. ⚠️ On Windows the PS installer gauges success
  by the OUTCOME (the package entry materialized), NOT `Start-Process -PassThru`'s `.ExitCode`
  (which reads back `$null` after exit).
- **Update gotcha (Windows):** stop a running `portable` before reinstalling — the live api
  holds the global-store `node_modules` files open, so an in-place `bun install -g` stalls. The
  hardened installer detects this and aborts with guidance.

## Quality gate

`bunx tsc --noEmit` (green), `bun test` (no real network — cloudflared / the relay / the http
pairing server / Ink are all mocked), and `bun run smoke:launcher` (real api spawn +
`/api/health`). The full one-command boot — terminal QR + a real device scan-and-pair against a
live relay — is the post-run live-smoke (device-deferred).
