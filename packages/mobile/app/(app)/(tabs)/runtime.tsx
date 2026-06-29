import { RuntimeOverviewScreen } from '@/features/runtime';

// Runtime tab (`/runtime`) — the sandbox runtime overview hub: metrics + memory
// state and collapsible Sessions / Tunnels / Processes sections whose cards open
// the detail screens under `app/(app)/runtime/*` (pushed over the tab bar), plus
// a Storage (file manager) entry. Thin shell. The app-shell mounts the tabs under
// SocketProvider so the runtime stream is live (degrades to empty via
// useOptionalSocket when no socket is present).
export default function RuntimeTab() {
  return <RuntimeOverviewScreen />;
}
