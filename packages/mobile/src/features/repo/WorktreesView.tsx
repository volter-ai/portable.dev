/**
 * WorktreesView — the read-only git-worktree list (portable.dev#17).
 *
 * Renders the repo's worktrees (from {@link useWorktrees}); each row shows the
 * folder/path basename, the checked-out branch (or "detached"), the HEAD
 * short-sha, and status badges (main / locked / prunable / bare). Tapping a row
 * fires the injectable `onSelectWorktree` seam (the {@link WorktreesTab} opens
 * that worktree's changes). When only the main worktree exists, a clear
 * "No additional worktrees yet" note is shown (honest single-entry state).
 *
 * READ-ONLY — no create/remove/prune, no stage/commit/discard, no start-chat
 * (all deferred to a follow-up). It's a `ScrollView` of rows (the worktree
 * set is small) with a hidden virtualization-proof `worktrees-count` testID.
 */

import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { Worktree } from '@vgit2/shared/types';

import { Icon, useAppTheme, withAlpha } from '../../theme';
import { usePullToRefresh } from './sourceControlRefresh';
import { useWorktrees } from './useWorktrees';

export interface WorktreesViewProps {
  owner: string;
  repo: string;
  /** Gate the worktrees read (the tab passes the clone-gate result). */
  enabled?: boolean;
  /** Row-tap seam — the tab opens the worktree's changes. */
  onSelectWorktree?: (worktree: Worktree) => void;
}

/** The trailing path segment (the worktree's folder name). */
function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const parts = trimmed.split('/');
  return parts[parts.length - 1] || path;
}

/** The 7-char short SHA (HEAD). */
function shortSha(head: string): string {
  return head.slice(0, 7);
}

/** A status badge: its label + the keyed color. */
interface WorktreeBadge {
  key: string;
  label: string;
  color: string;
}

export function WorktreesView({
  owner,
  repo,
  enabled = true,
  onSelectWorktree,
}: WorktreesViewProps) {
  const { theme } = useAppTheme();
  const vm = useWorktrees(owner, repo, { enabled });
  const pull = usePullToRefresh(vm.refetch);

  // One RefreshControl serves every non-loading branch — worktrees are
  // added/removed on the PC out-of-band, so the list must always be pullable.
  const refreshControl = (
    <RefreshControl
      testID="worktrees-refresh"
      refreshing={pull.refreshing}
      onRefresh={pull.onRefresh}
      tintColor={theme.colors.primary}
      colors={[theme.colors.primary]}
    />
  );

  if (vm.isLoading) {
    return (
      <View style={styles.center} testID="worktrees-list-loading">
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }
  if (vm.isError) {
    return (
      <ScrollView
        style={styles.fill}
        contentContainerStyle={styles.centerGrow}
        refreshControl={refreshControl}
        testID="worktrees-list-error"
      >
        <Text style={[styles.muted, { color: theme.colors.error }]}>Couldn’t load worktrees</Text>
      </ScrollView>
    );
  }
  if (vm.isEmpty) {
    // Degenerate (a repo always has a main worktree) — surfaced honestly.
    return (
      <ScrollView
        style={styles.fill}
        contentContainerStyle={styles.centerGrow}
        refreshControl={refreshControl}
        testID="worktrees-list-empty"
      >
        <Icon name="code-branch" size={28} color={theme.colors.textTertiary} />
        <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>No worktrees</Text>
      </ScrollView>
    );
  }

  return (
    <View style={styles.fill} testID="worktrees-list">
      {/* Hidden, virtualization-proof total so a test asserts the count regardless. */}
      <Text style={styles.hidden} testID="worktrees-count">
        {vm.totalCount}
      </Text>
      <ScrollView contentContainerStyle={styles.scroll} refreshControl={refreshControl}>
        {vm.worktrees.map((wt) => (
          <WorktreeRow key={wt.path} worktree={wt} onPress={onSelectWorktree} />
        ))}
        {vm.isOnlyMain ? (
          <Text
            style={[styles.note, { color: theme.colors.textSecondary }]}
            testID="worktrees-only-main-note"
          >
            No additional worktrees yet.
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function WorktreeRow({
  worktree,
  onPress,
}: {
  worktree: Worktree;
  onPress?: (worktree: Worktree) => void;
}) {
  const { theme } = useAppTheme();

  const badges: WorktreeBadge[] = [];
  if (worktree.isMain) badges.push({ key: 'main', label: 'main', color: theme.colors.primary });
  if (worktree.locked) badges.push({ key: 'locked', label: 'locked', color: theme.colors.warning });
  if (worktree.prunable)
    badges.push({ key: 'prunable', label: 'prunable', color: theme.colors.danger });
  if (worktree.bare) badges.push({ key: 'bare', label: 'bare', color: theme.colors.textTertiary });

  const branchLabel = worktree.detached ? 'detached' : (worktree.branch ?? 'detached');

  return (
    <Pressable
      style={[styles.row, { borderBottomColor: theme.colors.border }]}
      onPress={() => onPress?.(worktree)}
      testID={`worktree-${worktree.path}`}
    >
      <Icon name="folder" size={18} color={theme.colors.textTertiary} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={[styles.folder, { color: theme.colors.text }]} numberOfLines={1}>
            {folderName(worktree.path)}
          </Text>
          {badges.map((b) => (
            <View
              key={b.key}
              style={[styles.badge, { backgroundColor: withAlpha(b.color, '29') }]}
              testID={`worktree-${worktree.path}-badge-${b.key}`}
            >
              <Text style={[styles.badgeText, { color: b.color }]}>{b.label}</Text>
            </View>
          ))}
        </View>
        <View style={styles.rowMeta}>
          <Icon name="code-branch" size={11} color={theme.colors.textSecondary} />
          <Text style={[styles.metaText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
            {branchLabel}
          </Text>
          <Text style={[styles.sha, { color: theme.colors.textTertiary }]}>
            {shortSha(worktree.head)}
          </Text>
        </View>
      </View>
      <Icon name="chevron-right" size={14} color={theme.colors.textTertiary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scroll: { paddingBottom: 24 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 40 },
  // Empty/error states live in a ScrollView (pull-to-refresh needs a scroller).
  centerGrow: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 40,
  },
  muted: { fontSize: 13, textAlign: 'center' },
  emptyTitle: { fontSize: 15, fontWeight: '600' },
  hidden: { width: 0, height: 0, opacity: 0 },
  note: {
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 24,
    paddingTop: 16,
    lineHeight: 17,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowBody: { flex: 1, gap: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  folder: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  badge: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 5 },
  badgeText: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaText: { fontSize: 12, flexShrink: 1 },
  sha: { fontSize: 12, fontVariant: ['tabular-nums'] },
});
