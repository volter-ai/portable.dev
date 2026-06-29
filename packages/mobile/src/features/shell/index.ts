/**
 * App-shell feature (local-first unwrap) — the root gate ladder
 * + provider composition that mounts every already-built primitive (StartupGate →
 * PcConnectGateHost → SandboxSessionBoundary → StartupHealthGate → ApiProvider +
 * SocketProvider → recovery) behind the authenticated tree.
 */

export { AppShell, type AppShellProps, type ShellRecoveryConfig } from './AppShell';
export { PcConnectGateHost, type PcConnectGateHostProps } from './PcConnectGateHost';
