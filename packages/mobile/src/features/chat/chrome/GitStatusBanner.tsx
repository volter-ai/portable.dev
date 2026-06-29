/**
 * GitStatusBanner — a compact, tappable row showing the current branch + git
 * status; tapping navigates to the repo's changes view (the press is an
 * injectable `onPress`).
 * Local repos (`owner === 'local'`) render nothing (no GitHub remote).
 */

import type { GitStatus } from '@vgit2/shared/types';
import { getRepoFromPath } from '@vgit2/shared/utils/pathHelpers';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../../theme';

import { GitStatusIndicators } from './GitStatusIndicators';

export interface GitStatusBannerProps {
  gitStatus?: GitStatus;
  /** Repo path (`~/claude-workspace/{email}/{owner}/{repo}`) — used for owner/repo. */
  repoPath?: string;
  /** Tapped to view diffs (repo-viewer route is E5); receives `{ owner, repo }`. */
  onPress?: (repo: { owner: string; repo: string }) => void;
  /** Optional trailing slot (e.g. the runtime/tunnel indicator). */
  trailing?: React.ReactNode;
}

export function GitStatusBanner({ gitStatus, repoPath, onPress, trailing }: GitStatusBannerProps) {
  const { theme } = useAppTheme();
  const repoFullName = getRepoFromPath(repoPath);
  const repoInfo = repoFullName
    ? { owner: repoFullName.split('/')[0], repo: repoFullName.split('/')[1] }
    : null;

  const isLocalRepo = repoInfo?.owner === 'local';
  // Nothing to show: a local repo (no remote) or no status + no trailing slot.
  if (isLocalRepo) return null;
  if (!gitStatus && !trailing) return null;

  const clickable = repoInfo !== null && !!onPress;
  const handlePress = () => {
    if (repoInfo && onPress) onPress(repoInfo);
  };

  return (
    <Pressable
      testID="git-status-banner"
      disabled={!clickable}
      onPress={handlePress}
      style={[styles.banner, { borderBottomColor: theme.colors.borderLight }]}
    >
      {gitStatus ? (
        <View style={styles.left}>
          <Text style={[styles.icon, { color: theme.colors.textSecondary }]}>⎇</Text>
          <GitStatusIndicators gitStatus={gitStatus} showBranch />
        </View>
      ) : (
        <View style={styles.left} />
      )}
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  left: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  icon: { fontSize: 12, opacity: 0.7 },
  trailing: { flexShrink: 0 },
});
