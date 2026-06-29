/**
 * TaskItemViewer — the full-screen modal host for the issue/PR detail viewers.
 * Renders {@link IssueViewer} or {@link PullViewer} for the
 * current {@link ViewerTarget}; cross-referenced timeline links swap targets
 * in place (`onOpenTarget`, a modal-to-modal hand-off). The header's
 * repo link routes to the repo page and closes.
 */

import { router } from 'expo-router';
import { Linking, Modal, StyleSheet, View } from 'react-native';

import { useWindowInsets } from '../../shell/windowInsets';
import { useAppTheme } from '../../../theme';

import { IssueViewer } from './IssueViewer';
import { PullViewer } from './PullViewer';
import { useViewerChat, type UseViewerChatOptions } from './useViewerChat';
import type { ViewerTarget } from './viewerTypes';

export interface TaskItemViewerProps {
  target: ViewerTarget | null;
  onClose: () => void;
  /** Swap to another issue/PR (timeline cross-references, related chips). */
  onOpenTarget: (target: ViewerTarget) => void;
  /** External-url seam (commit links; default the system browser). */
  openExternal?: (url: string) => void;
  /** Navigation seam for the header repo link (default expo-router push). */
  navigateToRepo?: (owner: string, repo: string) => void;
  /** AI-action seams (tests inject navigate/makeChatId). */
  chatOptions?: UseViewerChatOptions;
}

export function TaskItemViewer({
  target,
  onClose,
  onOpenTarget,
  openExternal,
  navigateToRepo,
  chatOptions,
}: TaskItemViewerProps) {
  // WINDOW insets, not the ambient context: a full-screen Modal escapes any
  // in-flow safe-area override (a host that consumes the top inset and zeroes
  // it for the subtree below), so it pads by the original window insets — the
  // shared Modal convention (see src/features/shell/windowInsets.tsx). Padding
  // by an overridden inset would put the header under the status bar.
  const insets = useWindowInsets();
  const { theme } = useAppTheme();
  const chat = useViewerChat(chatOptions);

  if (!target) return null;

  const openUrl = openExternal ?? ((url: string) => void Linking.openURL(url));
  const onRepoPress = () => {
    (navigateToRepo ?? ((owner: string, repo: string) => router.push(`/repos/${owner}/${repo}`)))(
      target.owner,
      target.repo
    );
    onClose();
  };

  const viewerProps = {
    target,
    onClose,
    onOpenTarget,
    onRepoPress,
    openExternal: openUrl,
    chat,
  };

  // Keyed by target identity so an in-place swap (cross-reference hand-off)
  // REMOUNTS the viewer — local state (comment draft, active tab, expanded
  // files) must not leak across items (reset per prNumber).
  const viewerKey = `${target.kind}-${target.owner}/${target.repo}#${target.number}`;

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} testID="task-item-viewer">
      <View
        style={[
          styles.container,
          { paddingTop: insets.top, backgroundColor: theme.colors.background },
        ]}
      >
        {target.kind === 'issue' ? (
          <IssueViewer key={viewerKey} {...viewerProps} />
        ) : (
          <PullViewer key={viewerKey} {...viewerProps} />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});
