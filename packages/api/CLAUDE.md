# CLAUDE.md — `@vgit2/api` (backend)

Rules for Claude Code when working in `packages/api`. These are **in addition** to the
monorepo-wide rules in the [root `CLAUDE.md`](../../CLAUDE.md). For the full route tables,
architecture deep-dive, and the **API vs Gateway** comparison, see [`./README.md`](./README.md).

## What this package is

`@vgit2/api` is the **single-user backend that runs on the user's OWN PC** (one process per
user), spawned by the launcher (`portable start`, `@vgit2/launcher`). It authenticates each
request with a **PC-minted JWT or a local device token** (validated locally — there is no remote
validation service), runs Claude execution with MCP tools, manages the per-user workspace and
connections (GitHub via local OAuth / Google / Slack), and persists every domain on **local
SQLite**. It is **API + Socket.IO only — it serves NO web bundle**; the mobile Expo RN app
(`packages/mobile`) is the only client and reaches it via the gateway's `/t/<pcId>` relay.
Contrast with `@vgit2/gateway`, the public `app.portable.dev` auth + reverse-proxy relay — see
[API vs Gateway](./README.md#api-vs-gateway).

## Architecture map (condensed — full detail in README)

- **`src/server.ts`** — main orchestrator: initializes services (in dependency order, wiring the
  ClaudeService ↔ ChatExecutionService cycle), the Socket.IO server, the session store, and mounts
  the route groups. Handles graceful shutdown. No static file / SPA serving — `setupStaticFiles()`
  only registers a JSON 404 + the global error handler.
- **`src/services/`** — service classes grouped by domain: execution (ClaudeService,
  ChatExecutionService, SocketIOService), chat/data (ChatService), github+repos (GitHubApiService,
  GitLocalService, ConnectionsService, ActiveGitHubConnectionCache, ReposCacheService), MCP
  (`mcp/`), media (Upload/Generations), runtime (SessionReaperService, RuntimeStateService),
  db+secrets, auth (DeviceTokenService, LocalAiCredentialsService, LocalGitHubAuthService). Plus
  `emitters/` (the `IOutputEmitter` abstraction).
- **`src/routes/`** — thin route files that ONLY delegate to services: `auth.routes.ts`,
  `api.routes.ts`, `tunnel.routes.ts`, and `subroutes/` (chat, connections, user, repository,
  secrets, storage, health, dev, tunnel-api, misc). **Endpoint tables live in the README.**
- **`src/db/`** — `DbAdapter` interface. **`SqliteDbAdapter`** is the active adapter for EVERY
  domain (chats, connections, themes, push, service accounts + audit, secrets vault); the runtime
  boots with no external-database env. `JsonDbAdapter` is legacy (migration source only, not wired).
- **`src/tools/`** — Claude tools (`standard/`). Google Drive / Slack execution lives in
  `src/services/` (`CodeExecutorService`, `RunConnectionService`) via `mcp/servers/RunConnectionMcpServer`.
- **`src/middleware/`** — `auth.ts` / `jwtAuth.ts`: local JWT + device-token validation (no remote
  validation service).
- **`src/services/TunnelService.ts` + `src/services/tunnel/`** — on-demand dev-server tunnels for
  the mobile in-chat runtime preview bubble. Single provider: **`QuickTunnelProvider`** (Cloudflare
  Quick Tunnels, dynamic `*.trycloudflare.com`, any port, one `cloudflared` child per tunnel; a
  missing `cloudflared` binary throws a clear install hint). The launcher owns the MAIN cloudflared
  tunnel; this service only handles on-demand dev-server tunnels. Constructed unconditionally.
  Wired consumers: the `create_tunnel`/`show_tunnel` MCP tools, `tunnel.routes.ts`, and the
  `/quick-actions` listing.
  - **⚠️ `DevServerMonitorService`** (port-detect → auto-create tunnel, surfaced via
    `user:runtime_state` for the preview bubble) is currently NOT wired into the stream path —
    `monitorBashOutputForPorts` has no runtime caller (only tests). Until `StreamHandler` calls it
    on Bash `tool_result`s, dev-server tunnels are created only on-demand.
  - **Dead-tunnel resilience** (a `*.trycloudflare.com` dies on PC/dev restart or network loss →
    Cloudflare returns Bad Gateway). Three converging guards keep a dead tunnel from getting stuck
    in the client: **(A) always re-broadcast a FULL snapshot** —
    `RuntimeStateService.getRuntimeStateForBroadcast` returns a well-formed EMPTY snapshot (never
    null) and the broadcasters always emit it, so a reconnect after a restart CLEARS the stale
    tunnel list. **(B) event-driven eviction** — `QuickTunnelProvider.setTunnelExitCallback` fires
    when a cloudflared child EXITS; `TunnelService.handleProviderTunnelExit` drops the dead tunnel +
    re-broadcasts (idempotent). **(C) lazy per-touch repair** — `TunnelService.repairTunnel`
    (authed `POST /api/tunnels/repair`, `routes/subroutes/tunnel-api.routes.ts`) re-creates ONLY
    the touched port: port still listening → fresh tunnel (`{status:'repaired', url}`); port gone →
    clear + `{status:'dev_server_down'}`. The mobile Android embed drives (C) from its WebView load
    error; iOS relies on (A)+(B). Tests:
    `tests/unit/services/{TunnelService,RuntimeStateService}.test.ts`.
- **Tests** — `packages/api/tests/` (read [`tests/README.md`](./tests/README.md) for standards;
  TDD, integration-first). CI sharding is described in the root CLAUDE.md §4.9.

## Key Service Details

- **ChatExecutionService**: Core execution logic for chat messages with Claude, decoupled from
  Socket.IO. Uses the `IOutputEmitter` interface for pluggable output: `SocketEmitter` for
  real-time clients, `NoOpEmitter` for headless execution. Handles session management, system
  prompt generation, block accumulation, and persistence. Persistence ALWAYS happens regardless of
  emitter type.
  - **Workspace as a Claude project + the `tmp` scratch route.** The `WORKSPACE_DIR` is itself a
    Claude project: `ensureWorkspaceScaffold` (`services/workspaceScaffold.ts`, idempotent +
    write-if-absent) drops `<workspace>/CLAUDE.md` and `<workspace>/tmp/CLAUDE.md`. A home-widget
    chat that isn't about a specific repo is routed to the workspace SCRATCH folder:
    `handleChatCreate` recognizes the reserved `__workspace__` owner (`isWorkspaceChatTarget`,
    `@vgit2/shared/browserConstants`) → skips clone/validation and persists a NULL `repo_path`;
    `executeMessage`'s no-repo branch then sets `cwd = getWorkspaceTmpDir()` (`<workspace>/tmp`).
    `tmp` is excluded from `GitLocalService` discovery so it never becomes a project. A
    repo/`new-repo` chat is unchanged (real cwd + its own CLAUDE.md). Tests:
    `tests/unit/services/workspaceScaffold.test.ts` + the `tmp`-skip case in
    `GitLocalService.flat-repo-discovery.test.ts`.
- **SocketIOService**: Room-based messaging (1 chat = 1 room), dual transport (WebSocket +
  polling), multi-device sync, runtime state broadcasting.
- **ClaudeService**: MCP server configuration (Playwright, Google Drive executor, Slack
  executor), streaming message processing, image/video handling. AI calls go **direct** to
  `https://api.anthropic.com` using the user's own credential. GitHub operations use the `gh` CLI
  via the Bash tool (not separate MCP tools).
  - **Required-MCP gate.** `McpService.buildAllMcpServers` throws "Cannot create chat session -
    required MCPs are not available" for any `MCP_REGISTRY` entry with `defaultEnabled:true` that
    fails `checkMcpRequirements`. **`playwright` + `standard` are required.**
  - **Desktop-parity: filesystem config + skills (`settingSources: ['user','project','local']`,
    `skills: 'all'`).** `ExecutionHandler`'s `query()` loads ALL setting tiers: **'user'**
    (`~/.claude/…` — global skills/agents/commands/settings), **'project'** (the cwd repo's
    `.mcp.json`, `.claude/{settings.json,agents,commands,skills}`, CLAUDE.md), and **'local'**
    (`.claude/settings.local.json`) — so a chat matches the DESKTOP Claude Code experience (it runs
    on the USER's own PC, so their config IS the experience). `skills: 'all'` enables every
    discovered skill (the SDK auto-allows the `Skill` tool). `strictMcpConfig` is UNSET, so a repo's
    `.mcp.json` `mcpServers` MERGE with the built-in ones. The api's flag-tier options
    (allowed/`disallowedTools`, the co-author `settings`) still win over filesystem settings. ⚠️
    This loads + **RUNS** user/repo hooks (a `.claude/settings.json` `PreToolUse` hook fires) —
    intended, but a broken/blocking hook can block its tool (must be cross-platform; on Windows
    git-bash provides `bash`). The repo must be reachable at `cwd` (works through the workspace
    junction/clone).
  - **Windows compatibility (local-first runs on the user's own PC).** Several spawn/command paths
    were Unix-only; each is OS-branched so POSIX behaviour is byte-for-byte unchanged and only
    Windows diverges: (1) **`NpxCommandDetector`** uses `where` + `npx.cmd`. (2)
    **`PlaywrightMcpConfig`** resolves `@playwright/mcp`'s `cli.js` to a concrete WORKSPACE path and
    runs `node <cli.js>` — npx is the LAST resort (the npx shim can't be spawned on Windows; under
    Bun `require.resolve` returns a different global-cache version, so the computed
    `packages/api/node_modules/@playwright/mcp/cli.js` is preferred for version-lock). (3)
    **`QuickTunnelProvider`** resolves the cloudflared bin (Windows install dirs /
    `PORTABLE_CLOUDFLARED_BIN`), probes port-liveness via a `net` TCP-connect (POSIX `lsof`), lists
    processes via `tasklist` (POSIX `ps`). (4) **`GitLocalUtils` / `PullRequestHandler`** keep
    `2>/dev/null` + `|| echo` on POSIX, drop them on Windows. (5) **`SOPService`** uses
    `os.tmpdir()` on Windows.
  - **Playwright local mode needs a real Chromium.** `PlaywrightMcpConfig` passes the browser via
    `@playwright/mcp`'s **`--executable-path`** flag (resolved from
    `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` or `require('playwright').chromium.executablePath()`, only
    when the file exists), keeps `--no-sandbox`, and **must NOT** pass raw Chromium flags
    (`--disable-dev-shm-usage`/`--disable-setuid-sandbox`/`--disable-gpu`) — `@playwright/mcp`
    rejects them ("unknown option") and the MCP child crashes. The launcher (`ChromiumProvisioner`)
    installs Chromium and exports the env; a bare `bun run dev` needs a manual
    `playwright install chromium` + `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to pass the gate.
  - **Screenshot/video media (`MediaProcessingService` + `StreamHandler`).** A Playwright
    screenshot / browser recording / `display_video` is emitted as a **SEPARATE** top-level
    `image`/`video` block (in addition to the raw `tool_result`): `processMcpImage` /
    `processScreenshot` → `{type:'image', source:{type:'url', url:'/data/media/<userId>/...webp'}}`
    (or a pass-through base64 when **ffmpeg is absent** — the common local case),
    `processVideoAfterBrowserClose` → `{type:'video', source:{url:'/api/video/...'}}`, and
    `processDisplayVideo` copies the tool's LOCAL file into the served media dir. **These URLs are
    RELATIVE on purpose** — `/data/media/:userId/:filename` is served BEFORE the `/api` JWT
    middleware (PUBLIC); `/api/video/*` is behind it. The mobile client resolves them against the
    relay base (`<gatewayBase>/t/<pcId>`) and adds a `Bearer` for `/api/*` only (see `packages/mobile`
    `mediaSource.resolveAuthedMediaSource`). Do NOT bake an absolute URL server-side. Test:
    `tests/integration/lifecycle/media-processing-lifecycle.test.ts`.
- **DeviceTokenService** (`src/services/DeviceTokenService.ts`): the local-first per-request auth
  gate. `mint(deviceLabel, clerkUserId)` / `validate(token)` / `revoke(tokenId)` / `list()`. Tokens
  are opaque, HMAC-SHA256-signed with a per-install secret held in the **same** `LocalSecretStore`
  as connection creds (namespaced keys `device-token:signing-secret` + `device-token:records`).
  Wire format is deliberately **2 dot-parts** (`base64url(claims).base64url(sig)`) so it never
  collides with a 3-part JWT — that segment count is how `jwtAuth.ts` and `validateSocketAuth` route
  device-tokens vs JWTs. Claims carry `clerkUserId` (owning account, bound at link time) +
  `deviceId`. `validate()` rejects a bad signature, an unknown record, or a revoked token. Injected
  into `createJwtAuthMiddleware` (REST + `?token=` + session) and into
  `AuthService.setDeviceTokenService` (Socket.IO handshake). Shared types live in
  `@vgit2/shared/types` (`deviceToken.ts`).
- **LocalAiCredentialsService** (`src/services/LocalAiCredentialsService.ts`): the AI credential
  resolver. The PC runtime uses the user's OWN Anthropic credential. Two first-class modes: (a)
  `claude-oauth` — a Claude _subscription_ OAuth token persisted in the `LocalSecretStore`
  (namespaced key `ai-credentials:claude-oauth-token`), handed to the Claude Agent SDK / native CLI
  via `CLAUDE_CODE_OAUTH_TOKEN`; or (b) `api-key` — a raw `ANTHROPIC_API_KEY` from local config.
  `resolveCredential()` prefers a configured OAuth token over the API key; `applyToProcessEnv()`
  wires the chosen credential into `process.env` (mutually exclusive) and **clears
  `ANTHROPIC_BASE_URL`** so calls hit the default `https://api.anthropic.com`. Injected into
  `ClaudeService.setLocalAiCredentialsService` → `ExecutionHandler`.
  `ExecutionHandler.determineApiRoutingMode` **always** returns `'direct'` — there is no billing /
  routing proxy.
- **LocalAiHelper** (`src/services/ai/LocalAiHelper.ts`): the auxiliary "AI helper" for short
  one-shot calls. Wraps `LocalAiCredentialsService` and runs a **one-shot, NON-streaming**
  `messages.create` (`@anthropic-ai/sdk`, `MODEL_IDS.haiku`) direct to `https://api.anthropic.com`
  on the user's OWN credential. Branches by mode: `api-key` → `new Anthropic({ apiKey })`;
  `claude-oauth` → `new Anthropic({ authToken, defaultHeaders: { 'anthropic-beta':
'oauth-2025-04-20' } })` **and** leads the system prompt with the Claude Code identity (a
  subscription OAuth token is only accepted for Claude-Code-style requests). API: `isAvailable()` /
  `complete()` / `completeJson<T>()`. Constructed only alongside `LocalAiCredentialsService` in
  `server.ts` and injected into the auxiliary call sites — all of which **degrade gracefully** when
  no credential is configured or the call fails:
  - `IntentAnalysisService.analyzeIntent` → heuristic fallback (`simple-task` + slug) so the
    new-chat / repo-creation flow never hard-fails.
  - `POST /api/generate-project-name` → slug of the description.
  - `SuggestionsService` / `ChatAnalysisService` (summarize) → empty/`null` (non-critical).
  - `ActionHandler` (follow-up action chips) → `[]`.
    > ⚠️ The `claude-oauth` one-shot path is not yet device-verified; `api-key` mode is the proven
    > path. If OAuth one-shots are rejected, fall back to a deterministic path or route through the
    > Agent SDK.
- **Voice — fully ON-DEVICE, NO server route.** Speech→text happens entirely on the phone (native
  on-device STT — see `packages/mobile` "Voice input"); the transcript is inserted client-side with
  no server round-trip. There is intentionally **NO `/api/voice/normalize` route and no
  `TranscriptionService`** — a server-side Claude correction pass was prototyped and removed (the
  only fast path needed an `ANTHROPIC_API_KEY`; a subscription OAuth token 401s on the raw Messages
  API, and the Agent-SDK path was ~11s — too slow for voice). The legacy `POST /api/transcribe`
  returns `501 { code: 'transcription_unavailable' }` (unused). Do NOT reintroduce a server-side
  STT / voice-correction route.
- **LocalGitHubAuthService** (`src/services/LocalGitHubAuthService.ts`): the GitHub access resolver.
  The GitHub token is the user's OWN, obtained on-device via the **OAuth device flow**
  (`requestDeviceCode` → `pollForAccessToken` → `runDeviceFlow`, scopes `repo read:org`) using a
  public OAuth-App client id from local config (`GITHUB_OAUTH_CLIENT_ID`). The token is persisted in
  the **same** `LocalSecretStore` (namespaced key `github-oauth:token`). API: `getToken()` /
  `isConnected()` / `getConnectionStatus()` / `setToken()` / `clear()`; constructor takes injectable
  `fetchImpl`/`sleep` seams for tests. **`ConnectionsService.getActiveGitHubConnection`
  short-circuits to this service** whenever injected (`setLocalGitHubAuthService`): a stored token →
  `{ type: 'oauth', token, connection: synthetic }`; no token → `{ type: 'none' }`. This funnel
  means `GitHubApiService` (Octokit token cache), the scope/permission checks, and `GitLocalService`
  git auth all read the on-device token through the EXISTING path — no per-call-site refactor.
- **SessionReaperService**: Time-based idle reaper for Claude sessions. A multi-turn chat keeps a
  live subprocess BETWEEN turns (idle); once the for-await loop's `finally` runs (turn ended for
  good) only a `session_id` string remains. The reaper (60s interval, `CLAUDE_SESSION_IDLE_TTL_MS`
  default 10 min) `stopSession`s any live session idle past the TTL — freeing the subprocess while
  PRESERVING `session_id` so the next message resumes transparently. Runs **unconditionally** (the
  reclaim is safe: `session_id` preserved → instant resume, the user loses nothing). On reap it
  emits `session:reaped` to the owner and rebroadcasts runtime state. Live sessions are surfaced in
  the runtime panel via `RuntimeStateService` → `UserRuntimeStatePayload.claudeSessions` (+
  `claudeSessionIdleTtlMs`), and a user can `chat:kill-session` (ownership-checked in
  `ChatExecutionService.handleKillSession`) on demand.
- **GitHubApiService** (`src/services/GitHubApiService/`): modular (index.ts + handlers/ + utils/).
  Per-user token cache w/ expiry + shared Octokit built by `utils/octokitFactory` (401 →
  invalidate, refetch, replay once). A 401 NEVER deletes Clerk credentials/session. Factory is
  hardened with `@octokit/plugin-retry` + `plugin-throttling`: 403/429 rate limits retried once
  after retry-after, bounded retry for transient 5xx. The retry plugin option is `doNotRetry` (not
  `doesNotRetry`).
  - **Server-side owner filter (`utils/repoOwnerFilter.ts`).** A user-editable JSON file
    `<DATA_DIR>/repo-filter.json` (e.g. `["*"]` = hide ALL org-owned repos, or `["acme","globex"]` =
    hide those orgs) lets the PC hide repos from the `/api/repos` lists WITHOUT any mobile-app
    change. `RepoHandler.fetchReposWithLocalStatus` applies it (`loadRepoOwnerFilter` +
    `applyRepoOwnerFilter`) AFTER local enrichment, so it covers every list endpoint; **LOCAL repos
    are always exempt**, and personal (`owner.type==='User'`) repos are kept unless explicitly
    listed. Missing/invalid file → no filtering (never throws). Edit the file + **restart `portable
start`** to apply (the repos cache is rebuilt on boot).
  - **Local-repo injection (page 1).** The repos list is GitHub-seeded + paginated, so a repo the
    user has LOCALLY but whose remote `updated_at` is old can be buried past the fetched page and
    never enriched as `isLocal`. On **page 1**, `fetchReposWithLocalStatus` injects a
    `makeLocalRepoStub` for any `gitLocalService.getLocalRepositories(userId)` entry missing from the
    GitHub page; the stub flows through the SAME enrichment and the local-first sort floats it to the
    top. Later pages DROP local repos to avoid double-listing. Local repos are detected via the
    junction/symlink-aware `GitLocalService.getLocalRepositories` (recognizes a Windows junction).
  - **Local-repo detail fallback (`handleGetRepo`).** The repo DETAIL endpoint
    (`GET /api/repos/:owner/:repo`) resolves the on-disk clone FIRST, then: a `local/` owner
    (`LOCAL_PLACEHOLDER_OWNER`, for a `portable link`'d repo with no remote) SKIPS the guaranteed-404
    and serves a `makeLocalRepoStub`; any other owner fetches GitHub but FALLS BACK to the stub when
    it 404s/errors AND the repo is cloned (deleted/renamed remote); only a repo that is NEITHER on
    GitHub NOR on disk surfaces the error. `makeLocalRepoStub` + `LOCAL_PLACEHOLDER_OWNER` live in
    `utils/localRepoStub.ts` (shared by list + detail). Test:
    `tests/unit/services/github-get-repo-flat-clone.test.ts`.
- **ActiveGitHubConnectionCache**: Memoizes `ConnectionsService.getActiveGitHubConnection` (oauth
  12-min TTL; honors `expiresAt − 5-min` buffer; 45s negative cache; in-flight dedup; invalidated
  inline on store/delete/setActive; **ALSO flushed at the start of** `GET /auth/github`). The new
  connection is stored by the **GATEWAY** (separate process — can't reach this in-memory cache), so
  without the flush a stale negative entry made the post-connect `/auth/check-github-permissions`
  return "no connection" until TTL expiry. The post-connect check sends `?refresh=1` →
  `verifyGitHubPermissionsWithRefresh` invalidates before EACH read + briefly retries until the
  connection appears.

### Database adapters (`src/db/`)

`SqliteDbAdapter` is the active adapter for EVERY domain; the runtime boots with **no external-database
env**. It auto-migrates legacy JSON chat data on startup, once, marker-guarded, originals preserved
for recovery. **No RLS anywhere** — single-user scoping is a `user_id` filter in every query.

- **`SqliteChatStore`** — chats+messages, db at `<WORKSPACE_DIR>/.chat-data/chats.sqlite`.
- **`ClaudeProjects/`** (the **DEFAULT** chat source) — sources the chat message STREAM + the chat
  LIST from the SDK's shared `~/.claude/projects/<slug>/<session>.jsonl` transcripts, so a session
  run in the PC terminal `claude` ⇄ portable share the SAME chats. The legacy SQLite messages table
  is the explicit escape hatch `CHAT_MESSAGE_SOURCE=sqlite`. When on (the default),
  `SqliteDbAdapter` is constructed with a `ChatMessageSourceConfig` and routes messages to
  `ClaudeProjectsMessageStore` (reads the JSONL via the pure `transcriptReader`, MERGES an
  `OverlayMessageStore` side stream for portable-only synthesized media/action blocks) and unions
  the chat list with `ClaudeProjectsChatIndex` (discovers transcripts whose `cwd` is/under a
  `getLocalRepositories` repo, reconciled by `session_id`, mtime-cached). The chat ROW + metadata
  stay in SQLite (hybrid). Golden fixture:
  `tests/unit/db/claude-projects-transcript-reader.test.ts`.
  - **`resolveTranscriptKeys` locates the transcript by the REAL `cwd`, not just `repo_path`.** A
    terminal session run in a repo SUBDIR is filed under `slug(cwd)`, but its reconciled SQLite row
    carries `repo_path` = the repo ROOT. So the resolver returns the row's `repo_path`/`session_id`
    ONLY when that transcript file actually EXISTS; otherwise it falls back to discovery keyed by
    `session_id` (which knows the real `cwd`). Without this, reading `slug(repo_root)/<session>.jsonl`
    404s → an EMPTY chat. Regression: the "ROW is the repo ROOT but the session ran in a SUBDIR" case
    in `tests/integration/db/sqlite-adapter-jsonl-mode.test.ts`.
  - **Discovered chats carry `repo_full_name`** (the GitHub `owner/repo` from the git remote) on the
    synthesized row → the chat-list payload's `repoFullName`, so the mobile `ChatCardBody` shows the
    real repo instead of a generic "Workspace" label.
  - **FORK-ON-FIRST-WRITE — never mutate a Claude Code chat's transcript.** Resuming a discovered
    terminal chat with `query({ resume })` would make the SDK CONTINUE-WRITE the source
    `<session>.jsonl` (clobbering it if also open in a terminal `claude`). Instead, the FIRST
    Portable write to a CC-originated chat FORKS it. `forkDiscoveredChatIfNeeded` detects origin via
    `dbAdapter.getChatOrigin(chatId)` (`'sqlite'` / `'discovered'` / `'none'`), mints a NEW Portable
    chatId, and claims a real row carrying `fork_source_session_id` (+ `repo_path` = the source's
    real `cwd`, `repo_full_name`) with `session_id` still null. It emits `chat:created` +
    `chat:forked` (the mobile client navigates) and joins the new room. The guard runs at TWO points
    and is IDEMPOTENT (a no-op once a real row exists): **(1)** `handleChatMessage` forks BEFORE the
    optimistic echo so they retarget to the new id; **(2)** `executeMessage` — the SINGLE execution
    chokepoint — forks as a durability net for the non-interactive `portable_execute` cross-chat
    send. `startNewSession` reads the claimed row and, when `session_id == null &&
fork_source_session_id != null`, passes `forkFromSessionId` → `ExecutionHandler` runs
    `query({ resume: <source>, forkSession: true })` (CLI `--fork-session`): the SDK READS the source
    history but mints a NEW session id/file, so the original `.jsonl` is **never** touched. The
    original CC chat STILL lists as its own (untouched) discovered card. Tests:
    `tests/unit/services/chat-fork-on-first-write.test.ts`,
    `tests/integration/lifecycle/execution-handler-fork.test.ts`,
    `tests/integration/db/sqlite-adapter-jsonl-mode.test.ts`.
- **`SqliteConnectionStore`** — connection METADATA, db at `<DATA_DIR>/connections.sqlite` (same
  root as the LocalSecretStore). Credentials live encrypted in the LocalSecretStore; the metadata
  row holds an empty `{}`. ⚠️ **bun:sqlite `.get()` returns `null` (not `undefined`) for no row** —
  use `!= null` / falsy checks, never `!== undefined`.
- **`SqliteThemeStore`** — user themes, db at `<DATA_DIR>/themes.sqlite`. One `user_themes` row per
  `user_id` (`INSERT … ON CONFLICT(user_id) DO UPDATE`); `theme_config` is JSON text.
- **`SqlitePushStore`** — push subscriptions, db at `<DATA_DIR>/push-subscriptions.sqlite`.
  **Multi-device**: composite PK `(user_id, endpoint)`; `device_info` + `notification_settings` are
  JSON text. `savePushSubscription` does NOT touch `notification_settings` on conflict (a
  re-register never clobbers settings); `updateNotificationSettings` merges and writes to ALL of the
  user's device rows.
- **`SqliteServiceAccountStore`** — service accounts + audit log, db at
  `<DATA_DIR>/service-accounts.sqlite`. ONE store holds BOTH the `service_accounts` and
  `service_account_audit_log` tables. `token_encrypted`, `allowed_user_ids`, audit `details`
  round-trip as JSON text; `enabled`/`success` are `INTEGER` booleans. Audit-log `id` is
  `crypto.randomUUID()`; `created_at`/`updated_at` stamped at write time.
- **`SqliteSecretsVaultStore`** — the saved-secrets vault ("save and reuse" env vars), db at
  `<DATA_DIR>/secrets-vault.sqlite`. One row per `(user_id, key)`. Values arrive **already
  encrypted** from `SecretsService`, so the store only persists the opaque `value_encrypted` blob.
  `searchSecrets` does a case-insensitive `LIKE` (wildcards escaped) top-10. Surfaced via
  **`LocalSecretsVaultAdapter`** (`db/LocalSecretsVaultAdapter.ts`, lazy-inits the store).

> **`bun:sqlite` typing.** The repo has no `@types/bun` (adding it globally breaks `db.query<T>`
> and conflicts `fetch` with `@types/node`). Instead a narrow ambient shim at
> `src/types/bun-sqlite.d.ts` declares exactly the `Database`/`Statement` slice the SQLite stores
> use. Extend the shim if a store starts using more of the API.

### Secrets adapters (`src/db/*SecretsAdapter`)

`ConnectionsService` stores connection credentials through a `SecretsAdapter`. **LocalSecretsAdapter**
is the only adapter: credentials are encrypted at rest in a **`LocalSecretStore`**
(`@vgit2/shared/secrets`, AES-256-GCM, per-install key under `DATA_DIR` = `$PORTABLE_DATA_DIR` /
`$XDG_DATA_HOME/portable` / `~/.portable`). Connection metadata still goes to the DbAdapter;
`storeConnection` writes an EMPTY `{}` credentials object to metadata so plaintext secrets never
land in a row or reach the client. The same `LocalSecretStore` also holds the device-token signing
secret, the GitHub OAuth token, and the Claude subscription OAuth token — all under namespaced keys,
ONE store instance. The saved-secrets **vault** (`SecretsVaultAdapter`, used by `SecretsService`)
uses **`LocalSecretsVaultAdapter`** (SQLite under DATA_DIR).

## Chat Execution Architecture

**Philosophy**: Single execution path for all chat messages, regardless of transport.

```
Socket.IO Event Handler (SocketIOService)
  ↓
buildExecutionContext()
  ↓
ChatExecutionService.executeMessage()
  ↓
createOutputAdapter()
  ↓
ClaudeService.startClaudeCodeSession()
  ↓
Output Adapter
  ├─ Accumulates blocks (ALWAYS - for persistence)
  └─ Emits to clients via IOutputEmitter
      ├─ SocketEmitter (real-time Socket.IO broadcasts)
      └─ NoOpEmitter (headless)
```

### Room-Based Messaging Model

- Each chat has a unique room ID (e.g., `chat-xxx` or `repo-xxx-yyy`).
- Users join rooms explicitly via the `chat:join` event.
- Messages broadcast to all sockets in the room (multi-device sync).
- Users can be in multiple rooms simultaneously.
- Room membership persists until disconnect (no explicit leave event).
- Never `io.to('user:...')` a room nobody joins — use `getUserSockets`.

## Outdated-client notice

A reach-back net for **pre-handshake native RN builds** too old for any client-side version gate.
The chat message stream is the one surface every build renders, so the backend blocks the Claude run
and returns an ephemeral "update your app" message instead.

- **Handshake field.** Up-to-date clients report their build version in `handshake.auth.appVersion`
  (native RN from `Constants.expoConfig.version`). `SocketIOService.setupAuth` stores it on
  `socket.data.appVersion`; `buildExecutionContext` threads it onto `ExecutionContext`. Only
  pre-handshake builds send nothing.
- **Block on send — ABSENCE-only, BLOCKING.** `ChatExecutionService.isOutdatedNativeClient` =
  `!appVersion` (no version comparison). Only the socket `chat:message` handler calls
  `shouldBlockOutdatedClient` (headless `executeMessage` is never gated): BEFORE `handleChatMessage`
  (so nothing persists), it emits `emitOutdatedClientNotice` (a `claude:stream` text block with
  `OUTDATED_APP_MESSAGE` + `claude:status: completed`) → `callback({success:true})` → return.
  Claude never runs.
- **Kill switch (`VERIFY_HANDSHAKE`).** `shouldBlockOutdatedClient` = `isOutdatedNativeClient(ctx)`
  AND `HandshakeVerificationGate.isEnabled()`. The gate fetches `GET
${GATEWAY_URL}/api/verify-handshake` (reports the gateway's `VERIFY_HANDSHAKE` env, **default
  `false`**), cached ~60s and **fail-open** (any error / unset `GATEWAY_URL` → never block). The
  cheap synchronous check runs first, so up-to-date clients never touch the network.
- **Ephemeral.** The notice is emitted only — never `bufferMessage`'d — so it is NOT persisted, NOT
  fed to Claude, and does NOT advance the read cursor (fresh `randomUUID` blockId per emit).
- **⚠️ New-client contract.** Because the gate is pure `appVersion`-absence, ANY new Socket.IO
  client that emits `chat:message` MUST send `auth.appVersion` in its handshake before
  `VERIFY_HANDSHAKE` is enabled in that environment, or it will be hard-blocked.
- Tests: `tests/unit/services/chat-session-lifecycle.test.ts`,
  `tests/unit/services/handshake-verification-gate.test.ts`. Constant:
  `src/constants/outdatedClient.ts`; gate: `src/services/HandshakeVerificationGate.ts`; gateway
  route + env flag: `packages/gateway/src/routes/version.ts` (`/api/verify-handshake`).

## Backend Don'ts

- **Add business logic to routes** — routes should ONLY delegate to services.
- **Mix responsibilities in services** — each service has ONE clear purpose.
- **Skip dependency injection** — always pass services via constructor.
- **Create monolithic services** — break large services into smaller ones.
- **Put client/UI code in `api/src/services`** — the api is backend-only; the client lives in
  `packages/mobile` (Expo RN).
- **Use CommonJS `require()`** — always use ESM `import` at top of file (inline `require()` breaks
  in production).
- **Share Octokit instances** — per-user tokens via `AuthService.getUserOctokit()`.
- **Read `process.env` directly in shared constants** — dotenv must load first (see shared package).
- **Modify `server.ts` for new features** — add services or extend existing ones instead.
- **Assume `ToolsService` exists** — GitHub tools are not separate MCP tools (use `gh` CLI via Bash).
- **Pull AI credentials from the JWT or any billing proxy** — AI calls are **always direct** to
  `https://api.anthropic.com` using the user's OWN credential resolved by `LocalAiCredentialsService`
  (Claude OAuth or `ANTHROPIC_API_KEY`). `ExecutionHandler.determineApiRoutingMode()` always returns
  `'direct'`.
- **Reach for a remote JWT-validation service** — the PC validates JWTs locally via
  `@vgit2/shared/jwt` (`verifyAuthToken`) and device tokens via `DeviceTokenService`.
- **Return untyped API responses** (CRITICAL) — ALWAYS import response types from
  `@vgit2/shared/types` and declare typed responses before `res.json()` so the compiler enforces
  response structure.
- **Reintroduce a deployment-mode / sandbox switch** — the runtime is **always local-first** (the
  api runs on the user's own PC). There is no `isSandboxMode()` / deployment-mode machinery and no
  branching on "sandbox vs local". `SessionReaperService` runs unconditionally (its reclaim is safe
  — `session_id` preserved → instant resume).

## Prod runtime note

The server runs **Bun** (`bun src/server.ts`) — `bun:sqlite` is available, assume Bun semantics.
