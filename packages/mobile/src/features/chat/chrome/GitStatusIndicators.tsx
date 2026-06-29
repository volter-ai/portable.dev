/**
 * GitStatusIndicators — renders the branch name plus the
 * ahead/behind and staged/modified/untracked counts as compact inline chips.
 * Zero-count categories are omitted.
 */

import type { GitStatus } from '@vgit2/shared/types';
import { StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../../theme';

export interface GitStatusIndicatorsProps {
  gitStatus: GitStatus;
  showBranch?: boolean;
}

export function GitStatusIndicators({ gitStatus, showBranch = true }: GitStatusIndicatorsProps) {
  const { theme } = useAppTheme();
  const { branch, ahead, behind, staged, modified, untracked } = gitStatus;

  return (
    <View style={styles.row} testID="git-status-indicators">
      {showBranch && (
        <Text
          style={[styles.branch, { color: theme.colors.text }]}
          numberOfLines={1}
          testID="git-branch"
        >
          {branch}
        </Text>
      )}
      {ahead > 0 && (
        <Text style={[styles.count, { color: theme.colors.info }]} testID="git-ahead">
          ↑{ahead}
        </Text>
      )}
      {behind > 0 && (
        <Text style={[styles.count, { color: theme.colors.warning }]} testID="git-behind">
          ↓{behind}
        </Text>
      )}
      {staged > 0 && (
        <Text style={[styles.count, { color: theme.colors.textSecondary }]} testID="git-staged">
          ●{staged}
        </Text>
      )}
      {modified > 0 && (
        <Text style={[styles.count, { color: theme.colors.warning }]} testID="git-modified">
          ✎{modified}
        </Text>
      )}
      {untracked > 0 && (
        <Text style={[styles.count, { color: theme.colors.textSecondary }]} testID="git-untracked">
          +{untracked}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  branch: { fontSize: 12, fontWeight: '600', flexShrink: 1 },
  count: { fontSize: 12, fontWeight: '600' },
});
