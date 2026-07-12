/**
 * PushPullHeader — the Source Control tab header (portable.dev#17).
 *
 * Surfaces the current branch + ahead/behind counters and the Push / Pull
 * actions. Both mutations authenticate as the user's GitHub identity SERVER-SIDE
 * (the route resolves the token; the client never sends it) and invalidate the
 * status + graph reads on success (so the ahead/behind here refresh and the graph
 * picks up any pulled commits).
 *
 * The branch + ahead/behind come from the SAME `useWorkingTreeChanges` query the
 * Changes segment uses (shared cache key → deduped); read here `enabled` always so
 * the counters show on the default Graph segment too.
 *
 * The branch label is tappable (when `onBranchPress` is wired) — the tab opens
 * the searchable branch/worktree switcher from it. With a non-main `worktree`
 * selected the status read AND the Push / Pull actions are scoped to it (a
 * fresh worktree branch is auto-published on its first push).
 *
 * CONFLICT GATE: while the scoped status reports unmerged files (e.g. a pull
 * that stopped on merge conflicts), Push is disabled and a warning explains
 * why — resolve (and commit) first. The backend enforces the same rule (409).
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../theme';
import { Icon } from '../../theme/icons/Icon';
import { usePushPull } from './usePushPull';
import { useWorkingTreeChanges } from './useWorkingTreeChanges';

export interface PushPullHeaderProps {
  owner: string;
  repo: string;
  /**
   * Optional worktree path — scopes the branch/ahead-behind read (shared cache
   * key with the scoped Changes read) AND the Push / Pull mutations to a
   * non-main worktree.
   */
  worktree?: string;
  /** Tap seam for the branch label — the tab opens the branch/worktree switcher. */
  onBranchPress?: () => void;
}

export function PushPullHeader({ owner, repo, worktree, onBranchPress }: PushPullHeaderProps) {
  const { theme } = useAppTheme();
  const status = useWorkingTreeChanges(owner, repo, { enabled: true, worktree });
  const { push, pull, isPushing, isPulling, isError, error } = usePushPull(owner, repo, {
    worktree,
  });

  const busy = isPushing || isPulling;
  const hasConflicts = status.conflicted.length > 0;
  const pushDisabled = busy || hasConflicts;
  const errorMessage =
    isError && error instanceof Error && error.message
      ? error.message
      : isError
        ? 'Operation failed'
        : null;

  return (
    <View
      testID="source-control-push-pull-header"
      style={[styles.container, { borderColor: theme.colors.border }]}
    >
      <View style={styles.row}>
        <Pressable
          style={styles.branchInfo}
          onPress={onBranchPress}
          disabled={!onBranchPress}
          testID="source-control-branch-switch"
          accessibilityRole="button"
          accessibilityLabel="Switch branch or worktree"
        >
          <Icon name="code-branch" size={14} color={theme.colors.textSecondary} />
          {/* A long branch/worktree name must ELLIPSIZE, never push the
              counters/actions off-screen: the shrinkable wrapper (flexShrink +
              minWidth:0) is what lets Yoga clamp the Text below its content
              width — flexShrink on the Text alone doesn't hold on device. */}
          <View style={styles.branchLabelWrap}>
            <Text
              testID="source-control-branch"
              numberOfLines={1}
              style={[styles.branch, { color: theme.colors.text }]}
            >
              {status.branch || '—'}
            </Text>
          </View>
          {onBranchPress ? (
            <Icon name="chevron-down" size={11} color={theme.colors.textTertiary} />
          ) : null}
          <View style={styles.counters}>
            <Icon name="arrow-up" size={11} color={theme.colors.textTertiary} />
            <Text
              testID="source-control-ahead"
              style={[styles.count, { color: theme.colors.textTertiary }]}
            >
              {status.ahead}
            </Text>
            <Icon name="arrow-down" size={11} color={theme.colors.textTertiary} />
            <Text
              testID="source-control-behind"
              style={[styles.count, { color: theme.colors.textTertiary }]}
            >
              {status.behind}
            </Text>
          </View>
        </Pressable>

        <View style={styles.actions}>
          <Pressable
            testID="source-control-pull"
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => pull()}
            style={[
              styles.actionButton,
              { borderColor: theme.colors.border, opacity: busy ? 0.5 : 1 },
            ]}
          >
            <Icon name="arrow-down" size={13} color={theme.colors.text} />
            <Text style={[styles.actionLabel, { color: theme.colors.text }]}>
              {isPulling ? 'Pulling…' : 'Pull'}
            </Text>
          </Pressable>
          <Pressable
            testID="source-control-push"
            accessibilityRole="button"
            accessibilityState={{ disabled: pushDisabled }}
            disabled={pushDisabled}
            onPress={() => push()}
            style={[
              styles.actionButton,
              styles.pushButton,
              { backgroundColor: theme.colors.primary, opacity: pushDisabled ? 0.5 : 1 },
            ]}
          >
            <Icon name="arrow-up" size={13} color={theme.colors.textInverse} />
            <Text style={[styles.actionLabel, { color: theme.colors.textInverse }]}>
              {isPushing ? 'Pushing…' : 'Push'}
            </Text>
          </Pressable>
        </View>
      </View>

      {hasConflicts ? (
        <Text
          testID="source-control-conflict-warning"
          style={[styles.error, { color: theme.colors.warning }]}
        >
          Resolve merge conflicts before pushing.
        </Text>
      ) : null}

      {errorMessage ? (
        <Text
          testID="source-control-push-pull-error"
          style={[styles.error, { color: theme.colors.error }]}
        >
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  branchInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
  },
  branchLabelWrap: { flexShrink: 1, minWidth: 0 },
  branch: { fontSize: 13, fontWeight: '600' },
  counters: { flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 },
  count: { fontSize: 12, fontWeight: '600', marginRight: 4 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 7,
    borderWidth: 1,
  },
  pushButton: { borderWidth: 0 },
  actionLabel: { fontSize: 13, fontWeight: '600' },
  error: { fontSize: 12 },
});
