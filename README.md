# Portable — a drop-in replacement for Claude Code /remote with batteries

**Portable** runs on your computer and phone, allowing you to use Claude Code from anywhere.
Run it on **your own PC** with one command (`portable`); your repos, chats, and data live locally; and you drive from the **Portable mobile app** QR code.

Portable.dev uses your Claude Code subscription, meaning that it costs nothing.

100% free, Open Source, and fully private — we do not see any of your data or AI chats.

> **TL;DR**
>
> ```bash
> git clone https://github.com/volter-ai/portable.dev.git
> cd portable.dev
> bun install
> bun run portable          # → prints a pairing QR in your terminal
> ```
>
> Then open the **Portable** app, sign in, and **scan the QR**. That's it — in the happy
> path you don't even need a `.env`.

---

## Quickstart — go Portable in 60 seconds

Install the endpoint on your machine with one command, then grab the app. Pick your flavor.

<details open>
<summary><b>🥟 bun</b></summary>

```bash
bun install -g @volter-ai/portable.dev
```

</details>

<details>
<summary><b>📦 npm</b></summary>

```bash
npm install -g @volter-ai/portable.dev
```

</details>

<details>
<summary><b>🌐 curl</b></summary>

```bash
curl -fsSL https://portable.dev/install.sh | bash
```

</details>

<details>
<summary><b>🛠️ source</b> — build from the repository</summary>

```bash
git clone https://github.com/volter-ai/portable.dev.git
cd portable.dev && bun install && bun run build
```

</details>

Then start the runtime — it prints a pairing QR in your terminal:

```bash
portable                 # or, from a source checkout: bun run portable
```

**Then install the mobile app**, sign in, and **scan the QR**:

- [App Store](https://apps.apple.com/us/app/portable-dev/id6758861546)
- [Google Play](https://play.google.com/store/apps/details?id=dev.portable.app)

---

## Table of contents

- [Quickstart — go Portable in 60 seconds](#quickstart--go-portable-in-60-seconds)
- [What you get](#what-you-get)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Install the `portable` CLI](#install-the-portable-cli)
- [`bun run portable` — what happens](#bun-run-portable--what-happens)
- [CLI commands](#cli-commands)
- [The `--debug` flag](#the---debug-flag)
- [Pair your phone](#pair-your-phone)
- [Configuration (`.env`)](#configuration-env)
- [Credentials (Claude + GitHub)](#credentials-claude--github)
- [Other scripts](#other-scripts)
- [Project structure](#project-structure)
- [Self-hosting the relay](#self-hosting-the-relay)
- [Troubleshooting](#troubleshooting)
- [Reference](#reference)
- [License](#license)

---

## What you get

- **Chat with Claude about your code** — full Claude Agent SDK with tools, running on your
  machine with access to your real repos.
- **GitHub built in** — browse repositories, issues, PRs, branches, and Actions; let the AI
  read files, search code, and manage issues/PRs on your behalf.
- **Your data stays on your PC** — chats, connections, themes, and settings persist in
  **local SQLite** under your data dir. No Supabase, no Postgres, no Docker required.
- **Your own Claude account** — sign in with your **Claude subscription**; AI calls go
  **direct** to `api.anthropic.com`. There is no billing path in the middle.
- **Rich mobile chat** — multiple concurrent sessions, file/image uploads, on-device voice
  input, tool output, and task lists, all from a native Expo / React Native app.

---

## How it works

Portable is **local-first**. The backend (`packages/api`) runs on **your PC**, bound to
`127.0.0.1`. The launcher (`packages/launcher`, i.e. `portable start`) publishes it through a
**Cloudflare Quick Tunnel** and registers that rotating URL with a public **relay**. The mobile
app talks to a stable `/t/<pcId>` address on the relay, which reverse-proxies to your PC's
current tunnel. The relay never holds your AI credential or your data — it only forwards traffic.

```
┌────────────────────────────┐
│  Portable app (Expo RN)    │   packages/mobile — the only client
│  • native Clerk sign-in    │
│  • scans the pairing QR    │
└──────────────┬─────────────┘
               │  HTTPS / WebSocket → <relay>/t/<pcId>/*
┌──────────────▼───────────────────────────────────────┐
│  Online relay / gateway (the hosted relay)            │
│  • in-memory TunnelRegistry (pcId → current tunnel)   │
│  • POST /tunnel/{register,heartbeat}  (pcId-keyed)    │
│  • reverse-proxies /t/<pcId>/* to your PC             │
└──────────────┬────────────────────────────────────────┘
               │  reverse-proxy → your PC's current cloudflared URL
┌──────────────▼───────────────────────────────────────┐
│  YOUR PC  (everything below runs locally)             │
│  ┌──────────────────────────────────────────────┐    │
│  │  portable start  (packages/launcher)          │    │
│  │  • finds your Claude + GitHub credentials     │    │
│  │  • provisions cloudflared + Chromium          │    │
│  │  • spawns the api on 127.0.0.1:VGIT_PORT      │    │
│  │  • mints the data-path JWT (local secret)     │    │
│  │  • owns cloudflared, registers the tunnel URL │    │
│  │  • renders the pairing QR in the terminal     │    │
│  └──────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────┐    │
│  │  api  (packages/api) — API + Socket.IO only   │    │
│  │  • local SQLite (bun:sqlite) under DATA_DIR   │    │
│  │  • validates the JWT LOCALLY (no remote svc)  │    │
│  │  • Claude Agent SDK → api.anthropic.com       │    │
│  └──────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────┘
```

The PC has **no cloud login**: the launcher mints its own data-path JWT with a per-install
secret and the api validates it locally. The QR you scan carries everything the app needs —
`{ gatewayBase, pcId, token }` — so pairing is a single scan, with nothing to copy by hand.

> **Privacy note.** App↔PC traffic is **end-to-end encrypted**: the launcher generates a
> pre-shared key (`PORTABLE_E2E_PSK`) on first boot and carries it **only in the pairing QR**
> (never over the network), so the relay and Cloudflare forward ciphertext they cannot read.
> To also keep the routing infrastructure under your control, you can run your own relay:
> see [Self-hosting the relay](#self-hosting-the-relay).

---

## Requirements

The launcher provisions almost everything itself. You only bring three things.

| Requirement                 | Why                                                                        | Get it                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **[Bun](https://bun.sh)**   | Runs the launcher and the api (this is a Bun monorepo).                    | `curl -fsSL https://bun.sh/install \| bash` (macOS/Linux) · `irm bun.sh/install.ps1 \| iex` (Windows)   |
| **A Claude subscription**   | The AI itself. Signed in via the `claude` CLI's token (no API key needed). | `claude setup-token` (or the launcher runs it for you on first boot)                                    |
| **The Portable mobile app** | The client you actually use Portable from.                                 | Build it from `packages/mobile` with [Expo](https://docs.expo.dev/), or use the team's published build. |

**Provisioned automatically on first run — you do _not_ install these:**

- **cloudflared** — the launcher downloads the official static binary once (via the bundled
  `cloudflared` package) to publish your PC's tunnel. If the download is unavailable (offline),
  it falls back to a cloudflared already on your PATH; only then do you need to install one
  (the launcher prints the steps).
- **Chromium** — a Playwright Chromium is fetched once (~150 MB) for the in-chat browser
  automation, then cached for instant reuse. On Linux you may also need
  `playwright install-deps chromium` once for the system libraries (the launcher prints the hint).

**Optional:**

- **GitHub access** — auto-discovered from the GitHub CLI (`gh`) or your git credential
  helper if present, **or** connect it later from the app. Only the in-terminal login
  fallback needs a `GITHUB_OAUTH_CLIENT_ID` (see [Credentials](#credentials-claude--github)).
- **No Docker, no Supabase/Postgres** — the local runtime stores everything in local SQLite
  automatically.

**Platforms:** macOS, Linux, and Windows.

---

## Quick start

```bash
# 1. Clone
git clone https://github.com/volter-ai/portable.dev.git
cd portable.dev

# 2. Install dependencies (Bun monorepo)
bun install

# 3. Start the PC runtime — prints a pairing QR
bun run portable
```

Then open the **Portable** app, sign in, and **scan the QR** shown in your terminal. The app
connects over a live Socket.IO session and you're ready to chat.

> In the happy path there is **nothing to configure**. The launcher discovers your Claude
> and GitHub credentials already on the machine, generates and persists its own signing secret,
> and pairs purely from the QR. Only reach for a `.env` when one of the
> [specific situations](#configuration-env) applies.

---

## Install the `portable` CLI

The Quick start above runs the launcher straight from the source checkout (`bun run
portable`) — perfect for development. To get a real **`portable`** command on your PATH
(so you can just type `portable` from any directory), use the install scripts:

```bash
# macOS / Linux
scripts/install-portable.sh

# Windows (PowerShell)
scripts\install-portable.ps1
```

Each script ensures **Bun** is present, puts Bun's global-bin dir (`~/.bun/bin`) on your
**PATH** (a winget/MSI Bun install often skips this, so the shim is otherwise unfindable),
then installs the CLI (the published [`@volter-ai/portable.dev`](https://www.npmjs.com/package/@volter-ai/portable.dev)
package by default; run with **no arguments from inside the checkout** to **build a local
artifact and install that** instead — no manual `build:portable` or
`PORTABLE_INSTALL_SOURCE` needed). Then, from any directory:

```bash
portable                 # start the runtime + show the pairing QR
portable --help          # all commands
```

The scripts are **hardened for fresh / other machines**: they refuse to install over a
running `portable`, run the install under an inactivity watchdog with retries (so a flaky
npm-registry connection can't hang forever), clear a stale global package pin that would
otherwise conflict, fail fast with the real error on a genuine not-found (instead of
retrying a 404 as if it were the network), and verify the installed shim actually resolves.

---

## `bun run portable` — what happens

`bun run portable` is shorthand for `bun --cwd packages/launcher start`. On start the launcher:

1. **Resolves your credentials.** It looks for a Claude credential and a GitHub token
   already on your machine (the `claude` CLI's login → the local store → `~/.claude` /
   `gh` / git helper / macOS Keychain). If no Claude credential is found and the `claude`
   CLI is installed, it runs `claude setup-token` for you. GitHub is optional and can be
   linked later from the app. See [Credentials](#credentials-claude--github).
2. **Provisions cloudflared and Chromium** if they aren't present yet (once; cached afterward).
3. **Mints the data-path JWT** with a per-install `JWT_SECRET` (auto-generated and persisted
   in a local encrypted store on first boot).
4. **Spawns the api** as a child process, forced into local mode and pinned to
   **`127.0.0.1:VGIT_PORT`** (API + Socket.IO only — it serves no web bundle), and waits for
   `GET /api/health` to return `{ "status": "ok" }`.
5. **Brings up cloudflared** — publishes a rotating `*.trycloudflare.com` URL and registers it
   with the relay (`POST /tunnel/register`, `pcId`-keyed — no login, no shared secret),
   heartbeating to hold the TTL and re-registering automatically on each rotation. The stable
   address the app uses is `<relay>/t/<pcId>`.
6. **Renders the pairing QR** in the terminal (and serves a loopback fallback page printed as
   `http://localhost:<port>/`).
7. Runs until **Ctrl-C**, then shuts down gracefully (UI → pairing server → tunnel → api).

The api child's logs are written to a file under your data dir (`<DATA_DIR>/logs/api-*.log`) so
they don't fight the QR for the terminal.

---

## CLI commands

The CLI command is `portable` once [installed globally](#install-the-portable-cli); from a
source checkout it's `bun run portable -- <command>` (or `bun --cwd packages/launcher start`).

| Command            | What it does                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `portable`         | Default. Auto-links the current dir (only if it's a git repo inside your home dir), then starts the runtime and shows the pairing QR. Runs until Ctrl-C.    |
| `portable connect` | Same as bare `portable` (the canonical "start the runtime" name). `portable start` is a back-compat alias.                                                  |
| `portable link`    | Register the **current directory** as a Portable project so it shows up in the app (git repo required). Refuses system dirs; confirms before your home dir. |
| `portable unlink`  | Remove the current directory from your Portable projects.                                                                                                   |
| `portable help`    | Show help (`--help` / `-h`).                                                                                                                                |

- **`link` / `unlink` apply with no restart** — they nudge a running `portable` to rescan, so
  the project appears (or disappears) in the app immediately.
- **Single instance (takeover).** Running `portable` while one is already up **stops the first
  and boots fresh** — its launcher, api child, and cloudflared are all stopped, then a new
  runtime takes the port. **A second window is just a full restart, regardless of directory.**

Full CLI reference (flags, env knobs, modules): [`packages/launcher/README.md`](packages/launcher/README.md).

---

## The `--debug` flag

Want to watch connections arrive (e.g. to confirm your phone actually reached the PC)? Run:

```bash
bun run portable -- --debug        # or: -d
# (direct: bun --cwd packages/launcher start --debug)
```

With `--debug` the launcher:

- **Streams the api logs to your terminal** as well as the log file, so you can watch each
  request, Socket.IO handshake, and `[handshake]` / `[JwtAuth]` line live.
- **Prints the QR once** (a static print) instead of the live re-drawing screen — the live
  screen would otherwise redraw over your scrolling logs.
- Turns on the api's extra per-connection diagnostics (`PORTABLE_DEBUG=1`), e.g. the Socket.IO
  "User connected" line.

The `--` after `bun run portable` forwards the flag to the launcher rather than to Bun.

---

## Pair your phone

Pairing is **QR-only** — there is no PC list to pick from.

1. Start the PC runtime with `bun run portable`.
2. Open the **Portable** app and **sign in** (Clerk identity — mobile only).
3. On the **connect** screen, **scan the QR** in your terminal (or open the printed
   `http://localhost:<port>/` page and scan that).
4. The QR carries `{ gatewayBase, pcId, token }`, so the app stores the token per `pcId` and
   connects to `<gatewayBase>/t/<pcId>` over live Socket.IO — **no re-scan needed** on later
   launches; the relay re-points to your PC's current tunnel automatically on every rotation.

> **QR won't scan?** The terminal QR needs a fairly wide window (it renders square modules for
> the camera). If it wraps or your camera can't read it, open the printed
> `http://localhost:<port>/` pairing page on the same machine and scan the crisp SVG there.

---

## Configuration (`.env`)

**You usually need no `.env` at all.** See [`.env.example`](.env.example) for the full,
annotated list. Everything below has a sensible default; set a value only when a specific
situation applies. Put overrides in a `.env` at the repo root.

| Variable                              | Default                      | Set it when…                                                                                                    |
| ------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GITHUB_OAUTH_CLIENT_ID`              | _(none)_                     | GitHub wasn't auto-discovered and you want the in-terminal device-flow login (scopes `repo read:org`).          |
| `JWT_SECRET`                          | _auto-generated + persisted_ | You want to pin a specific signing secret (e.g. reuse across reinstalls).                                       |
| `PORTABLE_E2E_PSK`                    | _auto-generated + persisted_ | You want to pin the end-to-end encryption pre-shared key (base64, 32 bytes; carried only in the pairing QR).    |
| `PORTABLE_RELAY_URL`                  | `https://app.portable.dev`   | You [self-host the relay](#self-hosting-the-relay) (or want a different hosted relay).                          |
| `PORTABLE_PC_ID`                      | `pc_<uuid>` (persisted)      | You want a stable, human-chosen PC id (routing key, not a secret).                                              |
| `PORTABLE_PC_LABEL`                   | _hostname_                   | You want a friendly display name for the PC.                                                                    |
| `VGIT_PORT`                           | `4200`                       | The default port is taken. **⚠️ Never use `7878`** — it is reserved by the dev tooling.                         |
| `WORKSPACE_DIR`                       | `~/claude-workspace`         | You want repos cloned somewhere else.                                                                           |
| `DATA_DIR`                            | `~/.portable`                | You want local SQLite + the secret store somewhere else.                                                        |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | _(auto-installed)_           | You want to point the in-chat browser at an existing Chrome/Chromium instead of the auto-provisioned one.       |
| `CLAUDE_SESSION_IDLE_TTL_MS`          | `600000` (10m)               | You want a different idle window before a live Claude subprocess is reaped (the session resumes transparently). |
| `DEBUG`                               | `false`                      | You want verbose api logging.                                                                                   |
| `SENTRY_DSN`                          | _(unset → disabled)_         | You want backend error reporting.                                                                               |

> **Env tip.** Start with **no `.env`**, run `bun run portable`, and read the launcher output.
> If the AI is unavailable it will tell you exactly which credential is missing — only then add
> the one line you need. Don't copy the whole `.env.example`.

---

## Credentials (Claude + GitHub)

The launcher **discovers credentials already on your OS** and uses them — copy nothing if you
already use the `claude` CLI or `gh`.

**Claude** (resolution order, first hit wins):
`CLAUDE_CODE_OAUTH_TOKEN` env → the local encrypted store → `~/.claude/.credentials.json` (the
`claude` CLI's subscription login) → the macOS Keychain. If none is found **and** the `claude`
CLI is installed, the launcher runs `claude setup-token` interactively. If nothing works it
prints guidance but **never blocks boot** — you just can't run AI until a credential is
present. Calls always go direct to `https://api.anthropic.com` with your own Claude account.

**GitHub** (optional — connect later from the app if you skip it):
`GITHUB_TOKEN` / `GH_TOKEN` env → the local store → `gh auth token` → `~/.config/gh/hosts.yml`
→ the git credential helper. If GitHub isn't found, the launcher **offers** the OAuth **device
flow** in the terminal — that path needs a `GITHUB_OAUTH_CLIENT_ID` (a public GitHub OAuth App
client id, scopes `repo read:org`). The token is stored locally, never on a server.

---

## Other scripts

| Command                       | What it does                                                               |
| ----------------------------- | -------------------------------------------------------------------------- |
| `bun run portable`            | Bring the full PC runtime up (creds → api → cloudflared → register → QR).  |
| `bun run portable -- --debug` | Same, but stream api logs to the terminal (watch connections).             |
| `bun run smoke:launcher`      | Smoke test: boots the api child and asserts `/api/health → {status:'ok'}`. |
| `bun typecheck`               | Type-check every package (api, launcher, gateway, mobile).                 |

> **Mobile app:** `cd packages/mobile` and use the standard Expo workflow (`bun install`,
> `bunx expo start`, EAS builds). See [`packages/mobile/CLAUDE.md`](packages/mobile/CLAUDE.md).

---

## Project structure

This is a **Bun monorepo**:

```
packages/
├── shared/      # Shared constants, types, JWT utils, local encrypted secret store
├── api/         # Backend — runs on YOUR PC (API + Socket.IO only; local SQLite under DATA_DIR)
│   └── src/{server.ts, services/, routes/, middleware/, tools/, db/}
├── launcher/    # `portable start` — finds creds, spawns api, owns cloudflared, mints JWT, shows QR
│   └── src/{cli.ts, Launcher.ts, ApiProcess.ts, CloudflaredTunnel.ts, TunnelRegistrationAgent.ts,
│            PairingIdentity.ts, TerminalUi.ts, prepareCredentials.ts, …}
├── mobile/      # Expo / React Native app — the only client (sign-in, scan QR, chat, repos)
│   └── {app/ (Expo Router routes), src/features/*}
├── gateway/     # The hosted relay (tunnel registry + reverse proxy) — runs at app.portable.dev,
│                # not part of the local install (and not included in the open-source mirror)
```

Deeper rules live in each package's `CLAUDE.md`.

---

## Self-hosting the relay

App↔PC traffic is end-to-end encrypted, so the hosted relay only forwards ciphertext — but if
you also want the routing infrastructure itself on machines you control, you can run your
**own** relay and point your PC and app at it. The relay's job is small: accept the PC's
pcId-keyed tunnel registration and reverse-proxy app traffic to the PC's cloudflared tunnel
(see [docs/encryption.md](docs/encryption.md) for what a relay can and cannot see):

- **PC:** set `PORTABLE_RELAY_URL=https://relay.example.com` before `bun run portable`.
- **App:** the scanned QR carries the relay address, so a PC registered with your relay pairs
  the app to your relay automatically.

---

## Troubleshooting

- **cloudflared couldn't be provisioned.** The launcher downloads cloudflared for you; if that
  fails (offline) it falls back to one on your PATH. Install cloudflared manually and re-run —
  nothing else has spawned yet, so there's nothing to clean up.
- **"AI unavailable" / no Claude credential.** Run `claude setup-token` to sign in with your
  Claude subscription. Boot still succeeds — you just can't run the AI until a credential is present.
- **Phone can't reach the PC.** Run with `--debug` and watch for the handshake line when you
  connect. Confirm the QR you scanned came from **this** running launcher (the token rotates).
- **Port already in use.** Set `VGIT_PORT` to a free port (anything but the reserved `7878`).
- **QR won't scan.** Widen the terminal or open the printed `http://localhost:<port>/` page.
- **Chromium / Playwright errors on Linux.** Run `playwright install-deps chromium` (needs sudo)
  for the system libraries.

---

## Reference

- **Service Accounts** — long-lived API tokens (`sa_…`) for CI/CD and automation, AES-256-GCM
  encrypted at rest, rate-limited, with an immutable audit log (persisted to local SQLite).
- **Self-hosting the relay** — see [Self-hosting the relay](#self-hosting-the-relay) above.
- **Project rules / architecture** — each package's `CLAUDE.md` (`packages/*/CLAUDE.md`).

---

## License

Apache-2.0
