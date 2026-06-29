/**
 * ChatChrome — the per-chat context band that frames the transcript,
 * composing all of its surfaces via {@link useChatChrome}: the container
 * setup banner, the AI summary panel, the git status banner (with a trailing
 * runtime/tunnel indicator), and the quick-actions bar. Each surface
 * self-hides when it has nothing to show.
 *
 * Tapping a quick action / the git banner is delegated to the parent (the
 * repo-viewer route + the send-as-message flow live in E5 / the composer) via
 * `onQuickAction` / `onOpenRepo`.
 */

import type { QuickAction } from '@vgit2/shared/types';
import { View } from 'react-native';

import { ChatSummaryPanel } from './ChatSummaryPanel';
import { ContainerStatusBanner } from './ContainerStatusBanner';
import { GitStatusBanner } from './GitStatusBanner';
import { QuickActionsBar } from './QuickActionsBar';
import { RuntimeIndicator } from './RuntimeIndicator';
import { useChatChrome } from './useChatChrome';

export interface ChatChromeProps {
  chatId: string;
  repoPath?: string;
  onQuickAction?: (action: QuickAction) => void;
  onOpenRepo?: (repo: { owner: string; repo: string }) => void;
}

export function ChatChrome({ chatId, repoPath, onQuickAction, onOpenRepo }: ChatChromeProps) {
  const {
    gitStatus,
    quickActions,
    quickActionsLoading,
    summary,
    containerStatus,
    tunnels,
    processes,
  } = useChatChrome({ chatId, repoPath });

  return (
    <View testID="chat-chrome">
      {containerStatus && <ContainerStatusBanner status={containerStatus} />}
      <ChatSummaryPanel summary={summary} />
      <GitStatusBanner
        gitStatus={gitStatus}
        repoPath={repoPath}
        onPress={onOpenRepo}
        trailing={<RuntimeIndicator tunnelCount={tunnels.length} processCount={processes.length} />}
      />
      <QuickActionsBar
        quickActions={quickActions}
        loading={quickActionsLoading}
        onActionPress={(action) => onQuickAction?.(action)}
      />
    </View>
  );
}
