# `@vgit2/api` — Local-First Backend

The single-user backend that runs on the user's **own PC** (launched by `portable start`,
the [`@vgit2/launcher`](../launcher/CLAUDE.md) package). It validates a PC-minted **JWT** or a
local **device token**, runs Claude execution with MCP tools, manages the per-user workspace and
service connections, and persists everything on **local SQLite** (`bun:sqlite`, under `DATA_DIR`).
It serves **API + Socket.IO only — no web bundle**; the mobile Expo RN app (`packages/mobile`) is
the only client.

> Working in this package with Claude Code? Read [`./CLAUDE.md`](./CLAUDE.md) for the rules and
> key service gotchas. This README is the architecture + routes reference.

## What this package is

One `@vgit2/api` process runs on the user's own PC in **local mode**, spawned as a child by the
launcher (`portable start`) and bound to `127.0.0.1:VGIT_PORT`. It is **not** publicly reachable on
its own — the mobile app reaches it via the [gateway](../gateway/README.md)'s reverse-proxy relay at
`app.portable.dev/t/<pcId>/...` (the launcher registers the PC's cloudflared tunnel URL with the
gateway's tunnel registry). From there the api package serves all REST + Socket.IO traffic for that
user. Isolation is the **single-user PC boundary** — this install serves one identity, and every
query filters by `user_id`.

## API vs Gateway

VGit2 has two backend services. They run in different places and do different jobs:

|               | **`@vgit2/gateway`**                                                       | **`@vgit2/api`**                                                                |
| ------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Runs on**   | The public online relay (`app.portable.dev`) — one shared process          | The user's own PC (local mode) — one process per install                        |
| **Public?**   | Yes — the only public entry point (`app.portable.dev`)                     | No — reached via the gateway's `/t/<pcId>` reverse-proxy relay                  |
| **Auth role** | Verifies Clerk **identity** (mobile sign-in) + the tunnel registration     | **Validates** the JWT / local device token on the PC; runs the per-user session |
| **State**     | Stateless (tunnel registry; Redis for shortlinks etc.)                     | Local SQLite under `DATA_DIR` (chats, connections, themes, push, secrets vault) |
| **Core job**  | Verify identity, hold the tunnel registry, reverse-proxy the app to the PC | Claude execution, chat/repo/workspace ops (API + Socket.IO only)                |
| **Talks to**  | Clerk, Redis, the registered PC tunnels                                    | Claude Agent SDK, GitHub (local OAuth), local SQLite, MCP tool servers          |

**Handoff:** the gateway verifies the user's Clerk identity, holds the **tunnel registry** (the
PC's cloudflared tunnel URL, registered by the launcher), and **reverse-proxies** the mobile app to
the PC at `app.portable.dev/t/<pcId>/...`. The api package (running on the PC) validates the JWT /
device token and serves all subsequent traffic. Full gateway details:
[`packages/gateway/README.md`](../gateway/README.md).

## Architecture

### Entry point

`src/server.ts` is the orchestrator. It loads config from `@vgit2/shared/constants`, initializes
Sentry, sets up CORS (native origins), creates the HTTP + Socket.IO servers, instantiates the
service layer in dependency order (wiring the ClaudeService ↔ ChatExecutionService cycle), mounts
the route groups under `/auth`, `/api`, `/vibewaiting`, and `/internal/tunnel`, and installs
graceful-shutdown handlers. It serves **no web bundle** — `setupStaticFiles()` only registers a JSON
404 + the global error handler.

### Service layer (`src/services/`)

Grouped by domain:

- **Execution** — `ClaudeService` (Claude Agent SDK, subprocess sessions), `ChatExecutionService`
  (transport-agnostic execution), `SocketIOService` (room-based real-time messaging). AI calls go
  **direct** to `https://api.anthropic.com` using the user's own Anthropic credential
  (`LocalAiCredentialsService` — Claude OAuth or `ANTHROPIC_API_KEY`).
- **Chat & data** — `ChatService` (CRUD, buffering, message previews), `IntentAnalysisService`.
- **GitHub & repos** — `GitHubApiService` (Octokit wrapper, per-user token cache, retry/throttle
  hardening), `GitLocalService` (local git), `ConnectionsService` (OAuth connection store +
  events), `AuthService`, `ActiveGitHubConnectionCache`, `ReposCacheService`,
  `RepoViewTrackerService`.
- **MCP** (`src/services/mcp/`) — central registry + servers (standard tools, run-connection) and
  configs (Playwright). `playwright` + `standard` are required MCPs.
- **Media** — `UploadService`, `MediaProcessingService`, generations tracking.
- **Runtime & monitoring** — `SessionReaperService`, `RuntimeStateService` /
  `RuntimeStateFormatter`, `ProcessTrackerService`, `PortDetectionService`,
  `DevServerMonitorService`, `TunnelService`.
- **DB & secrets** — `SecretsService` + the `LocalSecretsAdapter` (AES-256-GCM `LocalSecretStore`
  under `DATA_DIR`), service-account services.
- **Auth & credentials** — `DeviceTokenService` (local device-token mint/validate),
  `LocalAiCredentialsService` (the user's own Anthropic credential), `LocalGitHubAuthService`
  (GitHub OAuth device flow), `ThemeService`. JWTs and device tokens are validated **locally** —
  there is no remote validation service.

### Database layer (`src/db/`)

A `DbAdapter` interface with swappable backends. **`SqliteDbAdapter`** is the active adapter for
**every** domain — chats + messages, connections, themes, push subscriptions, service accounts +
audit log, and the secrets vault — all on local `bun:sqlite` under `DATA_DIR` (auto-migrates legacy
JSON chat data once). The runtime boots with **no external-database env**; single-user scoping is a
`user_id` filter in every query. **`JsonDbAdapter`** is the deprecated legacy adapter, kept
only as a migration source / rollback.

The default chat source reads the Claude Agent SDK's shared `~/.claude/projects/<slug>/<session>.jsonl`
transcripts, so a session run in the PC terminal `claude` and one run in Portable share the SAME
chats (the chat row + metadata stay in SQLite — hybrid). The legacy SQLite messages table is the
escape hatch via `CHAT_MESSAGE_SOURCE=sqlite`. See [`./CLAUDE.md`](./CLAUDE.md) for the
`ClaudeProjects` index and the fork-on-first-write invariant.

### Tools & MCP

Claude tools live in `src/tools/` (`standard/`). Google Drive / Slack code execution lives in
`src/services/` (`CodeExecutorService`, `RunConnectionService`) and is surfaced through the MCP
servers in `src/services/mcp/` (`RunConnectionMcpServer`). Browser automation uses local
**Playwright** (`@playwright/mcp` with a real local Chromium).

### Execution flow

```
Socket.IO event (SocketIOService)
  → buildExecutionContext()
  → ChatExecutionService.executeMessage()
  → ClaudeService.startClaudeCodeSession()
  → Output adapter: accumulate blocks (always, for persistence)
                    + emit via IOutputEmitter (SocketEmitter | NoOpEmitter)
```

### Auth (local-first)

Each request is gated by a **JWT** (validated locally via `@vgit2/shared/jwt`) **or** a local
**device token** (`DeviceTokenService`: opaque, HMAC-SHA256-signed with a per-install secret, bound
to the owning identity, minted on the PC at QR-link time). The 2-vs-3 dot-part wire format routes
device tokens vs JWTs. Isolation is the single-user PC boundary plus the `user_id` filter on every
query.

## Routes

All routes are mounted under `/auth`, `/api`, `/vibewaiting`, or `/internal/tunnel`. The api route
files (`src/routes/` + `src/routes/subroutes/`) are **thin and delegate to services**. The tables
below are a current reference — the source files are authoritative.

### `/auth` — `routes/auth.routes.ts`

| Method | Path                                                  | Purpose                                                   |
| ------ | ----------------------------------------------------- | --------------------------------------------------------- |
| GET    | `/auth/github`                                        | Start GitHub OAuth (flushes the connection cache first)   |
| GET    | `/auth/github/callback`                               | GitHub OAuth callback                                     |
| POST   | `/auth/github/org-access-url`                         | Generate org-scoped access-request URL                    |
| GET    | `/auth/google` · `/auth/google-drive` · `/auth/gmail` | Google OAuth login                                        |
| GET    | `/auth/google/callback`                               | Google OAuth callback                                     |
| POST   | `/auth/google/disconnect`                             | Disconnect Google                                         |
| GET    | `/auth/slack` · `/auth/slack/callback`                | Slack OAuth login / callback                              |
| POST   | `/auth/slack/disconnect`                              | Disconnect Slack                                          |
| GET    | `/auth/logout`                                        | Session logout                                            |
| POST   | `/auth/update-token`                                  | Update session JWT after a gateway scope upgrade          |
| POST   | `/auth/jwt-logout`                                    | Invalidate the session token                              |
| GET    | `/auth/check-github-permissions`                      | Verify GitHub connection + refresh git credentials        |
| GET    | `/auth/github-app/check-existing`                     | Check existing GitHub App installations                   |
| POST   | `/auth/github/activate`                               | Activate a specific GitHub connection (OAuth or App)      |
| POST   | `/auth/clerk/exchange`                                | Exchange a Clerk session for the internal JWT (local dev) |
| POST   | `/auth/refresh-jwt-with-github`                       | Refresh JWT after a GitHub OAuth/App connection           |
| GET    | `/auth/check-scopes`                                  | Check GitHub token scopes                                 |

### `/api` — `routes/api.routes.ts` + `routes/subroutes/`

- **health** — `GET /api/health`, `/api/heartbeat`, `/api/version`, `/api/min-version`,
  `/api/verify-ownership`.
- **user** — `GET/PUT/DELETE /api/user/theme`; `GET /api/user`, `/api/user/profile`,
  `/api/user/organizations`, `/api/user/recent-branches`.
- **chat** — `GET/POST /api/chats`; `GET/PUT/DELETE /api/chats/:chatId`;
  `GET /api/chats/:chatId/status`; `POST /api/chats/:chatId/summarize`;
  `POST /api/chats/analyze-intent`; `POST /api/chats/suggestions`;
  `GET/POST /api/chats/:chatId/messages`; `GET /api/chats/messages/pending/:chatId`.
- **connections** — `GET/POST /api/connections`; `GET /api/connections/services[/:service]`;
  `GET/DELETE /api/connections/:connectionId`; `POST /api/connections/complete-oauth`;
  `PATCH /api/connections/:connectionId/rename` · `/toggle-active`;
  `GET /api/connections/:connectionId/account-info` (+ `/refresh-account-info`); Fly.io CLI auth;
  `POST /api/update-git-credentials`.
- **repository / projects** — `GET /api/projects/recent`; `POST /api/projects/create[-local]`
  · `/create-from-template`; `GET /api/repos`, `/api/repos/cached`, `/api/repos/refresh`;
  `POST /api/repos/git-status`; `GET /api/repos/:owner/:repo` (+ `/tree/*`, `/raw/*`,
  `/contents/*`, `/file-history/*`, `/branches`, `/issues`); `PUT /api/repos/:owner/:repo/contents/*`
  · `/github-contents/*`; `GET /api/workspace-file`, `/api/uploads/:filename`, `/api/task-output`,
  `/api/quick-actions`; `POST /api/track-repo-view`; `GET/POST/DELETE /api/generations[/:id]`.
- **secrets / vault** — `GET/POST /api/user/secrets`; `POST /api/user/secrets/from-env`;
  `DELETE /api/user/secrets/:secretKey`; `GET/POST /api/secrets/vault`;
  `GET/DELETE /api/secrets/vault/:secretKey`; `GET /api/secrets/vault/search`;
  `POST /api/repos/:owner/:repo/inject-secrets`.
- **storage** — `GET /api/storage/list`, `/api/storage/usage`; `DELETE /api/storage`,
  `/api/storage/bulk`.
- **ai-credentials** (Claude-account sign-in from the phone, portable.dev#18) —
  `GET /api/ai-credentials/status`; `POST /api/ai-credentials/login/start` · `/login/complete`;
  `POST /api/ai-credentials/token` (paste fallback); `DELETE /api/ai-credentials` (sign out).
  Thin delegates over `ClaudeOAuthService`; token values never leave the PC.
- **misc** — `GET/POST /api/user-settings`; `GET /api/config`, `/api/dev-info`;
  `GET /api/mcps/available`; `GET/POST/PUT/DELETE /api/agent-setups[/:id]`;
  push-notification subscribe/unsubscribe; `GET /api/sentry-test`.

### Internal tunnel — `routes/tunnel.routes.ts`

`POST /internal/tunnel/create` · `/destroy`, `GET /internal/tunnel/status` (Cloudflare Quick
Tunnels for exposing a localhost dev-server port from the user's PC).

### Vibewaiting

A separate, unauthenticated `/vibewaiting` group for the in-app game/leaderboard system.

## Development

The api package is driven from the **monorepo root** scripts (see the root `CLAUDE.md` §2) —
`bun run dev` starts the backend for local development. The full local-first runtime is brought up
by the launcher with `portable start` (spawns the api on `127.0.0.1:VGIT_PORT`, owns the cloudflared
tunnel, and registers it with the gateway relay — see [`@vgit2/launcher`](../launcher/CLAUDE.md)).

| Command                        | What it does                                                      |
| ------------------------------ | ----------------------------------------------------------------- |
| `bun run dev` (root)           | Start the backend for local development (AI agents MUST use this) |
| `bun typecheck` (root)         | Type-check all packages                                           |
| `bun test` (in `packages/api`) | Run the api test suite                                            |

## Tests

Tests live in `packages/api/tests/` (integration-first). Read
[`tests/README.md`](./tests/README.md) for the standards, helpers, and mocking strategy. CI runs
them as parallel context-based shards (root `CLAUDE.md` §4.9 "Sharded Test CI"). Per the root rules:
never run tests in the background, always redirect to a file with a timeout, and never write a test
that accepts both success and error status codes.
