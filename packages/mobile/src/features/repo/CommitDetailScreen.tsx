/**
 * CommitDetailScreen — the source-control commit-detail screen (portable.dev#17).
 *
 * Pushed when a {@link CommitGraphView} row is tapped (`/repos/:owner/:repo/
 * commit?sha=`). Owns its safe-area chrome (the Stack runs `headerShown:false`),
 * shows the commit subject + author + short SHA + ± stats, and lists the changed
 * files (from `GET …/commit/:sha`). Tapping a file expands its slice of the
 * commit's unified diff in the shared {@link UnifiedDiffView}.
 *
 * v1 is read-only (revert/cherry-pick is a write-parity follow-up).
 */

import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ChangedFile } from '@vgit2/shared/types';

import { UnifiedDiffView } from '../../components/UnifiedDiffView';
import { Icon, useAppTheme, withAlpha } from '../../theme';
import { statusBadgeLetter } from './ChangesView';
import { splitDiffByFile, useCommitDetail } from './useCommitDetail';

export interface CommitDetailScreenProps {
  owner: string;
  repo: string;
  /** The commit sha (full or short). */
  sha: string;
  /** Back-navigation seam (default: no-op; the route shell supplies router.back). */
  onBack?: () => void;
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

export function CommitDetailScreen({ owner, repo, sha, onBack }: CommitDetailScreenProps) {
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();
  const vm = useCommitDetail(owner, repo, sha);
  const [expanded, setExpanded] = useState<string | null>(null);

  const patches = useMemo(() => splitDiffByFile(vm.diff), [vm.diff]);

  const badgeColor: Record<ChangedFile['status'], string> = {
    added: theme.colors.success,
    modified: theme.colors.warning,
    deleted: theme.colors.danger,
    renamed: theme.colors.info,
    untracked: theme.colors.textTertiary,
    conflicted: theme.colors.danger,
  };

  function patchFor(file: ChangedFile): string {
    if (patches[file.path]) return patches[file.path];
    // Fall back to a substring match (rename brace-notation, leading dirs).
    const key = Object.keys(patches).find((k) => k.endsWith(file.path) || file.path.endsWith(k));
    return key ? patches[key] : '';
  }

  function renderBody() {
    if (vm.isLoading) {
      return (
        <View style={styles.center} testID="commit-detail-loading">
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      );
    }
    if (vm.isError) {
      return (
        <View style={styles.center} testID="commit-detail-error">
          <Text style={[styles.muted, { color: theme.colors.error }]}>Couldn’t load commit</Text>
        </View>
      );
    }

    return (
      <ScrollView contentContainerStyle={styles.scroll} testID="commit-detail">
        <Text style={[styles.summaryCount, { color: theme.colors.textSecondary }]}>
          {vm.files.length} file{vm.files.length === 1 ? '' : 's'} changed
        </Text>
        {vm.files.map((file) => {
          const color = badgeColor[file.status];
          const isOpen = expanded === file.path;
          return (
            <View key={file.path} style={styles.fileBlock}>
              <Pressable
                style={[styles.fileRow, { borderBottomColor: theme.colors.border }]}
                onPress={() => setExpanded((cur) => (cur === file.path ? null : file.path))}
                testID={`commit-file-${file.path}`}
              >
                <Icon
                  name={isOpen ? 'chevron-down' : 'chevron-right'}
                  size={12}
                  color={theme.colors.textTertiary}
                />
                <View style={[styles.badge, { backgroundColor: withAlpha(color, '29') }]}>
                  <Text style={[styles.badgeText, { color }]}>
                    {statusBadgeLetter(file.status)}
                  </Text>
                </View>
                <Text style={[styles.fileName, { color: theme.colors.text }]} numberOfLines={1}>
                  {basename(file.path)}
                </Text>
                <View style={styles.counts}>
                  {file.insertions != null && file.insertions > 0 ? (
                    <Text style={[styles.add, { color: theme.colors.success }]}>
                      +{file.insertions}
                    </Text>
                  ) : null}
                  {file.deletions != null && file.deletions > 0 ? (
                    <Text style={[styles.del, { color: theme.colors.danger }]}>
                      −{file.deletions}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
              {isOpen ? (
                <UnifiedDiffView
                  diff={patchFor(file)}
                  testID={`commit-file-diff-${file.path}`}
                  maxHeight={100000}
                  style={styles.diff}
                />
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    );
  }

  const shortSha = vm.sha.slice(0, 7);

  return (
    <View
      style={[
        styles.container,
        { paddingTop: insets.top, backgroundColor: theme.colors.background },
      ]}
      testID="commit-detail-screen"
    >
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <Pressable testID="commit-detail-back" onPress={onBack} hitSlop={8} style={styles.back}>
          <Icon name="chevron-left" size={16} color={theme.colors.textSecondary} />
        </Pressable>
        <Text
          style={[styles.title, { color: theme.colors.text }]}
          numberOfLines={1}
          testID="commit-detail-title"
        >
          Commit {shortSha}
        </Text>
        {vm.stats ? (
          <Text style={[styles.headerStats, { color: theme.colors.textTertiary }]}>
            <Text style={{ color: theme.colors.success }}>+{vm.stats.additions}</Text>{' '}
            <Text style={{ color: theme.colors.danger }}>−{vm.stats.deletions}</Text>
          </Text>
        ) : null}
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
  headerStats: { fontSize: 13, fontFamily: 'monospace' },
  body: { flex: 1 },
  scroll: { paddingBottom: 24 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 40 },
  muted: { fontSize: 13, textAlign: 'center' },
  summaryCount: { fontSize: 12, fontWeight: '600', paddingHorizontal: 14, paddingVertical: 10 },
  fileBlock: { marginBottom: 2 },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  badge: { width: 22, height: 22, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 12, fontWeight: '800' },
  fileName: { flex: 1, fontSize: 14 },
  counts: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  add: { fontSize: 12, fontWeight: '600' },
  del: { fontSize: 12, fontWeight: '600' },
  diff: { marginHorizontal: 12 },
});
