import { Stack } from 'expo-router';
import { useMemo } from 'react';

import { buildPcConnectConfig } from '@/features/pc-connect';
import { AppShell } from '@/features/shell';

/**
 * Authenticated route-group layout (US-008, hardened; local-first US-E6-001, rev6).
 *
 * Mounts the {@link AppShell} gate ladder (StartupGate → PcConnectGateHost →
 * SandboxSessionBoundary → StartupHealthGate → ApiProvider + SocketProvider →
 * recovery) around a nested `<Stack>` that owns every
 * authenticated route: the `(tabs)` bottom-tab group plus the `chat`/`repos`
 * detail stacks (so opening a detail pushes OVER the tab bar).
 *
 * Why a route GROUP instead of conditionally wrapping the ROOT navigator in
 * `AppShell` (the previous `app/_layout` pattern): the public `/sign-in` route is
 * a SIBLING of this group, so it renders WITHOUT the gate ladder (no StartupGate
 * redirect loop), while the root navigator stays mounted at a stable position and
 * only ever hands authenticated URLs to THIS layout. That means an authenticated
 * screen can never render outside `AppShell` during the `/sign-in → /` transition
 * — the Expo Router "flash of protected content" race that previously rendered
 * `ChatComposer` under the bare root `<Stack>` and crashed with
 * `useApi() must be used within an <ApiProvider>`.
 *
 * `pcConnect={buildPcConnectConfig()}` is the local-first PC-connect wiring. rev6
 * makes pairing QR-ONLY and removes Clerk from this path entirely (no `/my-pcs`
 * discovery, no `/link-pc` round-trip — the QR carries the PC-minted data-path JWT,
 * D16/D19), so the layout no longer resolves a Clerk session token. The old
 * `sse={openDeviceSse}` provisioning wiring was removed with the gateway
 * provisioning gate (the PC's own runtime replaces Modal provisioning).
 */
export default function AppLayout() {
  const pcConnect = useMemo(() => buildPcConnectConfig(), []);
  return (
    <AppShell pcConnect={pcConnect}>
      <Stack screenOptions={{ headerShown: false }} />
    </AppShell>
  );
}
