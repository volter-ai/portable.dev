/**
 * AppShell — the root gate ladder + provider composition (local-first unwrap).
 *
 * Composes every already-built primitive in the documented order so the app
 * boots through the right sequence of states. From outermost to innermost:
 *
 *   1. ClerkAuthProvider — mounted at `app/_layout.tsx` (around this shell).
 *   2. VersionGate — the outermost in-shell gate: a stale app (below the gateway
 *      minimum via the public `GET /api/min-version-v2`) is force-updated before
 *      any auth / PC-connect runs. Fails open.
 *   3. StartupGate — the Clerk sign-in gate: a persisted authToken ⇒ in; else
 *      redirect to `/sign-in` (Clerk sign-in is KEPT — only the OnboardingGate
 *      was unwrapped in the local-first pivot).
 *   4. PcConnectGateHost — the local-first replacement for the old
 *      onboarding + provisioning gates: a returning device reconnects to the PC
 *      it already holds a device token for; a fresh device picks a PC and scans
 *      the pairing QR to link one. Once a PC is connected the rest of the ladder
 *      talks to the stable `<gatewayBase>/t/<pcId>` relay endpoint.
 *   5. SandboxSessionBoundary — the epoch-keyed remount line + the
 *      guard-capped death handler. A confirmed sandbox death clears the legacy
 *      sandbox URL (the connected PC + device token are PRESERVED) and bumps the
 *      epoch: everything below unmounts (the dead socket's io manager stops; the
 *      in-memory stores reset) and remounts — exactly like a cold start, but
 *      reconnecting to the SAME stable relay endpoint (rotation = silent
 *      reconnect). An exhausted guard window replaces the subtree with
 *      ConnectionFailedScreen.
 *   6. StartupHealthGate — cold-start/boot backoff health check
 *      (body-validated) against the relay endpoint; its exhaustion feeds the
 *      death handler too.
 *   7. ApiProvider + SocketProvider — server state +
 *      live socket, both built fresh per session epoch (the provider renders
 *      SystemWarnings + ReconnectingBanner; `system:idle_shutdown` /
 *      `session:expired` re-enter the death handler).
 *   8. SessionReadyLayer — mounts the health monitor wired to
 *      the death handler, around the authenticated tree. (The phone-side
 *      GitHubPermissionGate / ScopesChecker was REMOVED in the local-first pivot:
 *      GitHub credentials live on the PC — the launcher resolves them — so the app
 *      never asks the user to connect GitHub from the phone.)
 *
 * Every collaborator is injectable so a router-level test drives the full ladder
 * deterministically with mocked HTTP / socket / health / PC-connect and no native
 * modules. Production uses the defaults (the device layout wires the Clerk-backed
 * PC-connect config).
 */

import { useEffect, type ReactNode } from 'react';

import { ActivityIndicatorSync, type ActivityIndicatorSyncDeps } from '../activity-indicator';

import { ApiProvider, type ApiProviderProps } from '../api';
import { UtmAttributionSync } from '../attribution';
// FILE import (not the chat barrel) so the shell does not pull the heavy chat graph.
import { ChatListSync } from '../chat/ChatListSync';
import { ThemeSync } from '../theme/ThemeSync';
import { StartupGate } from '../auth/StartupGate';
import type { StartupGateDeps } from '../auth/useStartupGate';
import {
  useSandboxHealthMonitor,
  useSandboxSessionStore,
  type RecoveryLoopGuard,
  type SandboxHealthMonitorDeps,
} from '../health';
import { StartupHealthGate } from '../health/StartupHealthGate';
import type { UseStartupHealthCheckDeps } from '../health/useStartupHealthCheck';
import type { PcConnectConfig } from '../pc-connect';
import { StoreReviewTracker } from '../review';
import type { UseStoreReviewPromptDeps } from '../review';
import { PushSetupLayer } from '../settings/sections/notifications/PushSetupLayer';
import { SocketProvider, type NativeSocketDeps, type NetInfoLike } from '../socket';
import { VersionGate, type VersionGateDeps } from '../version-update';

import { PcConnectGateHost } from './PcConnectGateHost';
import { SandboxSessionBoundary, useSandboxDeath } from './SandboxSessionBoundary';

/** Death-handling seams (the sandbox-session boundary + monitor). */
export interface ShellRecoveryConfig {
  /** Full override of the death handler (router-level tests inject a spy). */
  onDeath?: () => void;
  /** NetInfo source for the offline-vs-down copy on the terminal screen. */
  netInfo?: NetInfoLike;
  /** Pre-built guard (tests inject a deterministic clock). */
  guard?: RecoveryLoopGuard;
  /** Injectable health-monitor seams (URL/fetch/AppState/NetInfo/clock). */
  healthMonitor?: SandboxHealthMonitorDeps;
}

export interface AppShellProps {
  /** The authenticated app tree (the tabs / stack). */
  children: ReactNode;
  /**
   * VersionGate deps (default: read the bundled app version + fetch the gateway
   * minimum). The OUTERMOST gate — a stale app is force-updated before any auth /
   * PC-connect runs. The check fails open.
   */
  version?: VersionGateDeps;
  /** StartupGate deps (default: read the persisted authToken from SecureStore). */
  startup?: StartupGateDeps;
  /**
   * PC-connect gate config. The device layout supplies the
   * Clerk-backed config (`buildPcConnectConfig`); router-level tests inject fakes.
   * When omitted the gate is SKIPPED (a test exercising only the inner ladder).
   */
  pcConnect?: PcConnectConfig;
  /** StartupHealthGate deps (default: real fetch + SecureStore sandbox URL). */
  health?: UseStartupHealthCheckDeps;
  /** ApiProvider overrides (client/queryClient/netInfo). */
  api?: Omit<ApiProviderProps, 'children'>;
  /** SocketProvider deps (getAuthToken/getRelayUrl/appState/netInfo/…). */
  socket?: NativeSocketDeps;
  /** Death-handling seams. */
  recovery?: ShellRecoveryConfig;
  /** Store-review tracker seams (default: 30-min foreground budget → native prompt). */
  review?: UseStoreReviewPromptDeps;
  /**
   * Activity-indicator seams (default: the platform backend — iOS Live
   * Activity). A render-null sync that mirrors the running-chat set into the
   * OS-level indicator.
   */
  activity?: ActivityIndicatorSyncDeps;
  /** Route to send a re-auth user to (default `/sign-in`). */
  signInHref?: string;
}

export function AppShell({
  children,
  version,
  startup,
  pcConnect,
  health,
  api,
  socket,
  recovery,
  review,
  activity,
  signInHref,
}: AppShellProps) {
  return (
    <VersionGate deps={version}>
      <StartupGate deps={startup} signInHref={signInHref}>
        <MaybePcConnectGate config={pcConnect}>
          <SandboxSessionBoundary
            guard={recovery?.guard}
            netInfo={recovery?.netInfo}
            onDeath={recovery?.onDeath}
          >
            {/* Re-arm death handling above StartupHealthGate so a failed boot of
                the reconnected sandbox can re-enter the death handler
                (guard-capped). */}
            <SessionLiveMarker />
            <GatedStartupHealth health={health}>
              <ApiProvider {...api}>
                <ThemeSync />
                {/* Refresh the chat directory cache when a chat is created (any
                    create path / any device) so the new chat shows up in the
                    list + the home preview without an app restart. */}
                <ChatListSync />
                {/* OS-level ongoing-chat activity indicator: iOS Live
                    Activity, kept in sync with the running-chat set. */}
                <ActivityIndicatorSync deps={activity} />
                <StoreReviewTracker deps={review} />
                {/* Push notifications: foreground handler + Android
                    channel + tap deep-link + the one-time permission prompt. */}
                <PushSetupLayer />
                {/* UTM attribution: capture campaign UTM from the launch
                    deep link + report it to the gateway ONCE per user. */}
                <UtmAttributionSync />
                <SocketWithDeathHandoff socket={socket}>
                  <SessionReadyLayer recovery={recovery}>{children}</SessionReadyLayer>
                </SocketWithDeathHandoff>
              </ApiProvider>
            </GatedStartupHealth>
          </SandboxSessionBoundary>
        </MaybePcConnectGate>
      </StartupGate>
    </VersionGate>
  );
}

/**
 * Mount the PC-connect gate when a config is supplied (production: the layout's
 * Clerk-backed config; tests: an injected fake). When omitted — a router-level
 * test exercising only the inner ladder — the gate is skipped and children render
 * directly.
 */
function MaybePcConnectGate({
  config,
  children,
}: {
  config?: PcConnectConfig;
  children: ReactNode;
}) {
  if (!config) return <>{children}</>;
  return <PcConnectGateHost config={config}>{children}</PcConnectGateHost>;
}

/**
 * Marks the sandbox session LIVE (re-arms the death handler) the moment the gate
 * renders its children. Positioned ABOVE `StartupHealthGate` on purpose: a
 * reconnected sandbox whose server never boots must be able to re-enter the death
 * handler (`reprovisioning` would otherwise still mute it).
 */
function SessionLiveMarker() {
  useEffect(() => {
    useSandboxSessionStore.getState().markSessionLive();
  }, []);
  return null;
}

/**
 * StartupHealthGate wired into the death handler: exhausting the boot backoff
 * budget against the sandbox is a death signal like any other — guard-capped
 * recovery instead of the old static dead-end screen.
 */
function GatedStartupHealth({
  health,
  children,
}: {
  health?: UseStartupHealthCheckDeps;
  children: ReactNode;
}) {
  const onDeath = useSandboxDeath();
  return (
    <StartupHealthGate deps={health} onUnhealthy={onDeath}>
      {children}
    </StartupHealthGate>
  );
}

/**
 * SocketProvider with the lifecycle → death hand-off: `system:idle_shutdown` /
 * `session:expired` (the SystemWarnings overlay) invoke the boundary's death
 * handler. The epoch remount that follows unmounts this very provider — its
 * cleanup stops the io manager and resets the in-memory stores, which also
 * clears the overlay.
 */
function SocketWithDeathHandoff({
  socket,
  children,
}: {
  socket?: NativeSocketDeps;
  children: ReactNode;
}) {
  const onDeath = useSandboxDeath();
  return (
    <SocketProvider {...socket} onReprovision={onDeath}>
      {children}
    </SocketProvider>
  );
}

/**
 * The session-ready layer (step 8) — mounts the health monitor (fresh per
 * session epoch, so it reads the relay endpoint at mount) wired straight into the
 * death handler, then the authenticated children. (The phone-side GitHub-connect
 * gate was REMOVED in the local-first pivot — GitHub credentials live on the PC,
 * resolved by the launcher, so there is nothing to connect from the phone.)
 */
function SessionReadyLayer({
  recovery,
  children,
}: {
  recovery?: ShellRecoveryConfig;
  children: ReactNode;
}) {
  const onDeath = useSandboxDeath();

  useSandboxHealthMonitor({
    onSandboxDead: onDeath,
    ...recovery?.healthMonitor,
  });

  return <>{children}</>;
}
