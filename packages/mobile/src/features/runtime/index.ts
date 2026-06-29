/**
 * Runtime feature (native multi-screen port) — the local-first PC
 * runtime: Overview hub (host CPU/RAM metrics) with collapsible Tunnels /
 * Background tasks / Claude sessions sections, plus dedicated list + detail
 * screens. Apple-compliant user-URL viewing (Android embed / iOS system browser)
 * via {@link SandboxWebView}. Socket-sourced via `useRuntime` → `runtimeStore`;
 * background-task output over the PC API.
 */

export {
  RuntimeOverviewScreen,
  RuntimeOverviewScreen as RuntimeBox,
  type RuntimeOverviewProps,
} from './RuntimeOverviewScreen';

export { RuntimeMetrics } from './RuntimeMetrics';
export { RuntimeHeader, type RuntimeHeaderProps } from './RuntimeHeader';
export { ProcessCard, TunnelCard } from './cards';

export { TunnelsListScreen } from './TunnelsListScreen';
export { TunnelDetailScreen, type TunnelDetailProps } from './TunnelDetailScreen';
export { ProcessesListScreen } from './ProcessesListScreen';
export { ProcessDetailScreen } from './ProcessDetailScreen';
export { ProcessTerminal } from './ProcessTerminal';
export { SandboxWebView, type SandboxWebViewProps, type WebViewLike } from './SandboxWebView';

export { runtimeRoutes, type RuntimeNavigate } from './runtimeRoutes';

export { useRuntime } from './useRuntime';

export { useProcessOutput, type ProcessOutput } from './useProcessOutput';
export { ansiToSpans, type AnsiSpan } from './ansiToSpans';
