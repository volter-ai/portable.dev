# packages/mobile — Native Expo React Native app

The mobile client for Portable. **Expo SDK 56 + Expo Router + TypeScript strict.**
Consumes `@vgit2/shared` via `workspace:*`. This is the only client — the user signs in
with Clerk, scans a pairing QR to connect to their PC, and works against the PC's backend
over the gateway relay.

## Stack

- **Expo SDK 56** (`expo ~56.0.9`), React 19.2.3, React Native 0.85.3 (New Architecture).
- **Expo Router** file-based routes under `app/`. Route files are thin shells that delegate
  to feature screens in `src/features/<name>/` — keep logic out of routes.
- **TanStack Query** for server state, **Zustand + persist** for client state. Secrets →
  `expo-secure-store`; cache/drafts → MMKV (`react-native-mmkv`). **Never** put JWTs/secrets
  in plain AsyncStorage.
- Native modules in use: mmkv/nitro, pdf, webview, reanimated/worklets, gesture-handler,
  camera, secure-store, audio, clerk-expo, firebase-messaging. **Cannot run in Expo Go** —
  needs a custom dev client (`expo run:*` / EAS).

## React version isolation

The web app (deleted) used React 18; this app uses React 19. Several deps peer-depend on
React 18's type tree (clerk-expo, `@sentry/react-native`'s `ErrorBoundary`), so a direct
pass-through fails `tsc` (React 19's `ReactNode` adds `bigint`). The fix is to re-type the
component to a React-19 `FC`/`ComponentType` once (`ClerkAuthProvider`,
`sentryErrorBoundary.ts`). Never `import from '@clerk/types'` — it's nested under
`@clerk/clerk-expo`, not at this package's resolution root (`TS2307`).

## Bun monorepo Jest/Metro gotchas (don't re-derive)

- **Jest `transformIgnorePatterns` must be Bun-store-aware.** Bun installs deps at
  `node_modules/.bun/<pkg>@<ver>+<hash>/node_modules/<pkg>`, so the stock RN pattern skips
  Babel and Jest dies with "Cannot use import statement outside a module". `jest.config.js`
  uses a `(?:.*/)?` depth prefix so the allow-list matches at any depth — add new RN/Expo
  scopes to that allow-list, not a second pattern.
- **`__DEV__` must be `false` in Jest** (`jest.setup.js`). jest-expo defaults it true, which
  makes Expo's `messageSocket.native` open a Metro dev websocket at import and crash.
- **Babel deps are declared explicitly** in `package.json` (`babel-preset-expo`,
  `@babel/runtime`) — Bun doesn't hoist them where Babel/Jest resolve them.
- **Metro needs the monorepo config** (`metro.config.js`): `watchFolders` includes the repo
  root + `packages/shared`; `resolver.nodeModulesPaths` = app then root;
  `unstable_enableSymlinks = true`.
- **`.js`→`.ts` mapping for `@vgit2/shared` (bundler + Jest).** `@vgit2/shared` is
  untranspiled TS using NodeNext `.js` ESM specifiers (`export * from './events.js'`) that
  point at `.ts` source. Metro can't resolve the literal `./events.js`, so `metro.config.js`
  sets a `resolver.resolveRequest` that strips `.js` and re-resolves via `sourceExts`, scoped
  to `@vgit2/shared` origins. Jest mirrors it with two `moduleNameMapper` entries:
  `'^(\\.{1,2}/.*)\\.js$': '$1'` and `'^@babel/runtime/(.*)$': '<rootDir>/node_modules/@babel/runtime/$1'`.
  This is **bundler-only** — `tsc`/Jest pass without the Metro half, so the gap is invisible
  until you run Metro. **Always run `bunx expo export` — not just `tsc`/Jest — before
  declaring a shared-import change (or any reanimated change) done.**
- **Importing from `@vgit2/shared`:** the bare entry loads `dotenv` (Node-only) — do **not**
  import it in RN. Use framework-free submodules (`/browserConstants`, `/models`,
  `/permissions`, `/types`, `/socket`, `/cors`, `/sandbox`, `/aiStyles`, `/projectPrompts`,
  `/utils/*`, …). A new submodule MUST be added to the `exports` map in
  `packages/shared/package.json` or the subpath won't resolve.
- **`@vgit2/shared/socket`** is the transport-agnostic Socket.IO core (event catalog,
  `createSocket`, emitters, `consolidateToolMessages`/`isSequentialDuplicate`). The wire
  protocol lives there, never inline at a call site. `createSocket` imports
  `socket.io-client` (a this-package dep).
- **The reanimated mock trap.** The official `react-native-reanimated/mock` is unusable
  under jest-expo (it imports the real `./index`, which inits worklets native at module-load
  and throws). Reanimated is mocked with a hand-rolled stub `src/test/reanimatedMock.js` via
  `jest.config.js` `moduleNameMapper`. The stub must cover the shared-value surface
  (`useSharedValue`/`useAnimatedStyle`/`withTiming`/`Animated.View`) AND the bits
  gesture-handler's `GestureDetector` reaches (`useEvent`, `setGestureState`,
  `default.createAnimatedComponent`). **All animation in the app is shared-value-driven — NO
  reanimated layout-entering builders** (`entering=`/`exiting=`/`layout=`), because the stub
  doesn't cover them. **`expo-router/testing-library` self-mocks reanimated to `{}` at import
  time**, which beats `moduleNameMapper`. Fix in any `renderRouter` test that mounts a
  reanimated consumer (chat directory, active chat, onboarding-style screens): **import the
  feature first** (`import '../src/features/chat'`) BEFORE `expo-router/testing-library`, so
  the consumer captures the working stub.
- **The clerk-expo Jest hang.** The real `@clerk/clerk-expo` import leaves async handles open
  and hangs Jest, so any test that mounts `_layout` must `jest.mock('@clerk/clerk-expo', …)`
  to a passthrough. Don't pull clerk-expo into a graph that other tests import (e.g. the chat
  barrel) — the Home profile pill reads identity from `authStore`, not clerk, for this reason.
- **Native-module lazy-require pattern.** A device-only native dep used by a testable
  component is isolated in its own file and pulled in via a **render/call-time `require()`**
  (NOT `React.lazy`/`import()` — jest-expo's dynamic `import()` throws and react-test-renderer
  19 crashes on lazy/Suspense). Examples: `expo-camera` in `QrCameraScanner` /
  `CameraCapture`, `react-native-pdf` in `PdfViewer` (`loadPdfViewer`), `expo-video`/
  `expo-audio` in the media file viewers, `react-native-purchases`-free, `expo-speech-recognition`
  in `nativeSpeechRecognizer.ts`, `react-native-webview`/`expo-web-browser` in `SandboxWebView`,
  firebase-messaging in `pushAdapter.ts`. So importing the parent (or the chat barrel that
  re-exports it) never pulls the native module into the Jest/Metro graph; a test that exercises
  the feature `jest.mock`s the module.
- **`react-native-mmkv` v4 is a nitro module.** The API is the `createMMKV({ id })` FACTORY
  (not `new MMKV`); methods are `set`/`getString`/`remove`/`clearAll`. The instance is created
  lazily in `getMmkv()` so a Jest mock installs before any constructor runs. **Any test that
  mounts (or transitively imports) a `useAppTheme`/themeStore consumer MUST
  `jest.mock('react-native-mmkv', …)`** (in-memory `{ __store, createMMKV, MMKV }`) or Jest
  dies with `Failed to get NitroModules`.
- **Globally mocked in `jest.setup.js`** (native modules that the full `AppShell` ladder
  touches at module scope): `expo-image`, `expo-notifications`, `@react-native-firebase/messaging`,
  `expo-linking`, `@sentry/react-native`, `expo-video`. A test that DRIVES one declares its
  own per-file `jest.mock` to override.

## Test harness (`src/test/`)

Two mock layers interpose at the exact boundary the real client uses, so a screen mounts under
React Native Testing Library with no device/Metro/network. Import from `../src/test`.

- **HTTP — `createMockGateway(opts?)`** (`mockGateway.ts`). Routes by `METHOD relativePath`
  (query string included — register sandbox/relay endpoints by **FULL URL**). Interpose via
  `gateway.fetchImpl` (DI into `new GatewayClient`/`RelayApiClient`) or `gateway.install()` /
  `gateway.restore()` (swap `global.fetch`). Per-test override with `gateway.on(method, path,
handler)`. Every request recorded on `gateway.requests`.
- **Socket.IO — `createSocketIoMock(opts?)`** (`mockSocket.ts`). Back the virtual
  `socket.io-client` mock so `io()` returns a recording socket:
  `jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), { virtual: true })`,
  read via `jest.requireMock`. Drive server→client with
  `m.__controller.emitServerEvent(EVENT, payload)` (wrap in `act`); read client emits on
  `__controller.emissions`; `setConnected(true/false)` flips `connected` AND fires the event.
- **`createMockSse`** for the EventSource-style flows.
- Socket build is async (awaits token+url) → flush with a couple `await Promise.resolve()`
  rounds, then `controller.setConnected(true)` before the join/emit fires.
- **Teardown:** ApiProvider/QueryClient-mounting suites MUST `queryClient.clear()` +
  `onlineManager.setOnline(true)` in `afterEach` (the `onlineManager` shared singleton leaks
  open handles otherwise). jest-expo distributes files across workers by cached timing, so a
  cluster of socket/api/voice suites can red on a hostile schedule but pass in isolation — the
  full `cd packages/mobile && bun run test` is the source of truth; re-run rather than dropping
  to `--runInBand` (which serializes `onlineManager` and makes it worse).

## Gateway routes & client (`/auth/mobile/react-native/*`)

The RN client talks to the gateway through namespaced routes mounted at
`/auth/mobile/react-native`. **Header/Bearer only — no cookies ever** (`GatewayClient` always
uses `credentials: 'omit'`). Wire types are single-source in `@vgit2/shared/types`
(`MobileRn*`). RN client: `src/services/gatewayClient.ts` (`GatewayClient`), injectable
`fetchImpl`.

| Route                     | Auth                      | Purpose                                                             |
| ------------------------- | ------------------------- | ------------------------------------------------------------------- |
| `POST /clerk-exchange`    | Clerk session JWT in body | Mints the identity authToken (decode `sid` → `sessions.getSession`) |
| `POST /refresh`           | Bearer                    | Renew the sliding-72h JWT (`renewAuthToken` + blacklist)            |
| `POST /scope-upgrade-url` | Bearer                    | GitHub scope-upgrade URL                                            |
| `GET /me`                 | Bearer                    | Identity preflight                                                  |
| `POST /utm`               | Bearer                    | UTM attribution → verified-signup mark (see below)                  |
| `GET /config`             | public                    | Startup config (no secrets)                                         |

Plus the non-namespaced `GatewayClient` calls via `send(fullUrl)` (`getMinVersion` →
`GET /api/min-version-v2`, `deleteAccount` → `DELETE /auth/account`, `saveTheme`).

## Gate ladder + providers (`src/features/shell/`)

`AppShell` (`AppShell.tsx`) wraps the authenticated tree in this ladder (outermost → innermost):

**VersionGate** → **StartupGate** (Clerk sign-in) → **PcConnectGateHost** (QR pairing) →
**SandboxSessionBoundary** (epoch-keyed remount + recovery) → **StartupHealthGate** →
**ApiProvider** + **SocketProvider** → **SessionReadyLayer** (the PC-health monitor wired to
the recovery handler).

Every gate's I/O is an injectable prop so a router-level test (`app-shell.test.tsx`) drives the
whole ladder with mocked HTTP/socket/health/PC-connect and no native modules.

Render-null mounts that `AppShell` adds INSIDE `ApiProvider` (the `ThemeSync` precedent):
`ThemeSync`, `ChatListSync`, `StoreReviewTracker`, `PushSetupLayer`, `UtmAttributionSync`,
`ActivityIndicatorSync`. Each is gated behind an injectable `AppShell` seam.

- **`PcConnectGateHost`** checks `getConnectedPcId()` once on mount: a persisted pcId →
  render children; none → mount `PcConnectGate` (landing → scanner). A successful `onConnect`
  flips to children. It subscribes to `pcConnectionStore.disconnectSignal` and flips back to
  the connect gate when it changes (that's how Runtime's "Disconnect" returns to the connect
  landing). It reacts to a CHANGE (`useRef` guard), not a non-zero value, so a host remount
  never spuriously re-opens the gate.

### Sign-in / sign-out

`app/sign-in.tsx` → native Clerk sign-in → `onAuthenticated(token)` →
`exchangeClerkSession` (persists the minted authToken to SecureStore, mirrors non-secret
identity into `authStore`) → `router.replace('/')`. Sign-out (`settings-sign-out`) clears the
authToken + connection state + Clerk session and routes to `/sign-in`.

### Routing — the `(app)` route group

`app/_layout.tsx` keeps `ClerkAuthProvider` + `SafeAreaProvider` + `GestureHandlerRootView`,
then mounts the root `<Stack>` **unconditionally** with three top-level entries: `/sign-in`,
`/sso-callback`, and the authenticated `app/(app)/` group (whose `_layout.tsx` mounts
`<AppShell><Stack/></AppShell>`). Because `(app)` is a route group, URLs are unchanged (`/`,
`/chat/:id`, `/repos/:owner/:repo`, …). Sign-in + `sso-callback` are SIBLINGS of `(app)` (not
under the gate ladder), so the StartupGate's `<Redirect href="/sign-in">` resolves without a
loop, and an authenticated screen can never render outside `ApiProvider`.

- **`/sso-callback`** (`app/sso-callback.tsx`) is the Clerk native-SSO auth-session callback
  target (`redirectUrl: Linking.createURL('/sso-callback')`). On Android the Chrome-Custom-Tabs
  redirect arrives as a real deep link Expo Router navigates to — without this route Expo Router
  flashed "Unmatched Route" during the post-OAuth exchange. It owns no navigation (just a branded
  loading screen); the sign-in flow's `router.replace('/')` hands off. **Do NOT delete it** —
  it looks unused but the redirect URL targets it.

### Version-update prompt (`src/features/version-update/`)

Outermost gate — but it **never hard-blocks** (#1522). On cold start, if this build's
`Constants.expoConfig?.version` is below the gateway minimum (`GET /api/min-version-v2`), the
app renders normally UNDERNEATH a dismissible bank-style `UpdateAvailableCard` (whale mark +
**Update** → `Linking.openURL` to the App Store / Play Store + **Later** → dismiss; Android
back = Later). A "Later" persists a 24h snooze in the MMKV leaf `updatePromptStore`
(`shouldShowUpdatePrompt`; device-level state, preserved by `forceSignOut` like
`usageTrackingStore`), after which the card may reappear on a later cold start.
`meetsMinimumVersion` compares **major.minor only** (patches are backwards-compatible);
unparseable → **fail open** (an app ahead of the gateway never sees the prompt).
`runVersionGate` does 3 attempts with backoff, **fails open** on any error/timeout (the
`update-required` verdict name is historical — it now means "a newer version is available").
Runs on every cold start, no resume re-check. The show/snooze decision is **latched once**
when the verdict resolves (a `useState` set in `VersionGate`, NOT re-derived from the live
`Date.now()` each render) — VersionGate re-renders on ordinary navigation, so a per-render
clock check would pop the modal mid-task the moment a snooze elapsed; latching confines
reappearance to cold starts. A "Later" both persists the 24h snooze AND hides the card for the
rest of the session. Known minor: a signed-out, below-minimum cold start briefly flashes the
card before `StartupGate` redirects to `/sign-in` (the card re-presents correctly after
sign-in) — accepted rather than coupling `VersionGate` to the auth gate.

## QR pairing + relay connection (`src/features/pc-connect/`)

The local-first connection model: after Clerk sign-in the device scans a pairing QR carrying
`{ gatewayBase, pcId, token }` (the `token` is a PC-minted JWT). The app talks to the stable
relay endpoint `<gatewayBase>/t/<pcId>`; the gateway reverse-proxies it to the PC's current
cloudflared tunnel (re-pointed by `pcId`), so the app never holds a rotating URL — a transport
drop is a silent reconnect, no re-scan. All I/O is seam-injected and RNTL-testable.

- **`PcConnectGate`** is **landing-first**: after sign-in (or a Runtime "Disconnect") it shows
  `PcConnectLanding` ("Connect your PC" intro + the `portable start` → scan steps), and only on
  the "Scan QR code" tap mounts the `QRScannerGate` camera (so the OS camera permission prompt
  is never hit without an explicit tap). `QRScannerGate` is **scan-only** (no manual-entry
  field). A valid scan runs `parseQrPayload` (validates `{ gatewayBase(http(s)), pcId, token }`)
  and bubbles up via `onPayload`.
- **`linkPc(input)`** is **save-only**: persists the JWT via `saveDeviceToken(pcId, token)` (the
  per-PC credential store, `expo-secure-store`, keyed by sanitized pcId). No gateway round-trip.
- **`verifyTunnelAddress(gatewayBase, pcId, token)`** is a two-step probe (both Bearer, cookies
  omitted): (1) **liveness** — `GET .../api/health` returns true only for 2xx + JSON
  `{ status: 'ok' }` via the shared `isHealthyHealthResponse` (a dead tunnel's 200-HTML edge →
  false); (2) **token-validity fail-fast** — because `/api/health` is a public PC route, it also
  probes the authed `GET .../api/user-settings`: a 401/403 means the PC rejected the token (e.g.
  a `JWT_SECRET` mismatch) → false, surfacing a bad token at pairing instead of a broken home.
  Other authed outcomes are not rejections.
- **`connectToPc(pcId)`** reuses a stored JWT (no QR): reads `getDeviceToken(pcId)`, gates on
  `verifyTunnelAddress`, returns `{ ready, deviceToken, reason? }` (`no-token` / `unhealthy` /
  `ready`). On `ready` it persists the connected pcId (`connectedPcStore`) — that IS "point the
  app at the PC"; switching PCs = `connectToPc(otherPcId)`.
- **`resolveDataPathToken()`** (`dataPathToken.ts`) is the single funnel for the credential every
  relay request carries: the connected PC's stored JWT. Wired into the three relay consumers — the
  Socket.IO handshake (`useNativeSocket.buildSocket`), `RelayApiClient` (`ApiProvider`), and the
  file-viewer raw-bytes Bearer — each importing it BY FILE (not the pc-connect barrel) so the heavy
  scanner graph stays out. **`authedFetch` honors `X-Renewed-Token`** from the relay (persists the
  renewed JWT per pcId) and skips `/refresh` on the relay path (the PC has no `/refresh` endpoint).
- **`PcConnectModal`** is the in-app **re-scan** flow (camera-first — the user already tapped
  "Connect PC"). It backs the Home/Repos error cards (`home-connect-pc` / `repo-list-connect-pc` —
  a failed connection is the PC, not GitHub; in local-first GitHub lives on the PC) and the
  always-on Settings → "Connect PC" entry. Its optional `onCancel` seam (distinct from the
  success `onDismiss`) lets the recovery screen wire cancel → `disconnectPc`.
- **Disconnect (`pcConnectionStore.ts` + `disconnectPc.ts`).** `disconnectPc(deps?)` clears the
  stored pcId + per-PC JWT BEFORE bumping `disconnectSignal` (clear-before-signal so an immediate
  re-scan isn't wiped by a late clear); best-effort, all I/O injectable. The credential-wipe core
  is `clearPcPairing(deps?)` (same clears, no signal) — what the "Can't reach your PC" re-scan runs
  first to drop a rejected pairing. Runtime's "Disconnect PC" calls `disconnectPc`. This is the
  OPPOSITE of `sandboxSessionStore.requestReprovision()`, which PRESERVES the pairing and bumps the
  epoch below the host (see PC-session recovery).

## PC-session recovery (`src/features/health/`)

Detects a dead PC backend and brings the user back onto a fresh PC session without a sign-in
round-trip, by remounting the authenticated subtree (epoch bump) — the connected PC + its JWT are
preserved (a connection drop ≠ a dead credential).

- **Steady-state health monitor** (`useSandboxHealthMonitor.ts` + the framework-free
  `SandboxHealthMonitor` in `@vgit2/shared/sandbox`). Polls `GET <relay>/api/health` every 5s and
  trips a ConnectionFailed signal after **90s of continuous, network-connected failure**. A check
  counts healthy ONLY for the real JSON body (`isHealthyHealthResponse`: 2xx + `{ status: 'ok' }`).
  The 90s accumulator only counts wall-clock while `networkConnected`: going offline or
  backgrounding **freezes** (banks the segment); `reset()` (a fresh foreground, a new connection
  URL) is the only thing that clears it. NetInfo → `setNetworkConnected` (only explicit
  `isConnected === false` is offline); AppState background → freeze, active → reset + fresh 90s.
- **`SandboxSessionBoundary`** sits just below `PcConnectGateHost` (so the connection SURVIVES a
  death) and owns what must survive a re-provision: the death handler
  (`useSandboxDeathHandler` — `RecoveryLoopGuard` 3-per-5-min window + the terminal
  `ConnectionFailedScreen`) and the `<Fragment key={epoch}>` remount line. Every death signal
  funnels into one context handler (`useSandboxDeath()`): the health monitor's
  `onSandboxDead`/`onReprovisionNeeded`, the `system:idle_shutdown`/`session:expired` socket
  hand-off, and `StartupHealthGate`'s boot exhaustion.
- **`useSandboxSessionStore`** (`sandboxSessionStore.ts`, in-memory). `requestReprovision()` is the
  single death transition: set `reprovisioning` synchronously (mutes further death signals) →
  clear the connection URL + authStore mirror → reset the health stores → bump `epoch` LAST.
  Everything below unmounts (the socket's io manager stops, all in-memory stores reset) and
  remounts through `StartupHealthGate` against the SAME stable relay endpoint, like a cold start.
  Single-flight; the authToken + identity + Clerk session are preserved. An exhausted guard window
  → the boundary replaces the subtree with `ConnectionFailedScreen` ("Try again" resets the window
  and re-provisions). `ConnectionFailedScreen` owns the `pc-down` "Connect PC" re-scan exit (it
  sits below `StartupHealthGate`, so the normal Home/Settings entries are unreachable while stuck);
  its re-scan runs `clearPcPairing()` first so a rejected JWT is never reused.
- **Cold-start health check** (`startupHealthCheck.ts`). On boot the PC may be mid-tunnel-rotation,
  so this polls `GET <relay>/api/health` on a short front-loaded backoff (`[0.5,1,2,3,5]s`, 6
  attempts, ~11.5s). The PC api is already up by pairing time (the launcher waits for
  `/api/health` before showing the QR), so the only legitimate boot miss is a few-second tunnel
  re-point; if it isn't answering within that window the PC is genuinely down. Resolves on the
  first real health body; aborts on unmount (never flips to `failed`). `StartupHealthGate` shows a
  spinner while checking, children when ready, and on exhaustion fires `onUnhealthy` → the
  boundary's death handler (re-provision instead of dead-ending).

## API client + dual base URL (`src/features/api/`)

The single authed TanStack Query layer every `/api/*` call goes through. Two backends:

- **Gateway** (fixed, `getGatewayUrl()`, build-time `EXPO_PUBLIC_GATEWAY_URL`) — reached only via
  `GatewayClient` ABSOLUTE URLs (`/me`, `/refresh`, scope-upgrade).
- **Relay** (the per-PC endpoint `<gatewayBase>/t/<pcId>`, `getRelayUrl()` in `relayUrlStore.ts`,
  derived from `getConnectedPcId()` + `getGatewayUrl()`). **EVERY** relative `/api/*` path + the
  Socket.IO handshake routes here (`GATEWAY_PATH_PREFIXES` is empty — `targetForPath`).

`baseUrls.ts` is the single source for both readers; `BaseUrlResolver` holds NO cached URL
(re-reads its source on every call — the no-stale-cache guarantee). `EXPO_PUBLIC_GATEWAY_URL` has
exactly one reader (`getGatewayUrl`/`resolveGatewayUrl`) and the relay key one (`getRelayUrl`);
never read either source inline (ast-grep invariant).

- **`RelayApiClient`** (`relayClient.ts`) — `get/post/put/patch/del` (JSON) + `upload`
  (multipart). Bearer + reactive `401`→`/refresh`→retry-once + renewed-token persistence are
  delegated to `createAuthedFetch`. Non-2xx → `ApiHttpError`; 204/empty → `undefined`. Multipart
  sets no `Content-Type` (platform adds the boundary).
- **`createQueryClient`** — `networkMode: 'online'` (offline requests **pause** and auto-resume on
  reconnect — that's the "queued, no manual retry" behavior), queries retry 3× with capped backoff
  - 30s `staleTime`, mutations `retry: 0`. `configureQueryOnlineManager(netInfo)` bridges NetInfo
    into TanStack's `onlineManager`.
- **`ApiProvider`** mounts `QueryClientProvider` + the online-manager bridge; `useApi()` /
  `useOptionalApi()` read the client (the optional form is non-throwing for screens that render
  before the provider). Typed hooks live in `hooks.ts`, query keys in `keys.ts`. Where a `/api/*`
  response is a superset of (or diverges from) the loose `@vgit2/shared` type, declare a local
  superset type — a documented, recurring pattern across the repo/file/tasks features.
- **Token refresh** (`refreshAuthToken.ts`, `authedFetch.ts`). `refreshAuthToken` exchanges the
  stored authToken via `POST /refresh` and persists the fresh token. `createAuthedFetch` attaches
  the Bearer and on a `401` refreshes reactively then replays once; concurrent 401s share one
  in-flight refresh (single-flight).

## Global client state (`src/features/state/`)

Zustand slices split by storage sensitivity (`storage.ts` = the two persist backends):

- **SecureStore (secrets):** `authStore` (`portable.auth` — non-secret identity + flags, via the
  async `secureStateStorage` adapter; the actual JWTs stay in `secureAuthStore.ts` / `tokenCache.ts`,
  never in a slice).
- **MMKV (non-secrets):** `chatStore` (drafts + per-chat/AI-style prefs), `themeStore`, `reposStore`
  (search/language prefs only — server cache stays in-memory via `partialize`), `offlineQueueStore`,
  `pushRegistrationStore`, `blockedOrgsStore`, `usageTrackingStore`, `updatePromptStore`,
  `utmStore`, `devModeStore`.
- **In-memory (not persisted, reset on socket teardown):** `runtimeStore`, `socketStore`,
  `chatMessagesStore`, `chatChromeStore`, `readMarkerStore`, `systemWarningsStore`,
  `interactionStore`, the health stores.

Server state belongs to TanStack Query, not Zustand. `forceSignOut(opts?)` (`forceSignOut.ts`) is
the single logout/wipe composition: clears the authToken + connection URL, resets every non-secret
MMKV user-data store (`wipeLocalUserData()`), optionally deletes the Clerk client JWT + runs a
live Clerk sign-out. Deliberately PRESERVED (device/environment state): `installMarker`,
`devModeStore`, `usageTrackingStore`, `updatePromptStore`.

### Startup gate + stale-credential cleanup (`src/features/auth/`)

`useStartupGate` runs three checks once on mount and is the outermost auth gate: (1)
**fresh-install marker** (`installMarker.ts`, MMKV) — absent ⇒ any Keychain residue belongs to a
previous install ⇒ `forceSignOut` + write the marker + `needs-sign-in` (iOS Keychain survives
reinstall but MMKV does not). (2) token presence. (3) **`GET /me` auth preflight**
(`preflightAuth.ts`) — 2xx+JSON ⇒ `valid`; 401/403 (or a 2xx non-JSON from the gateway origin
catch-all) ⇒ `auth-dead` ⇒ wipe + sign-in; network/5xx/off-origin ⇒ `indeterminate` ⇒ **fail
open** (an offline returning user is never signed out). Nothing is written on the way to
`needs-sign-in`, so there's no half-authenticated state.

### Hidden dev mode (`devModeStore`)

A single installed build targets prod (default) or the dev environment, toggled by **10 quick
taps on the sign-in brand header**. While on: a red DEV MODE banner + the Clerk email/password
form unhides (prod is SSO-only). `getGatewayUrl()` consults `devModeStore` on every call (prod →
`EXPO_PUBLIC_GATEWAY_URL || https://app.portable.dev`; dev →
`EXPO_PUBLIC_GATEWAY_URL_DEV || https://app.portable-dev.com`). `getClerkPublishableKey()` swaps
to the `_DEV` key and `ClerkAuthProvider` is keyed on the mode (remounts `ClerkProvider` on flip).
Toggling fire-and-forget clears cross-env credentials. `devModeStore` persists via a lazy
try/catch `getMmkv()` (it's in `gatewayConfig`'s import graph, ≈ every feature) so an unmocked
Jest graph degrades to prod instead of crashing.

## Socket.IO (`src/features/socket/`)

`useNativeSocket(deps)` builds the socket via `createSocket(token, url, MOBILE_SOCKET_OPTIONS)`,
binds handlers, and exposes `{ getSocket, emitters, joinChat, reconnectAndSync }`.
`SocketProvider` / `useSocket()` / `useOptionalSocket()` (non-throwing) wrap it. **No DOM events**
— connection signals surface as Zustand state in `useSocketStore`
(`connectionState`/`connected`/`socketId`/`hasConnectedOnce`/`lastCreatedChatId`). RN lifecycle is
injected, not baked into the shared core: AppState (`active` → reconnect+resync; `background` →
stop retries) and NetInfo (offline→online edge → resync). **rev12 cross-surface presence:**
`chat:external_turn_completed` folds into `useSocketStore.lastExternalTurn` (a completed TERMINAL
`claude` turn on the PC — `chatId` == the Claude Code session id); `useChatStream` re-joins the open
chat on the `seq` change so the transcript hydrates the turn that streamed nowhere. **`claude:*`
streaming and all interaction/chrome/lifecycle events are bound GLOBALLY in `bindHandlers`**, so
background chats
keep accumulating and the listeners survive a recovery re-point.

- **App-version handshake.** `buildSocket` sends `auth: { token, appVersion }` (from
  `Constants.expoConfig?.version`). A bare native handshake with no `appVersion` is an outdated
  build, which the backend blocks at `chat:message` with an "update your app" notice.
- **Offline message queue** (`useOfflineMessageQueue`, `offlineQueue.ts`). No outgoing message is
  lost across an app kill. `send` delivers immediately when `connected` (falls through to enqueue
  if the ack fails); else it enqueues to the persisted `offlineQueueStore` (MMKV). On the
  disconnected→connected EDGE (including first connect after relaunch) it `flush()`es FIFO: a
  sequential duplicate is dropped, a successful ack removes the message, the first failed ack stops
  the flush. The new-chat first message is durable too — the composer enqueues it (keeping the
  optimistic bubble + a synthetic success) ONLY when the send truly never reached the PC (socket
  down or the emit throws); a genuine server rejection rolls back instead.
- **Connection health — tiered keepalive + autonomous reconnect** (`connectionHealth.ts`). Over
  the relay a tunnel changeover drops the PC↔phone WebSocket but the phone often gets no clean
  close, so `socket.connected` keeps reporting `true` against a dead endpoint. `ConnectionHealthMonitor`
  (pure, framework-free) keeps its OWN authoritative health state from round-trips it drives:
  `HEALTHY` (a `ping`→ack heartbeat every 20s) → `PROBING` (a miss; re-probe at 3s) → on 2 misses
  escalate to an HTTP fallback (`GET <relay>/api/health`: 200 ⇒ transport wedged → reconnect now;
  not-ok ⇒ endpoint down → backoff) → `RECONNECTING` (force a fresh transport via
  `disconnect()`→`connect()` — socket.io's auto-reconnect is unreliable over the relay) →
  `SUSPENDED` (backgrounded/offline). One `generation` counter discards stale async callbacks;
  every trigger funnels through the machine (no double reconnects). It is the single reconnect
  authority for both the silent-dead socket (heartbeat) and a clean drop socket.io can't recover
  (an ~8s-grace backstop). Foreground app on a stable network auto-recovers in ~20-35s with no
  user interaction.
- **System warnings + session lifecycle** (`SystemWarnings.tsx`, `systemWarningsStore.ts`,
  `extendSession.ts`). Renders the server's `system:*` events as native modals/banners (no
  `window.location.href`). `system:idle_warning` → an "Are you still there?" modal whose "I'm
  still here" calls `extendSession` (`POST <relay>/api/activity/ping`); `system:idle_shutdown` /
  the new `session:expired` → `setSessionEnded` → the re-provision/loading overlay that fires the
  session boundary's death handler once. `ReconnectingBanner` is shown purely from
  `useSocketStore` state (`!connected && hasConnectedOnce`). `system:shutdown_warning` is
  deliberately NOT bound on RN.

## Chat (`src/features/chat/`)

### Cross-surface presence — "Running on PC" + Stop on PC (rev12)

A chat whose Claude Code session is live in a **terminal on the PC** (the api's launcher installs
global lifecycle hooks; the backend registry folds those sessions into `user:runtime_state` with
`origin: 'terminal'`, `chatId` == the session id == the discovered chat id). `useRunningOnPc(chatId)`
(imported BY FILE) joins the chat id against the terminal-origin `claudeSessions` → `{ onPc,
runningOnPc }`. **`RunningOnPcBadge`** ("Running on PC" mid-turn / "Open on PC" idle) rides
`ChatCardBody` (lists + home preview) and the active-chat header. Mid-turn (`runningOnPc`) the
transcript footer also shows the typing dots with a **"Working locally..."** line
(`MessageList` `workingOnPc` prop → `TypingIndicator` `text` override, dots in theme primary);
the local run's indicator (`isWorking`) always wins. **Mid-turn live-follow (D62):** the api
tails the running session's transcript and pushes each newly-persisted row to the chat room as
`chat:external_messages` (`BufferedMessage[]` — the `chat:join` ack wire shape);
`useNativeSocket` folds the batch via `chatMessagesStore.applyExternalMessages`, which routes
every row through the SAME reducers as the live stream (`user_message` → `appendUserMessage`,
`claude_code_block` → `appendBlock`, blockId-deduped) — so a terminal turn renders exactly like
a local run while it happens, and the final Stop-hook re-join snapshot reconciles idempotently.
**`RunningOnPcBanner`** (above the
composer, terminal-live only) offers **"Stop on PC"** — an OUTER gate returns null when `!onPc`, and
the mutation body (`useStopOnPc` → `POST /api/chat/:sessionId/stop-on-pc`, non-throwing
`useOptionalApi`) mounts ONLY when shown, so ActiveChatScreen still renders without an
ApiProvider/QueryClient. A confirmed stop ends the terminal session → the next send continues the
SAME conversation (backend adopt-on-first-write); an unconfirmed stop → the send forks. **Sending
WITHOUT stopping first also just works (D63, backend stop-on-send):** an interactive send to a
terminal-live chat makes the backend stop the terminal session (evidence-confirmed, ≤~8s) and
adopt in place — the app needs no special handling (the optimistic bubble shows immediately; the
ack simply resolves after the stop); only an unconfirmed stop falls back to the fork →
`chat:forked` → `router.replace` as before. The Runtime
tab labels terminal sessions "Terminal" and hides Kill for them (the api doesn't own that subprocess).

### Directory, settings, project grouping

- **`useChatDirectory({ category })`** — the list is server state (`useInfiniteQuery` over
  `GET /api/chats?category=active|saved|archived&limit=50&offset=`, `CHAT_PAGE_SIZE` 50). Each
  category is its own query (separate cache key). `archive`/`save`/`setPinned`/`remove` optimistically
  drop the row and invalidate the destination tab. **Delete is a real backend
  `DELETE /api/chats/:id`** (the `~/.claude/projects` transcript is not touched). Pin is orthogonal
  (any bucket) and floats pinned-first (server order + `groupChatsByProject` client float).
- The `/chats` directory has **four tabs** — Project (default, project-grouped via
  `groupChatsByProject.ts`), Active, Saved, Archived. Rows are home-style cards (the shared
  `home/ChatCardBody`, also used by the home + repo-Overview "Continue chats" previews) wrapped in
  `SwipeableChatRow` (left-swipe Archive/Delete; reanimated + gesture-handler). Long-press opens
  the shared `ChatActionSheet` (Pin/Save/Archive/Delete). The repo tag prefers
  `chat.repoFullName` → `getRepoFromPath(repo_path)` → disk basename → "Workspace".
- **Per-chat settings** (`useChatSettings.ts`) — `GET/PATCH /api/chat/:id/settings` (singular
  `chat`). Resolution = `defaults ← server ← local`. Defaults (`NEW_CHAT_SETTINGS`):
  `DEFAULT_MODEL_MODE` ('opus') / `bypass_permissions` / **`freestyle`** agent. New-chat prefs are
  **remembered per project** (`chatStore.settingsByProject` + the global `newChatSettings`
  fallback; `resolveNewChatSettings` precedence defaults → global → project) — the agent is never
  silently anything but freestyle (`chatStore` persist `version: 1` migrates a stale `best-practice`
  global once; the server-side defaults match).
- **Fork-on-first-write** — sending the first message to a discovered Claude Code transcript forks
  it into a Portable chat (backend); `chat:forked` (`{ oldChatId, newChatId }`) folds into
  `useSocketStore.lastForkedChat` and `ActiveChatScreen` `router.replace`s to the new id.
- **List freshness** — `ChatListSync` (render-null mount) invalidates `chatDirectory('active')` on
  every `lastCreatedChatId` so a new chat appears immediately, covering every create path. Chats
  also happen ON the PC (terminal `claude`, other surfaces) with no socket signal, so the two
  `['chats']` previews POLL (`chat/chatListPolling.ts`, 15s, Home gated on tab focus); the `/chats`
  tab refetches on tab re-focus. After an HTTP `POST /api/projects/create` / clone, `useChatComposer`
  / `useRepoOverview` flush the `['repos']` + `['recent-projects']` caches (there's no `repo:created`
  socket event).

### Message list + blocks

- **`useChatMessagesStore`** (in-memory, keyed by chatId). The block-append reducer is the pure
  `appendBlockToMessages` (dedups by `blockId` first, then id+type, then exact text): a
  `tool_result` attaches to the assistant message holding its matching `tool_use`; otherwise the
  block extends the last assistant message or starts a new one.
- **`groupBlocksByAgent`** groups a message's blocks by `parent_tool_use_id` IDENTITY (one card
  per sub-agent, accumulating all its non-contiguous blocks). The spawning `Task` tool_use is
  folded into the card header (`subagent_type` → name, `description` → "what it's doing"). Name/color
  resolve via `getAgentInfo(agentType, agentSetups)`.
- **`groupFileEditBlocks`** (`blocks/`) gives `Write`/`Edit`/`MultiEdit` tool blocks the same
  identity-based treatment: 2+ file-edit blocks in a scope (main agent OR a single sub-agent's own
  blocks — it runs on whatever `renderMessageBlocks` is handed, so it composes with the sub-agent
  grouping above rather than reworking it) fold into ONE persistent `FileEditGroup` card, robust to
  narration/other tool calls interleaved between edits; a lone edit still renders inline (no
  wrapper). `FileEditGroup`'s expanded body reuses `renderConsolidatedBlocks` (the same
  consolidate-tool_use-with-its-tool_result step, factored out of `renderMessageBlocks` into its own
  module to avoid an import cycle) so each edit is still its own independently-expandable
  `EditBlock`/`WriteBlock`/`MultiEditBlock`.
- **`useChatStream(socket, chatId)`** joins the room (gated on `useSocketStore.connected`) and
  hydrates history from the `chat:join` ack **through `transformBufferedMessages`** (the ack carries
  raw `BufferedMessage`s, not chat messages — storing them directly renders an empty chat). It
  preserves the numeric buffered id (stringified) as the FlatList key + mark-read cursor. The join
  payload sends `count` (the field the backend reads). `mergeJoinedHistory` reconciles each local
  optimistic user message to at most one backend message (id → timestamp → user-content) so a live
  re-join doesn't double the first message; assistant messages are never content-matched.
- **`MessageList`** (FlatList) — sub-agent groups under collapsible headers (collapsed by default),
  main-agent blocks inline. **Auto-scrolls only when content GREW and the user is near the bottom**
  (decision from the height delta + position, so a collapse never yanks). Earlier history loads
  automatically near the top (gated on a real user drag;
  `maintainVisibleContentPosition={{minIndexForVisible:1}}`). `MessageItem` is `React.memo`'d with
  a comparator that ignores `allMessages` (a new array every chunk). Auto-marks-read via
  `onViewableItemsChanged`. Each user message has a copy button (`MessageCopyButton`).
- **`TypingIndicator`** is the web-parity working animation (replaces "Claude is working…");
  renders inside the active sub-agent group in that agent's color, exactly one at a time.
- **Block renderers** (`blocks/`). `BlockRenderer` dispatches on `block.type`, and for `tool_use`
  via `TOOL_RENDERERS` (exact toolName) then `resolveToolRenderer` (prefix/aliased, e.g.
  `mcp__playwright__browser_*` → `PlaywrightBlock`, `mcp__standard__*_tunnel` → `TunnelBlock`); a
  tool matching neither falls through to the generic `ToolBlock` (tool blocks never hit the
  fallback). Non-tool types: `text` (`MarkdownText` = `react-native-markdown-display`),
  `image`/`video` (RN `Image` / expo-video), `actions` (`ActionsBlock` chips), `error`
  (`ErrorBlock`), GitHub entity blocks (`github_issue`/`github_pr`/… → native `GitHubCard`s, tap →
  `Linking.openURL`), interaction shells (Permission/Secrets/ConnectionRequest — see below). An
  unknown NON-tool type renders the visible `FallbackBlock` (names the type, **never raw JSON**).
  `BLOCK_COVERAGE` is the exported checklist tested for no-fallback. Code renders via the
  self-contained native `CodeHighlight` (lexer → colored `<Text>`, no webview); Edit via
  `DiffHighlight`; MultiEdit (`MultiEditBlock`) renders one `DiffHighlight` per sub-edit under a
  single file header. **Any test importing the chat blocks / `MessageList` MUST
  `jest.mock('react-native-markdown-display', …)`.**
- **Media over the relay** — a screenshot/video arrives as an `image`/`video` block with a relative
  PC path (`/data/media/...` public, or `/api/video/...` behind the JWT). `resolveAuthedMediaSource`
  turns it into the absolute relay URL + a Bearer for `/api/*` only; inline `data:` and absolute
  `http(s)` pass through. `getToolResultText` skips image/video items so a tool block never dumps
  raw base64.

### Composer, voice, attachments, interactions, chrome

- **`createNewChatFlow`** (pure, `newChatFlow.ts`) — `analyzeIntent` → resolve owner/repo
  (`existing-repo` / `new-repo` via `createProject(folder, framework)` / `simple-task` → the
  reserved `{ __workspace__, tmp }` scratch target) → `emitCreateChat` → `sendMessage`. New-repo
  sends the `generateProjectCreationPrompt` wire content with the user's description as
  `customDisplay.displayText`. Socket acks are checked — a `success:false` create/send throws
  (`socketAckError`), unseeds the ghost, rolls back, no navigation. An `onStage` seam drives the
  `ProjectCreationOverlay` (the looping `WhaleVideo` — an animated transparent **WebP** via
  `expo-image`, NOT a video: Android's video decoder drops the VP9/HEVC alpha channel).
- **`useChatComposer`** owns the draft (debounced to MMKV), the selector setters
  (`setNewChatSettings`), and `submit()`. `ChatComposer` (home) and `FollowUpComposer` (active
  chat, drives per-chat `useChatSettings`) share the `composer/` kit (`SelectorButton` →
  `SelectorSheet`, optionally `searchable`). Labels come from `@vgit2/shared` `MODELS`/`PERMISSIONS`.
  `FollowUpComposer` shows a Stop button (`active-chat-stop`, `claude:interrupt`) in the control
  row while running, with the shared mic↔send `InputActionButton` always in the trailing slot.
- **Voice** (`voice/`) — on-device-first dictation via **`expo-speech-recognition`** (free,
  private, no server round-trip; no Whisper, no upload). `nativeSpeechRecognizer.ts` is the only
  file touching the native module (lazy-required). Two pure helpers carry the per-platform
  divergence: `resolveStartOptions` (the Android mid-sentence silence window is Android-only) and
  `shouldAutoRestart` (**iOS NEVER auto-restarts** — re-`start()` inside the `end` handler drops
  words and throws; Android re-arms per utterance). `useNativeDictation` accumulation is
  **replace-within-segment, commit-on-new-segment** (robust to iOS's cumulative results AND
  Android's reset-after-pause — do NOT re-add an `isFinal`/`end`-gated commit). Default strategy:
  iOS `continuous`, Android `dictation`; language picker persists in `useVoiceSettingsStore`. On
  the composer, empty input → a mic button; typing → a send button you long-press to flip to voice,
  which auto-reverts to send on stop (`InputActionButton`; transient state, not a sticky pref).
  "On-device" is the default, not a guarantee — it silently falls back to platform servers when no
  on-device model exists (`voice-cloud-fallback-note`), which the `app.json` permission string
  admits.
- **Attachments** (`attachments/`) — pick image/file or capture a photo → compress (images >5 MB,
  `expo-image-manipulator`) → `POST /api/upload` (multer field `file`, RN `FormData`). Native
  pickers live only in `expoPickers.ts`; `CameraCapture` is device-only (lazy). `ImageGalleryModal`
  swipes via gesture-handler `Gesture.Pan().runOnJS(true)`. (The Skia-backed "Draw" source was
  removed — its ~731 MB prebuilt binaries hung EAS/CI; use SVG/gesture if it returns.)
- **Interaction flows** (`interactions/`) — the four server prompts that pause a run
  (tool-permission, ask-user-question, secrets, connection-request). Server events bound globally:
  `tool_permission_required` → retroactively flags the matching `tool_use` (renders inside
  `PermissionBlock`); `ask_user_question` → `interactionStore` → `AskUserQuestionBlock`;
  `secrets:submitted` → flips the `SecretsBlock` form. The ask prompt renders INSIDE the
  transcript scroller — `ActiveChatInteractions` mounts as the `MessageList` `footer`, never as a
  fixed sibling (its content is unbounded: N questions + a shared Submit; a sibling can't scroll
  to Submit nor keyboard-avoid the "Other" input — issue #10). A focused "Other" input scrolls
  itself above the keyboard via `MessageListHandle.scrollFooterInputIntoView` (measured against
  the KAV-shrunk list bounds, re-measured on `keyboardDidShow`). While an ask prompt is pending
  (`footerActive`, wired from `interactionStore`) the run is paused, so the list SUPPRESSES its
  always-snap-on-growth for footer-internal edits — otherwise toggling "Other" on a stacked prompt
  would yank the just-revealed input off-screen; the prompt is still revealed once when it first
  appears. Blocks reach the socket through
  `ChatInteractionProvider` / `useChatInteraction()` (mounted by `ActiveChatScreen`), falling back
  to that context when no explicit callback is passed. Connection OAuth opens the in-app browser to
  `<relay>/connections?service=`.
- **Chat chrome** (`chrome/`) — the per-chat context band (`useChatChrome`): git status +
  quick-action pills (REST, `retry:false`) joined with socket-driven summary + container status
  (`chatChromeStore`) and runtime tunnels/processes. `useChatRepoPath` resolves the repo path from
  the chrome store's reactive `repoPaths` sink then the cached chat-directory query (the `chat:join`
  ack carries none). The quick-actions bar merges backend pills with a synthesized "Restart
  {server}" per active tunnel; tapping a `message`-type pill sends via the offline-tolerant
  `handleSend`. `LinkedIssueBadge` (under the chat name + active-chat header, tappable → the issue
  viewer) shows the GitHub issue a chat is linked to (`chat:linkedIssueUpdated`).
- **In-chat runtime preview** (`runtime/`) — when a chat has a live dev-server tunnel, a draggable
  floating bubble (`ChatRuntimeBubble`, reanimated + gesture-handler) floats over the transcript.
  iOS → opens the running project in the SYSTEM browser; Android → a full-screen `Modal` embedding
  `SandboxWebView`. `selectChatTunnel` scopes strictly to the chat then repo (never a global
  tunnel). `useTunnelRepair` drives a lazy `POST /api/tunnels/repair` on an Android embed load
  error (iOS opens the browser, so no iOS repair path).

## Tasks (`src/features/tasks/`)

The `/tasks` tab — the user's GitHub work grouped Done Today / In Review / Todo (`my` view) or
Todo Assigned / Unassigned (`all`), with My/All sub-tabs and a filter bar. **Scoped to LOCALLY
CLONED repos** (backend `UserHandler.fetchUserTasks` reads the workspace clones; no whole-account
scan). `GET /api/user/tasks/cached?view=` (instant) then a background `/refresh` (navigation always
force-refreshes via `useFocusEffect`). No shared types — `types.ts` declares the wire shape
locally; the backend maps GitHub GraphQL by hand (key by `owner/repo#number`, never `id`). When no
repo is cloned the payload carries `noLocalRepos: true` → the `tasks-empty-no-repos` guidance.
`taskHelpers.ts` is the pure grouping/filter pipeline; `useTasks` mounts both views in parallel
(instant switch), keeps last-known data on a refresh failure, and uses `isPending` (not
`isLoading`) so a paused offline cold-start shows the spinner. Tapping a row opens `TaskItemViewer`
(a full-screen Modal hosting the native Issue/PR viewer); its AI actions ("Start issue chat" /
"Review with AI") run the socket chat hand-off (`useViewerChat`, gated on `connected`).

## Repos (`src/features/repos/` list + `src/features/repo/` detail)

- **Repo list** (`useRepoDirectory`) — `useInfiniteQuery` paging three endpoints: page 1
  `GET /api/repos/cached` (instant), page 2+ `GET /api/repos`, pull-to-refresh
  `GET /api/repos/refresh`. Search is server-side + debounced into `reposStore`, language + sort
  are server-side params. The query string is built in a FIXED order (`page, per_page, sort,
search?, language?`) so tests register the exact URL. Cards show owner avatar + repo name + a
  NEW/Cloned badge + the local-clone git-status line (the local status comes straight from the
  backend — the RN client never shells out to git). `blockedOrgsStore` feeds a `blockedOrgs` param
  (the backend filters).
- **RepoPage** (`src/features/repo/`, route `app/repos/[owner]/[repo].tsx`). Tab set single-sourced
  in `repoTabs.ts`: `overview, issues, prs, actions, workflows, generations, branches, settings`.
  `resolveRepoTab` falls back to `overview`; add a tab's key to `IMPLEMENTED_REPO_TABS` to stop the
  placeholder. Detail navigation is local component state inside each tab (no nested route).
  - **Overview** = the working dashboard (no README): homepage link bar, the "Work on {repo}…"
    input (cloned) or a Clone-to-Local card (`POST /api/repos/:o/:r/clone`), quick-action pills, a
    git status bar, and a directory tree (lazy per-folder `useRepoTree`; file tap → the file
    viewer). The refresh glyph invalidates the `treePrefix` (root + every expanded level). Data:
    `useRepoDetails` → `GET /api/repos/:o/:r?skipGitOperations=true`. The chat hand-off reuses
    `startRepoChatFlow`.
  - **Branches / Issues / PRs / Actions / Workflows / Generations / Settings** — each a
    `useInfiniteQuery`/`useQuery` over the corresponding `/api/repos/:o/:r/...` endpoint. Several
    responses are SUPERSETS of (or diverge from) the loose shared types — declare local types.
    ⚠️ pagination field names differ: issues/branches/actions/generations use snake_case
    (`total_count`/`has_more_pages`); **pulls use camelCase (`totalCount`/`hasMore`)**. Issue/PR
    detail returns `{ issue/pr, timeline, files }`. Issue mutations (comment, assignee) and
    workflow-file CRUD invalidate the matching query. Status glyphs are TEXT (FontAwesome is
    web-only). Settings + Generations are read-only.
- **File viewers** (`src/features/file-viewer/`, route `app/repos/[owner]/[repo]/file/[...path].tsx`).
  `detectFileType` dispatches to a native viewer. **TEXT** (`GET .../contents/<path>` → base64,
  decoded) → `CodeViewer` (reuses `CodeHighlight`, a line-number toggle) / `MarkdownViewer` /
  `CsvViewer` (PapaParse, sortable columns). **BINARY** (image/pdf/video/audio) → no body fetch:
  resolve the absolute `.../raw/<path>` URL + a Bearer header for the native loader (PDF =
  device-only `react-native-pdf` via `loadPdfViewer`; video/audio lazy via expo-video/expo-audio).
  **Apple constraint: every viewer is NATIVE** — none embed arbitrary external web content in a
  WebView; a type that would need one shows a Download button (system browser, never a WebView,
  never `expo-file-system`). A 404 renders `FileNotFound` (+ a Restore-last-committed button via
  `useFileHistory`).

## Runtime (`src/features/runtime/`)

The native PC-runtime hub — the `/runtime` tab (`RuntimeOverviewScreen`, exported as `RuntimeBox`)
with metrics + collapsible Sessions / Tunnels / Processes / Claude-sessions sections, whose cards
push dedicated list+detail screens over the tab bar, plus a Storage file manager. Nested Stack
`app/(app)/runtime/` (sibling of `(tabs)/runtime.tsx`). Socket-sourced via
`useRuntime(useOptionalSocket())`; detail screens accept explicit props (tests skip
`renderRouter`).

- **Apple compliance — `SandboxWebView` is the single gate.** A user URL (a tunnel dev-server
  preview) is NEVER embedded in a WebView on iOS: iOS renders "Open in browser" → system browser
  (`expo-web-browser`); Android embeds via `react-native-webview`. Both natives load via a
  render/call-time `require()`. The external-open helper is `openSandboxUrlExternal`. On iOS an
  overview tunnel-card tap opens the URL directly (no detail hop — iOS never embeds).
- **`ProcessDetailScreen`** renders ANSI-colored stdout/stderr (`ansiToSpans`), fetched from
  `/api/task-output` and polled 2s while running. **`StorageScreen`** is the workspace file manager
  (usage bar, breadcrumb nav, sort, multi-select + bulk delete to free space) over the authed
  storage API (`useStorageList`/`useStorageUsage`/`useDeleteStorageEntry`/`useBulkDeleteStorage`,
  mutations invalidate the `['storage-list']` prefix). Tapping a file is a no-op (file viewing is
  the repo viewer).
- **Claude sessions** — surfaces the per-chat live Claude subprocesses
  (`runtimeStore.claudeSessions` from `user:runtime_state`), each with a status dot, time-since
  last-activity, and a Kill button (`chat:kill-session`). `session:reaped` drops the row. The
  backend reaper (`SessionReaperService`) auto-reclaims idle ones via `stopSession` (preserves
  `session_id` → the next message resumes).
- **Disconnect PC** (the bottom danger entry) opens a confirm modal → `disconnectPc`, which clears
  the pcId + JWT and signals `PcConnectGateHost` back to the connect landing.

## Settings (`src/features/settings/`)

Route `app/(app)/(tabs)/settings.tsx` → `SettingsScreen` (reached via the Home profile pill — no
tab button). The nav hub for the section screens, single-sourced in `settingsSections.ts`
(`SETTINGS_SECTIONS`; `sectionRoute(key)` → `/settings/<key>`). Section route shells live under
`app/(app)/settings/` (a Stack dir), each delegating to `src/features/settings/sections/<key>/`,
every page MVVM ViewModel-as-hook over the shared `chrome/SettingsChrome.tsx` kit.

- **Root** — search bar, compact profile card (avatar action sheet, `⋯` menu, Logout), inline
  Danger-Zone delete confirm. **Profile photo is Clerk-native** (`user.setProfileImage`, not a
  gateway endpoint). **Account deletion** is gated on re-typing the email → `DELETE /auth/account`
  → sign-out → `/sign-in`.
- **Sections:** `claude-account` (portable.dev#18 — sign in with Claude from the phone: the
  AI-credential status card over `GET /api/ai-credentials/status` + the browser-and-paste-code
  PKCE login (`POST /login/start` → `Linking.openURL` → paste `CODE#STATE` → `POST
/login/complete`), a paste-token fallback (`POST /token`) and sign-out (`DELETE`); the browser
  opener is an injectable VM seam. Also reachable by typing `/login` in either composer — a
  CLIENT command (`composer/clientSlashCommands.ts`, merged into the slash picker) that navigates
  instead of sending — and from the chat dead-credential `ErrorBlock` CTA
  (`code === 'ai_credential_invalid'`)), `commits` (the AI co-author toggle — server pref in
  `userSettings.includeCoAuthoredBy`; the backend half installs a `prepare-commit-msg` hook +
  passes SDK `settings.includeCoAuthoredBy`), `ai-style` (store-only, `@vgit2/shared/aiStyles`),
  `permissions` (DEVICE permissions — notifications/mic/camera), `mcp` + `agent-setups` (read-only
  catalogs), `secrets` (CRUD `/api/user/secrets`; values arrive masked, a new value is REQUIRED on
  edit — the backend PATCH has no keep-current path), `notifications` (see Push below), `theme`
  (live re-theme + debounced `PUT /api/user/theme`), `organizations`
  (`blockedOrgsStore` → the `blockedOrgs` repo-list param), `connections`
  (`/api/connections/*`; rename body is `{ newDisplayName }`; connect via the in-app browser), and
  `legal` (ToS/Privacy markdown copied into TS constants). `/settings/sentry-test` is surfaced only
  in dev mode.

## Push notifications + FCM (`src/features/settings/sections/notifications/`)

The backend delivers native pushes EXCLUSIVELY via FCM, so it needs a real **FCM registration
token**. `pushAdapter.getDeviceToken()` is `@react-native-firebase/messaging` `getToken()` on
**BOTH** platforms — on iOS, `expo-notifications`' `getDevicePushTokenAsync()` returns the raw
APNs token, which FCM rejects (`messaging/invalid-argument`); the Firebase iOS SDK mints a real FCM
token (always `await registerDeviceForRemoteMessages()` first on iOS — do NOT re-add an
`isDeviceRegisteredForRemoteMessages` guard). Permission/handlers/deep-linking stay on
`expo-notifications`.

- **`PushSetupLayer`** (mounted by `AppShell` inside `ApiProvider`) sets the foreground handler,
  the Android `portable-notifications` channel, the deep-link handler (`usePushDeepLink`:
  `data.chatId` → `/(app)/(tabs)/chat/<id>`), and the one-time `PushPermissionPrompt`. Enable →
  permission → `getDeviceToken()` → `POST /api/push/subscribe` (`subscription: { endpoint,
platform, fcmToken }`). This device's Enabled status comes from the MMKV `pushRegistrationStore`,
  NOT `GET /api/push/settings.enabled` (which is user-level and would lie on a fresh install).
- **Config (committed, not secrets — restricted by package/bundle id):** `google-services.json`
  (`android.googleServicesFile`) + `GoogleService-Info.plist` (`ios.googleServicesFile`), both
  Firebase project `portable-6ac02`, bundle `dev.portable.app`. The iOS build needs
  `use_modular_headers!` in the Podfile (the local `plugins/withModularHeaders.js` config plugin) —
  Firebase iOS SDK 11's Swift pods can't import their ObjC deps without modules. **`useFrameworks`
  is deliberately NOT used** (it risks the New-Arch C++ pods — mmkv/nitro, reanimated/worklets).

## Other AppShell layers

- **Store-review prompt** (`src/features/review/`) — asks for the OS native in-app review
  (`expo-store-review`) once after ~30 min of cumulative FOREGROUND time (`usageTrackingStore`,
  MMKV, survives kills; `reviewRequestedAt` latches one-and-done). `useStoreReviewPrompt`
  accumulates only foreground time (AppState freezes the clock).
- **UTM attribution** (`src/features/attribution/`) — makes a native user count as a
  verified signup. The native app never visits the web landing page, so a mobile user had no
  `user_attribution` row and never counted. `POST /auth/mobile/react-native/utm` (Bearer; userId
  from the verified token) mirrors the web claim-then-fallback ordering: `claimByIp` (awaited) →
  `saveAttribution` (only if the deep link carried `utm_*`) → `updateFirstUse`. An organic install
  writes nothing. `parseUtmFromUrl` extracts `utm_*` off a deep link; `useUtmAttribution` captures
  first-touch (survives a kill) and reports once per user.
- **Live Activity** (`src/features/activity-indicator/`) — surfaces a long-running chat
  OUTSIDE the app. iOS shows a real ActivityKit Live Activity (Lock Screen + Dynamic Island) via
  the local Expo module `modules/live-activities/` + the widget target `targets/widget/`
  (`@bacons/apple-targets`); elapsed time is rendered NATIVELY (no per-second JS tick).
  **`ClaudeActivityAttributes.swift` is duplicated byte-identically in both dirs** (the widget
  can't see `modules/`) — keep them in lockstep or `Activity.request` produces a state the widget
  can't decode. **Every other platform (Android included) is a no-op** — the old Android ongoing
  notification re-rendered every second and spammed; a non-spamming Android indicator would need a
  native foreground service. `ActivityIndicatorSync` reconciles the running set against the
  platform backend from `chatMessagesStore`.

## Theme (`src/theme/`)

The color LOGIC is ported verbatim so a given `{ brightness, accent }` produces byte-identical
colors. **`useAppTheme()` is the only way to style an authenticated screen** (no Provider — zustand
`useThemeStore` is global). It returns `{ theme, isDark, boldMode, useGradients, boldGradient,
getBoldTextColor }`; `withAlpha(hex, '66')` for glass. **Never hard-code a hex** — pull from
`theme.colors.*` / `theme.tool.<family>.*`. Default = `MOBILE_DEFAULT_THEME_OPTIONS` (light +
orange + paper). `resolveBrightness(opts, scheme)` maps `'system'`/`paper`/`oled`. **Icons are
hand-authored SVG line-icons** (`icons/Icon.tsx`, `react-native-svg`) — `@expo/vector-icons` /
FontAwesome are NOT bundled (the same rule applies to tab/status/block glyphs: use SVG or
text/emoji). Sign-in + onboarding-style screens keep their own dark indigo/violet
`signInTheme.ts` tokens. `ThemeSync` (in `AppShell`) hydrates from `GET /api/user/theme` once per
cold start (server-wins, degrades on 404/offline); a theme `PUT` snapshots the full store state so
web-only extras aren't wiped. **CSS `135deg` gradient ↔ RN `start={{0,0}} end={{1,1}}`** (don't
"correct" to `{0,1}`).

## Sentry (`src/features/observability/`)

`@sentry/react-native@8.14.0` (pinned exactly — Expo's bundled `~7.11.0` lacks the SDK-56
`expo/fetch` fix). The config plugin `@sentry/react-native/expo` (in `app.json`) injects the native
source-map upload build phases on `expo prebuild` — NEVER put an `authToken` key there. `metro.config.js`
swaps `getDefaultConfig` → `getSentryExpoConfig` (installs the Debug-ID serializer; **never set
`config.serializer.customSerializer`** or it's clobbered). `initSentry()` runs at module scope in
`app/_layout.tsx` with `export default Sentry.wrap(RootLayout)` + an outermost `AppErrorBoundary`;
it deliberately leaves `release`/`dist` UNSET (auto-detected from the native build so events ↔ maps
match). Crash/error only — no tracing/Replay. DSN gating: `EXPO_PUBLIC_SENTRY_DSN` wins; else a
release build (or `EXPO_PUBLIC_ENABLE_SENTRY_TEST=true`) falls back to the bundled public DSN; else
plain `expo start` → undefined → init skipped. CI source-map upload writes
`packages/mobile/.env.sentry-build-plugin` from the repo-level `SENTRY_AUTH_TOKEN` secret before
`eas build --local` (the isolated native build-phase shell doesn't reliably inherit CI env).

## Commands

- `bun --cwd packages/mobile typecheck` (also in the root `bun typecheck`). `tsconfig.json` lists
  `compilerOptions.types: ["jest"]` (TS 6.0 no longer auto-includes `@types/jest`); Expo ambient
  types come from `expo-env.d.ts`'s `/// <reference types="expo/types" />` (committed — don't
  delete).
- `cd packages/mobile && bun run test` (jest-expo + React Native Testing Library). NOTE:
  `bun --cwd packages/mobile run test` is a no-op (prints help) and `bun --cwd packages/mobile test`
  runs Bun's built-in runner, not Jest. Always `cd` in (or `cd … && bun run test`). Render the
  router in tests via `renderRouter` from `expo-router/testing-library`.
- `bunx expo export --platform ios` — the Metro `.js`→`.ts` shared-import gate that `tsc`/Jest
  miss. **Run all three before declaring a mobile change done.**

## Native build (dev client — NOT Expo Go)

Custom native modules ⇒ a dev build (`expo run:ios` / `expo run:android` / EAS), never Expo Go.

- **`react-native-nitro-modules` must be a declared dep** (`react-native-mmkv@4` peer-requires it;
  transitive-only meant autolinking never built it → runtime `Failed to get NitroModules`).
- **Client env vars live in `packages/mobile/.env`** (git-ignored). Only `EXPO_PUBLIC_*` reach the
  bundle, inlined at build time — **restart Metro with `--clear` after editing**. Required:
  `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`, `EXPO_PUBLIC_GATEWAY_URL` (defaults to
  `https://app.portable.dev`; local full-stack = `http://localhost:3501` via `bun gateway:dev`).
  Optional: the `_DEV` variants (hidden dev mode) + `EXPO_PUBLIC_GITHUB_APP_NAME[_DEV]`.
- **First build:** `expo prebuild -p ios` (generates `ios/`, runs `pod install`) → `expo run:ios`.
  New-Arch / CocoaPods script-phase `[!]` notices are normal. **Re-run `expo prebuild` (+
  `pod install`) after changing any native module / config plugin / icon / splash asset.**
- App icons + splash are brand assets in `assets/images/`, wired in `app.json`
  (`ios.icon.{light,dark}`, `adaptive-icon.png`, the `expo-splash-screen` config plugin).

## Store release pipeline (CI → TestFlight + Google Play)

`.github/workflows/release-mobile.yml`. Trigger: a `pull_request` targeting `live` that touches
`packages/mobile/**` (+ a `workflow_dispatch` escape hatch). Jobs: `version-ios`/`version-android`
query TestFlight/Play for the highest existing build number → `version` publishes
`max(store) + 1` (floored at `1000`, overridable; falls back to `1000 + run_number` if both queries
are unavailable — detection can never fail the run) → `build-ios` (`macos-26`, EAS local, SDK major
≥ 26) → `submit-testflight` (fastlane pilot, a separate job so a flaky upload re-runs without a
rebuild) ‖ `build-android` (EAS local → Play internal `draft`).

- **iOS signing = EAS remote credentials** (cert + profile on expo.dev, fetched via `EXPO_TOKEN`).
  ASC app id `6758861546`, team `R78F2929PW`. **`dev.portable.app` is a shared bundle id — run any
  `eas credentials`/`eas build` with `EXPO_NO_CAPABILITY_SYNC=1`** (EAS's auto capability-sync tries
  to turn off Sign-in-with-Apple / Associated Domains and Apple rejects it). The RN app doesn't need
  the native capabilities (Apple sign-in goes through Clerk web OAuth).
- **Android signing = the keystore GitHub secrets** (`android` environment) →
  `credentials.json` (`eas.json` `credentialsSource: "local"`, `buildType: "app-bundle"`).
- `eas.json`: `appVersionSource: "local"` + `autoIncrement: false`; the build number is injected
  into `app.json` at build time (ephemeral, never committed).
- **Secrets layout:** the `iOS` env (`ASC_*`), the `android` env (keystore +
  `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`), and repo-level shared (`EXPO_TOKEN` secret +
  `SENTRY_AUTH_TOKEN` secret; the four `EXPO_PUBLIC_*` as public repo **Variables**, since they're
  inlined into the shipped bundle — a preflight fails loud on a missing one).
- Firebase config files are committed (no CI secret). No Skia, no `eas-build-post-install` hook.
