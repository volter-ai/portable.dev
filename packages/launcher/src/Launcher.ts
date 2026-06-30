import {
  LocalSecretStore,
  PairingStateStore,
  type DeviceInfo,
  type PairingStateData,
} from '@vgit2/shared/secrets';

import { ApiProcess, type ApiHealthBody, waitForHealth } from './ApiProcess.js';
import {
  ChatsClient,
  startChatsWatch,
  type ChatSummary,
  type ChatsWatcherHandle,
} from './ChatsClient.js';
import { ensureChromium } from './ChromiumProvisioner.js';
import { ensureCloudflared } from './CloudflaredProvisioner.js';
import {
  resolveApiBaseUrl,
  resolveOperatorWorkspaceDir,
  resolveRelayBaseUrl,
  resolveReviewerPublish,
} from './config.js';
import { startConnectionWatch, type ConnectionWatcherHandle } from './ConnectionWatcher.js';
import { ensureJwtSecret, mintPairingToken, resolvePairingIdentity } from './PairingIdentity.js';
import { PairingServer } from './PairingServer.js';
import { prepareCredentials } from './prepareCredentials.js';
import { startPresenceWatch, type PresenceWatcherHandle } from './PresenceWatcher.js';
import { verifyPublicUrl } from './PublicUrlVerifier.js';
import {
  renderTerminalQr,
  startLauncherUi,
  startStaticUi,
  type LauncherUiHandle,
  type StartLauncherUiOptions,
} from './TerminalUi.js';
import {
  startTunnelHealthMonitor,
  type StartTunnelHealthMonitorOptions,
  type TunnelHealthMonitorHandle,
} from './TunnelHealthMonitor.js';
import { TunnelRegistrationAgent, resolvePcId, resolvePcLabel } from './TunnelRegistrationAgent.js';
import { TunnelRouter } from './TunnelRouter.js';

/**
 * The `portable start` launcher.
 *
 * Clerk is GONE from the PC. One command brings the local-first runtime up
 * under a STABLE LOCAL identity (the pcId), mints the data-path JWT itself, and
 * shows the pairing QR:
 *   1. Ensure a local `JWT_SECRET` (generate + persist on first boot).
 *   2. Find local Anthropic + GitHub credentials on the OS (discovery ladder)
 *      and, if missing, drive the interactive login fallback in the PLAIN
 *      terminal — Claude CLI login / GitHub device flow. Discovered/
 *      obtained creds are written into the SAME `LocalSecretStore` keys + env
 *      the api child reads, BEFORE the api spawns and BEFORE the Ink screen.
 *   3. Spawn the api on 127.0.0.1:VGIT_PORT (API + Socket.IO only), passing it
 *      the SAME `JWT_SECRET` + pcId + relay so it validates the minted JWT.
 *   4. Wait for /api/health.
 *   5. Mint the data-path JWT in the launcher.
 *   6. Bring up cloudflared + the pcId-keyed registration agent, and WAIT for the
 *      agent's first registration handoff to settle (bounded/fail-open) — so the
 *      QR is never shown before the gateway can actually route to this PC.
 *   7. Render the QR `{ gatewayBase, pcId, token }` in the terminal (Ink).
 *   8. Serve a loopback-only pairing fallback page on the launcher's OWN port
 *      (NEVER tunneled — the token would leak through the relay).
 *   9. Run until SIGINT/SIGTERM, then shut down gracefully.
 *
 * BOOT uses plain logs; once the QR is up the steady-state pairing screen is
 * Ink. The api child's ongoing stdout is routed to the launcher LOG FILE (the
 * `apiLog` seam) so it never interleaves with the Ink-owned terminal.
 *
 * Everything is dependency-injectable so tests drive the full lifecycle with
 * fakes (no real api spawn, no real cloudflared, no real Ink/http). {@link
 * createLauncher} wires the real implementations.
 */

export interface LauncherDeps {
  apiProcess: ApiProcess;
  /**
   * Build the tunnel-router once the api base URL is known. `reviewerToken` is the
   * launcher-minted data-path JWT to PUBLISH on tunnel registration — passed by
   * {@link Launcher.boot} ONLY when the Apple-reviewer opt-in
   * (`PORTABLE_REVIEWER_PUBLISH`, {@link resolveReviewerPublish}) is on; otherwise
   * `undefined`, so the registration agent's body is byte-unchanged (a NORMAL PC
   * never publishes its JWT — the invariant).
   */
  makeTunnelRouter: (apiBaseUrl: string, reviewerToken?: string) => TunnelRouter;
  /** The stable local JWT secret, already ensured/persisted. */
  jwtSecret: string;
  /** The stable pcId — the routing key + the minted JWT's userId. */
  pcId: string;
  /** The per-PC relay endpoint (`<relay>/t/<pcId>`) shown on the QR/page. */
  endpoint: string;
  /** Human PC label. */
  label: string;
  /** The hosted relay base (`gatewayBase` in the QR payload). */
  gatewayBase: string;
  /** Optional connected GitHub login (preferred JWT username). */
  githubLogin?: string;
  /**
   * Resolve the connected GitHub login AT MINT TIME. The mint happens AFTER
   * {@link prepareCredentials} persists the login into the shared store, so reading
   * it here — not in {@link createLauncher} before boot — is what lets a first-ever
   * boot (login persisted during this run) author commits as the GitHub user. Wired
   * by {@link createLauncher} to `() => readStoredGitHubLogin(store)` over the SAME
   * store. Falls back to the static {@link githubLogin} when unset (back-compat/tests).
   */
  resolveGithubLogin?: () => string | undefined;
  /**
   * Credential preparation step: discover Anthropic + GitHub creds on
   * the OS (and run the interactive login fallback if missing), persisting them
   * into the store/env the api child reads. Invoked at the START of {@link boot}
   * — BEFORE the api spawns and BEFORE the Ink screen. Defaults in
   * {@link createLauncher} to {@link prepareCredentials} over the shared store.
   * Omit (or pass a no-op) in tests that don't exercise credentials.
   */
  prepareCredentials?: () => Promise<void>;
  /** Mint the pairing JWT (seam). Defaults to {@link mintPairingToken}. */
  mintToken?: (jwtSecret: string) => string;
  /**
   * Mount the steady-state UI on the CONNECTED MENU instead of the pairing QR —
   * true once a device has connected before (the launcher read the
   * `pairing-state.json` marker at boot, {@link PairingStateStore}) AND we're not in
   * `--debug` (debug always streams logs over a static QR print). Wired by
   * {@link createLauncher}. Becomes the UI's `initialPhase`.
   */
  initialConnected?: boolean;
  /** ISO timestamp of the last device connection, shown on the connected menu. */
  lastConnectedAt?: string;
  /**
   * Watch the pairing marker LIVE while the QR is up and swap to the connected menu
   * the instant a device connects — no restart. Set by {@link createLauncher} when
   * the PC has NOT connected before AND we're not in `--debug`. (When already
   * connected the menu shows at boot; in `--debug` the static QR print stays.)
   */
  watchForConnection?: boolean;
  /** Live connection-watch seam (tests). Defaults to {@link startConnectionWatch}. */
  startConnectionWatch?: (
    onConnected: (state: PairingStateData) => void
  ) => ConnectionWatcherHandle;
  /** Live device-presence-watch seam (tests). Defaults to {@link startPresenceWatch}. */
  startPresenceWatch?: (onPresence: (devices: DeviceInfo[]) => void) => PresenceWatcherHandle;
  /** Live chats-watch seam (tests). Defaults to {@link startChatsWatch}. */
  startChatsWatch?: (
    load: () => Promise<ChatSummary[]>,
    onChats: (chats: ChatSummary[]) => void
  ) => ChatsWatcherHandle;
  /**
   * Tunnel self-heal seam (tests). Defaults to {@link startTunnelHealthMonitor}.
   * Probes the PUBLIC relay path and cycles cloudflared when it's unreachable while
   * the local api is healthy (recovers a dead/stale gateway mapping).
   */
  startTunnelHealthMonitor?: (
    options: StartTunnelHealthMonitorOptions
  ) => TunnelHealthMonitorHandle;
  /**
   * Start the terminal UI (single Ink instance; QR or menu by `initialPhase`, and
   * `showConnected()` swaps in place). Defaults to {@link startLauncherUi}, or the
   * static print in `--debug` (set by {@link createLauncher}). Seam for tests.
   */
  startUi?: (options: StartLauncherUiOptions) => Promise<LauncherUiHandle>;
  /** Build the loopback pairing server (seam). Defaults to a real {@link PairingServer}. */
  makePairingServer?: (payload: string, endpoint: string) => PairingServer;
  /** Health-poll seam (defaults to the real {@link waitForHealth}). */
  waitForHealthImpl?: typeof waitForHealth;
  /** Pre-render the QR string (seam). Defaults to {@link renderTerminalQr}. */
  renderQr?: (payload: string) => Promise<string>;
  /** Base env (for port resolution). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Boot/steady-state line sink. Defaults to console.log. */
  log?: (line: string) => void;
  /**
   * Detail/warning sink routed to the launcher LOG FILE (not the Ink-owned terminal)
   * so boot warnings never corrupt the live status box. Defaults to {@link log}.
   */
  apiLog?: (line: string) => void;
}

export interface RunResult {
  apiBaseUrl: string;
  health: ApiHealthBody;
  /** The minted data-path JWT carried in the QR. */
  token: string;
  /** The QR payload string scanned by the app. */
  payload: string;
  /** The loopback fallback URL, if the page came up. */
  loopbackUrl?: string;
}

export class Launcher {
  private readonly deps: LauncherDeps;
  private readonly log: (line: string) => void;
  private tunnel: TunnelRouter | null = null;
  private ui: LauncherUiHandle | null = null;
  private pairingServer: PairingServer | null = null;
  private connectionWatch: ConnectionWatcherHandle | null = null;
  private presenceWatch: PresenceWatcherHandle | null = null;
  private chatsWatch: ChatsWatcherHandle | null = null;
  private tunnelHealthMonitor: TunnelHealthMonitorHandle | null = null;
  /**
   * Live mobile-device presence (from {@link startPresenceWatch}). Read by the
   * tunnel health monitor's `isDeviceConnected` predicate: a connected device proves
   * the relay path works end-to-end, so the monitor must NOT cycle cloudflared (that
   * would drop the device and start a reconnection loop). Kept current by the
   * presence-watch callback.
   */
  private connectedDevices: DeviceInfo[] = [];
  private shuttingDown = false;

  constructor(deps: LauncherDeps) {
    this.deps = deps;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** The QR payload string `{ gatewayBase, pcId, token }`. */
  private buildPayload(token: string): string {
    return JSON.stringify({
      gatewayBase: this.deps.gatewayBase,
      pcId: this.deps.pcId,
      token,
    });
  }

  /**
   * Bring the runtime up (steps 3–8). Returns the api health + minted token +
   * QR payload. Does NOT block on signals — see {@link runUntilSignal}.
   *
   * `onQuit` is invoked by the interactive connected menu when the user picks
   * "Quit" (or Ctrl-C); {@link runUntilSignal} passes a callback that resolves its
   * wait → graceful shutdown. Defaults to a no-op (the pairing-QR screen has no
   * quit key — it relies on the SIGINT handler).
   */
  async boot(options: { onQuit?: () => void } = {}): Promise<RunResult> {
    const env = this.deps.env ?? process.env;
    const onQuit = options.onQuit ?? (() => {});

    // 0. Find local Anthropic + GitHub credentials on the OS (and run the
    //    interactive login fallback if missing). This MUST run before the api
    //    spawns (so the api boots with the creds in its store + env) and before
    //    the Ink screen (interactive prompts own the plain terminal).
    if (this.deps.prepareCredentials) {
      // Credential prep must NEVER block boot ("never hard-block"): a corrupt
      // secret store or an fs write failure inside discovery/persist can still throw,
      // so swallow it — the api spawns regardless and surfaces a missing credential
      // at first use.
      try {
        await this.deps.prepareCredentials();
      } catch (err) {
        this.log(
          `[launcher] credential prep failed (continuing): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Detail/warnings go to the file sink so they never corrupt the Ink-owned terminal.
    const detailLog = this.deps.apiLog ?? this.log;

    // Chat actions for the connected menu. The chats client is created AFTER the JWT
    // is minted (below); these callbacks close over it + only fire on user input
    // (after the menu is up), so it's set by then.
    let chatsClient: ChatsClient | null = null;
    const onArchiveChat = (chatId: string) => {
      chatsClient
        ?.archive(chatId, true)
        .then(() => this.chatsWatch?.refresh())
        .catch((err) =>
          detailLog(`[chats] archive failed: ${err instanceof Error ? err.message : String(err)}`)
        );
    };
    const onResumeChat = (chat: ChatSummary) => {
      // Stub for now — eventually `claude --resume <session>` in the repo cwd.
      detailLog(`[chats] resume-in-claude-code requested for ${chat.id} (stub)`);
    };

    // 1. Mount the steady-state terminal UI as a SINGLE Ink instance, starting on a
    //    centered BOOTING box. The boot sequence below updates its status line IN
    //    PLACE (setStatus) instead of scrolling logs; when everything is ready it
    //    switches (ready → rerender) to the pairing QR — or the connected menu if a
    //    device has paired before. `--debug` uses a plain handle that just logs each
    //    status line, since the api logs stream to the terminal there.
    const startUi = this.deps.startUi ?? startLauncherUi;
    try {
      this.ui = await startUi({
        endpoint: this.deps.endpoint,
        pcId: this.deps.pcId,
        label: this.deps.label,
        initialPhase: 'booting',
        status: 'Starting the local runtime…',
        lastConnectedAt: this.deps.lastConnectedAt,
        onQuit,
        onArchiveChat,
        onResumeChat,
      });
    } catch (err) {
      // Terminal can't render Ink — boot continues; status falls back to plain logs.
      this.log(
        `[launcher] terminal UI unavailable (${err instanceof Error ? err.message : String(err)})`
      );
    }
    // Route boot progress to the in-view status line (or plain logs if Ink failed).
    const setStatus = (s: string) => (this.ui ? this.ui.setStatus(s) : this.log(`[launcher] ${s}`));

    // 2. Spawn the api on loopback (JWT secret / pcId / relay wired via createLauncher).
    const apiBaseUrl = resolveApiBaseUrl(env);
    setStatus(`Starting the api on ${apiBaseUrl}…`);
    this.deps.apiProcess.start();

    // 3. Wait for /api/health.
    setStatus('Waiting for the api to be ready…');
    const waitFn = this.deps.waitForHealthImpl ?? waitForHealth;
    const health = await waitFn(apiBaseUrl, {
      isAlive: () => this.deps.apiProcess.isAlive(),
    });

    // 4. Mint the data-path JWT — the launcher owns the credential.
    //    Resolve the GitHub login NOW (after prepareCredentials persisted it)
    //    so a first-ever boot still authors commits as the GitHub user; fall back
    //    to the static dep (back-compat/tests) when no resolver is wired.
    setStatus('Preparing your secure pairing token…');
    const githubLogin = this.deps.resolveGithubLogin?.() ?? this.deps.githubLogin;
    const mint =
      this.deps.mintToken ??
      ((secret) =>
        mintPairingToken(resolvePairingIdentity({ pcId: this.deps.pcId, githubLogin }), secret));
    const token = mint(this.deps.jwtSecret);
    const payload = this.buildPayload(token);

    // The launcher reads chats from the api over loopback with the JWT it just
    // minted (the api populates the session user from the Bearer payload).
    chatsClient = new ChatsClient({ apiBaseUrl, token });

    // 5. Bring up the tunnel-router + pcId-keyed registration agent.
    //    Apple-reviewer opt-in (PORTABLE_REVIEWER_PUBLISH): publish the minted
    //    data-path JWT to the gateway so the disposable reviewer box can serve it
    //    from /auth/mobile/react-native/apple-reviewer-credentials. Default OFF →
    //    reviewerToken stays undefined → the registration body is byte-unchanged and
    //    the gateway holds NO data-path JWT for a NORMAL PC (the invariant).
    setStatus('Opening a secure tunnel…');
    const reviewerToken = resolveReviewerPublish(env) ? token : undefined;
    this.tunnel = this.deps.makeTunnelRouter(apiBaseUrl, reviewerToken);
    await this.tunnel.start();

    // 5b. Wait for the tunnel's FIRST registration handoff (DNS verify + the
    //     `/tunnel/register` POST) to settle before showing anything scannable.
    //     `tunnel.start()` only waits for cloudflared to PRINT a URL — not for the
    //     gateway to actually know about it — so without this gate a user who
    //     scans the instant the QR appears can hit a PC the relay can't route to
    //     yet. Bounded/fail-open (see TunnelRouter.waitForFirstRegistration): a
    //     stuck relay still lets boot proceed instead of hanging forever.
    setStatus('Registering this PC with the relay…');
    const registered = await this.tunnel.waitForFirstRegistration();
    if (!registered) {
      detailLog(
        '[launcher] tunnel registration did not confirm within the timeout — showing the QR anyway (self-heal will recover it)'
      );
    }

    // 6. Serve the loopback-only pairing fallback page (NEVER tunneled).
    setStatus('Starting the pairing page…');
    const makeServer =
      this.deps.makePairingServer ??
      ((p, e) => new PairingServer({ payload: p, endpoint: e, log: detailLog }));
    this.pairingServer = makeServer(payload, this.deps.endpoint);
    let loopbackUrl: string | undefined;
    try {
      loopbackUrl = await this.pairingServer.start();
    } catch (err) {
      detailLog(
        `[pairing] loopback page failed to start: ${err instanceof Error ? err.message : String(err)}`
      );
      this.pairingServer = null;
    }

    // 7. Render the QR and switch the SAME Ink instance from the booting box to the
    //    steady screen (pairing QR, or the connected menu if already paired). A live
    //    marker-watcher (below) then swaps QR → menu IN PLACE on the first connect.
    let qr = '';
    try {
      qr = await (this.deps.renderQr ?? renderTerminalQr)(payload);
    } catch (err) {
      detailLog(`[pairing] QR render failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const steadyPhase: 'pairing' | 'connected' = this.deps.initialConnected
      ? 'connected'
      : 'pairing';
    if (this.ui) {
      this.ui.ready({
        qr,
        phase: steadyPhase,
        loopbackUrl,
        lastConnectedAt: this.deps.lastConnectedAt,
      });
    } else if (loopbackUrl) {
      this.log(`[pairing] open ${loopbackUrl} in a browser to pair.`);
    }

    // Live transition: while the QR is up, watch the marker and switch the SAME Ink
    // instance to the menu the instant a device connects (no stop/restart needed).
    if (this.deps.watchForConnection) {
      const startWatch = this.deps.startConnectionWatch ?? startConnectionWatch;
      this.connectionWatch = startWatch((state) => {
        if (this.shuttingDown) return;
        this.log(
          '[launcher] a device connected — switching to the menu (1: add a device, 2: quit)'
        );
        this.ui?.showConnected(state);
      });
    }

    // Live device presence: poll which mobile devices are connected and feed the
    // connected menu's right-hand column (spinner + "Waiting for mobile device."
    // when none). Runs for the whole session, both phases.
    const startPresence = this.deps.startPresenceWatch ?? startPresenceWatch;
    this.presenceWatch = startPresence((devices) => {
      if (this.shuttingDown) return;
      // Record the live list for the tunnel health monitor's isDeviceConnected check
      // (a connected device must suppress cloudflared cycling — see connectedDevices).
      this.connectedDevices = devices;
      this.ui?.setDevices(devices);
    });

    // Live recent chats: poll the api (loopback) and feed the connected menu's chats
    // column. The list reflects archives within a refresh tick.
    const startChats = this.deps.startChatsWatch ?? startChatsWatch;
    this.chatsWatch = startChats(
      () => (chatsClient ? chatsClient.listRecent() : Promise.resolve([])),
      (chats) => {
        if (this.shuttingDown) return;
        this.ui?.setChats(chats);
      }
    );

    // Tunnel self-heal: continuously verify the PUBLIC relay path the phone uses is
    // reachable (gateway → tunnel → api), and cycle cloudflared when it's broken
    // while the local api is healthy — recovers a dead/stale gateway mapping that a
    // local or direct-tunnel check would both miss. Runs the whole session; the
    // first probe is delayed by the monitor's interval so the tunnel has come up +
    // registered. Detail goes to the file sink (never the Ink-owned terminal).
    const startHealth = this.deps.startTunnelHealthMonitor ?? startTunnelHealthMonitor;
    this.tunnelHealthMonitor = startHealth({
      localHealthUrl: `${apiBaseUrl}/api/health`,
      relayHealthUrl: `${this.deps.endpoint}/api/health`,
      cycle: () => this.tunnel?.cycle(),
      // A connected device proves the relay path works — never cycle (and drop it)
      // while one is live. Self-heal still fires when no device is connected.
      isDeviceConnected: () => this.connectedDevices.length > 0,
      log: detailLog,
    });

    return { apiBaseUrl, health, token, payload, loopbackUrl };
  }

  /** Graceful shutdown: unmount Ink, stop the loopback page + tunnel, then api. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.connectionWatch?.stop();
    this.connectionWatch = null;
    this.presenceWatch?.stop();
    this.presenceWatch = null;
    this.chatsWatch?.stop();
    this.chatsWatch = null;
    this.tunnelHealthMonitor?.stop();
    this.tunnelHealthMonitor = null;
    this.ui?.stop();
    this.ui = null;
    this.log('[launcher] shutting down…');
    try {
      await this.pairingServer?.stop();
    } catch (err) {
      this.log(
        `[launcher] pairing server stop error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    this.pairingServer = null;
    try {
      await this.tunnel?.stop();
    } catch (err) {
      this.log(`[launcher] tunnel stop error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.deps.apiProcess.stop();
    this.log('[launcher] stopped');
  }

  /**
   * Full one-command lifecycle: boot, install SIGINT/SIGTERM handlers, then block
   * until a signal arrives OR the api process exits, and shut down gracefully.
   */
  async runUntilSignal(): Promise<void> {
    // Set up the "stop waiting" trigger BEFORE boot so the connected menu's Quit
    // key (onQuit) is live the instant the UI mounts (no microtask race).
    let settled = false;
    let resolveWait!: () => void;
    const waitUntilDone = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      resolveWait();
    };

    const onSignal = (signal: NodeJS.Signals) => {
      this.log(`[launcher] received ${signal}`);
      finish();
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));

    // The connected menu's "Quit" (or Ctrl-C inside Ink) resolves the same wait.
    await this.boot({
      onQuit: () => {
        this.log('[launcher] quit requested from menu');
        finish();
      },
    });

    // If the api dies on its own, stop waiting and tear down.
    this.deps.apiProcess.waitUntilExit().then(() => {
      this.log('[launcher] api exited — tearing down');
      finish();
    });

    await waitUntilDone;
    await this.shutdown();
  }
}

export interface CreateLauncherOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /**
   * Sink for the api child's ongoing stdout/stderr. The real CLI routes this to
   * the launcher LOG FILE so it never interleaves with the Ink-owned terminal.
   * Defaults to the boot `log`.
   */
  apiLog?: (line: string) => void;
  /**
   * `portable start --debug` — stream the api logs to the terminal so the user
   * can watch connections arrive. In debug mode the live Ink pairing screen is
   * replaced with a one-shot static QR print ({@link printStaticPairingInfo}) so
   * the streamed `[api]` lines don't fight Ink for the terminal, and the api
   * child is told to emit its extra per-connection diagnostics (`PORTABLE_DEBUG`).
   * The `apiLog` sink is expected to tee to the terminal (set up in the CLI).
   */
  debug?: boolean;
}

/**
 * Best-effort read of the connected GitHub login from the shared store.
 *
 * `LocalGitHubAuthService` / `CredentialResolver` persist the device-flow token as
 * a JSON record under `github-oauth:token` (`{ token, scopes?, login?, … }`). When a
 * login is present we prefer it as the minted JWT's `username` (so git commits are
 * authored as the GitHub user, not `os.hostname()`). A missing / unparseable record
 * must NOT throw — fall back to the hostname behavior in {@link resolvePairingIdentity}.
 */
export function readStoredGitHubLogin(store: Pick<LocalSecretStore, 'get'>): string | undefined {
  try {
    // Same JSON record the api reads (LocalGitHubAuthService.GITHUB_DEVICE_TOKEN_KEY).
    const raw = store.get('github-oauth:token');
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { login?: unknown };
    const login = typeof parsed.login === 'string' ? parsed.login.trim() : '';
    return login.length > 0 ? login : undefined;
  } catch {
    return undefined;
  }
}

/** Wire the real launcher (LocalSecretStore + JWT mint + ApiProcess + TunnelRouter + Ink/loopback). */
export async function createLauncher(options: CreateLauncherOptions = {}): Promise<Launcher> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const apiLog = options.apiLog ?? log;
  const store = new LocalSecretStore();

  // Connected-aware CLI: read the cross-process "ever connected" marker the api
  // stamps on each authenticated device connection. When a device has connected
  // before (and we're NOT in --debug), show the compact connected MENU instead of
  // the pairing QR — the phone already holds this PC's pcId+JWT and reconnects on
  // its own. Best-effort: a missing/corrupt marker reads as "never connected".
  const pairingState = new PairingStateStore().read();
  const everConnected = typeof pairingState.firstConnectedAt === 'string';

  // Ensure the local JWT secret (generate + persist on first boot) and
  // share it with the api child so the api validates the launcher-minted JWT.
  const jwtSecret = ensureJwtSecret(store, env);
  const pcId = resolvePcId(store, env);
  const label = resolvePcLabel(env);
  const gatewayBase = resolveRelayBaseUrl(env);
  const endpoint = `${gatewayBase}/t/${pcId}`;

  const debug = options.debug ?? false;

  // Ensure a local Chromium for the REQUIRED Playwright MCP and forward its path
  // to the api child (the api reads PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH at module
  // load, so it MUST be resolved BEFORE the ApiProcess is constructed). HARD-FAILS
  // (throws CHROMIUM_INSTALL_HINT) if no browser can be provisioned — surfaced by
  // cli.ts as a fatal with the install hint.
  const { executablePath: chromiumExecutablePath } = ensureChromium({ env, log });

  // Resolve the operator's WORKSPACE_DIR (shell env or root .env) and
  // forward it to the api child so portable operates on the user's pre-existing
  // cloned repos. Without this the value set in the operator's .env is silently
  // dropped (the launcher loads no .env; the api child skips parsing it because
  // VGIT_PORT forces BUN_LOADED_ENV_FILE true).
  const workspaceDir = resolveOperatorWorkspaceDir(env);
  if (workspaceDir) {
    log(`[launcher] workspace → ${workspaceDir} (operator WORKSPACE_DIR forwarded to the api)`);
  }

  // Auto-provision cloudflared (download the official static binary once via the
  // `cloudflared` package, cross-platform) so the user need NOT install it via
  // winget/brew/apt. Falls back to an already-installed cloudflared (PATH / win32
  // probe / PORTABLE_CLOUDFLARED_BIN) when the download is unavailable (offline).
  const cloudflaredBin = await ensureCloudflared({ env, log });

  const apiProcess = new ApiProcess({
    env,
    log: apiLog,
    childEnvOverrides: {
      jwtSecret,
      pcId,
      relayBaseUrl: gatewayBase,
      debug,
      chromiumExecutablePath,
      workspaceDir,
    },
  });

  // --debug: drop the live Ink screen (it would clobber the streamed api logs) for a
  // plain-text handle that logs each boot status line + prints the QR once, leaving
  // the terminal free for the logs to scroll. Its showConnected() is a no-op log, so
  // the live transition is naturally disabled.
  const startUi: LauncherDeps['startUi'] = debug
    ? (opts) => startStaticUi({ ...opts, log })
    : undefined;

  // Prefer the connected GitHub login as the minted JWT's username so git
  // commits are authored as the GitHub user (boot() feeds this into
  // resolvePairingIdentity). Persisted into the shared store by prepareCredentials
  // (discovery) / LocalGitHubAuthService (device flow). ⚠️ Read the store eagerly
  // HERE only for back-compat — on a FIRST-EVER boot it is still absent at this
  // point (prepareCredentials hasn't run yet), so boot() re-reads it AT MINT TIME
  // via resolveGithubLogin (after prepareCredentials persists it). When neither
  // has a login, resolvePairingIdentity falls back to the sanitized hostname.
  const githubLogin = readStoredGitHubLogin(store);

  return new Launcher({
    apiProcess,
    jwtSecret,
    pcId,
    endpoint,
    label,
    gatewayBase,
    githubLogin,
    // Read the GitHub login at MINT TIME over the SAME store (after
    // prepareCredentials persisted it) — the first-ever-boot fix.
    resolveGithubLogin: () => readStoredGitHubLogin(store),
    startUi,
    // Route boot detail/warnings to the api LOG FILE so they never corrupt the
    // Ink-owned terminal (the live status box).
    apiLog,
    // Mount on the connected menu only when a device has paired before AND we're
    // not streaming logs in --debug (which owns the terminal with a static QR print).
    initialConnected: everConnected && !debug,
    lastConnectedAt: pairingState.lastConnectedAt,
    // Otherwise (never connected, non-debug): show the QR but watch the marker so
    // the screen swaps to the menu the instant a device connects — no restart.
    watchForConnection: !everConnected && !debug,
    // Discover Anthropic + GitHub creds on the OS (and run the
    // interactive login fallback if missing) into the SAME store/env the api
    // child reads, before the api spawns + before the Ink screen takes over.
    prepareCredentials: async () => {
      await prepareCredentials({ store, env, log });
    },
    makeTunnelRouter: (apiBaseUrl, reviewerToken) => {
      // The registration agent keeps the hosted relay pointed at this PC's
      // current tunnel URL. pcId-keyed, NO Clerk, NO shared secret;
      // the relay hardens open registration with a URL allowlist + rate-limit.
      // Driven by the router's onTunnelUrl seam (first capture + every
      // rotation) and torn down via onStop.
      //
      // reviewerToken is the launcher-minted data-path JWT to PUBLISH on register —
      // set by boot() ONLY when the Apple-reviewer opt-in (PORTABLE_REVIEWER_PUBLISH)
      // is on, else undefined so a NORMAL PC's register body is byte-unchanged and
      // the gateway holds NO data-path JWT (the invariant).
      const agent = new TunnelRegistrationAgent({
        pcId,
        label,
        relayBaseUrl: gatewayBase,
        reviewerToken,
        log: apiLog,
        // Gate registration on the freshly-captured tunnel URL being genuinely
        // live from the public internet (DNS resolves + /api/health serves) — so
        // the gateway's first resolution of it lands on a real record (no 30-min
        // NXDOMAIN negative-cache poison) on a live edge route (no 530). Fail-open:
        // verifyPublicUrl throws on timeout, we map that to `false`, and the agent
        // registers anyway. `/api/health` is unauthenticated on the api, so the
        // probe needs no token.
        verifyUrl: async (url) => {
          try {
            await verifyPublicUrl(url, {
              path: '/api/health',
              timeoutMs: 30_000,
              dnsTimeoutMs: 20_000,
              log: apiLog,
            });
            return true;
          } catch {
            return false;
          }
        },
      });
      // → file sink (not console): the Ink status box owns the terminal during boot.
      apiLog(`[register] PC ${pcId} → ${agent.getEndpoint()} (this endpoint is in the pairing QR)`);
      return new TunnelRouter({
        apiBaseUrl,
        onTunnelUrl: (url) => agent.onTunnelUrl(url),
        onStop: () => agent.stop(),
        // Auto-provisioned cloudflared path (download-once via the `cloudflared`
        // package, else an installed binary / PORTABLE_CLOUDFLARED_BIN) — resolved
        // above by ensureCloudflared so it's ready before the tunnel starts.
        cloudflaredBin,
        log: apiLog,
      });
    },
    env,
    log,
  });
}
