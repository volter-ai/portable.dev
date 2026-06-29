/**
 * Chat chrome — git status banner, AI summary panel, quick-actions
 * bar, container-status banner, and runtime/tunnel indicator that frame the
 * active-chat transcript.
 */

export { ChatChrome } from './ChatChrome';
export type { ChatChromeProps } from './ChatChrome';
export { GitStatusBanner } from './GitStatusBanner';
export { GitStatusIndicators } from './GitStatusIndicators';
export { ContainerStatusBanner } from './ContainerStatusBanner';
export { QuickActionsBar } from './QuickActionsBar';
export { ChatSummaryPanel } from './ChatSummaryPanel';
export { RuntimeIndicator } from './RuntimeIndicator';
export { useChatChrome } from './useChatChrome';
export type { UseChatChromeResult } from './useChatChrome';
export { buildChatQuickActions, MAX_QUICK_ACTIONS } from './quickActions';
export { useChatRepoPath } from './useChatRepoPath';
export { useChatChromeStore } from './chatChromeStore';
export type { ContainerStatus } from './chatChromeStore';
