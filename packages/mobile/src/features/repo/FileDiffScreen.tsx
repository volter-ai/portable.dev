/**
 * FileDiffScreen — the source-control per-file diff screen (portable.dev#17).
 *
 * Pushed when a {@link ChangesView} row is tapped (`/repos/:owner/:repo/diff?
 * path=&staged=`). Owns its safe-area chrome (the Stack runs `headerShown:false`
 * — same pattern as RepoPageScreen / FileViewerScreen): a bordered header with a
 * chevron back + the file basename, then the shared {@link UnifiedDiffView} fed
 * by {@link useFileDiff}.
 *
 * v1 is read-only — staging/discarding from the diff is a write-parity follow-up
 *. The `staged` flag only selects which diff to show (index↔HEAD vs
 * worktree↔index).
 */

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { UnifiedDiffView } from '../../components/UnifiedDiffView';
import { Icon, useAppTheme } from '../../theme';
import { useFileDiff } from './useFileDiff';

export interface FileDiffScreenProps {
  owner: string;
  repo: string;
  /** Repo-relative file path. */
  filePath: string;
  /** Diff the index against HEAD (`true`) or the worktree against the index. */
  staged: boolean;
  /**
   * Optional worktree path — scopes the diff read to a non-main
   * worktree. Omitted → the main checkout.
   */
  worktree?: string;
  /** Back-navigation seam (default: no-op; the route shell supplies router.back). */
  onBack?: () => void;
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

export function FileDiffScreen({
  owner,
  repo,
  filePath,
  staged,
  worktree,
  onBack,
}: FileDiffScreenProps) {
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();
  const { diff, isLoading, isError } = useFileDiff(owner, repo, filePath, staged, worktree);

  function renderBody() {
    if (isLoading) {
      return (
        <View style={styles.center} testID="file-diff-loading">
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      );
    }
    if (isError) {
      return (
        <View style={styles.center} testID="file-diff-error">
          <Text style={[styles.muted, { color: theme.colors.error }]}>Couldn’t load diff</Text>
        </View>
      );
    }
    if (!diff) {
      return (
        <View style={styles.center} testID="file-diff-empty">
          <Text style={[styles.muted, { color: theme.colors.textSecondary }]}>
            No diff to show.
          </Text>
        </View>
      );
    }
    // UnifiedDiffView owns its own (vertical) scroll — fill the body and lift the
    // 500px cap so the full diff scrolls inside it (no nested-ScrollView clash).
    return (
      <UnifiedDiffView diff={diff} testID="file-diff-view" maxHeight={100000} style={styles.diff} />
    );
  }

  return (
    <View
      style={[
        styles.container,
        { paddingTop: insets.top, backgroundColor: theme.colors.background },
      ]}
      testID="file-diff-screen"
    >
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <Pressable testID="file-diff-back" onPress={onBack} hitSlop={8} style={styles.back}>
          <Icon name="chevron-left" size={16} color={theme.colors.textSecondary} />
        </Pressable>
        <Text
          style={[styles.title, { color: theme.colors.text }]}
          numberOfLines={1}
          testID="file-diff-title"
        >
          {basename(filePath)}
        </Text>
      </View>
      <View style={[styles.body, { paddingBottom: insets.bottom }]}>{renderBody()}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { padding: 2 },
  title: { flex: 1, fontSize: 16, fontWeight: '600' },
  body: { flex: 1, paddingHorizontal: 12 },
  diff: { flex: 1, marginTop: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 40 },
  muted: { fontSize: 13, textAlign: 'center' },
});
