/**
 * ChangesView — the source-control "Changes" surface (portable.dev#17).
 *
 * The grouped working-tree changes: Conflicts → Staged → Unstaged → Untracked,
 * each a collapsible section of changed-file rows (a color-coded M/A/D/R/U/C
 * status badge + filename + ± counts). Tapping a row pushes the per-file diff
 * screen (`/repos/:owner/:repo/diff?path=&staged=`), which renders the shared
 * {@link UnifiedDiffView}.
 *
 * Thin view over {@link useWorkingTreeChanges}. The four groups are a plain
 * `ScrollView` of rows (not a `FlatList`) — the working set is small and a
 * VirtualizedList would warn when nested under a scroll parent — but the AC's
 * hidden `source-control-changes-count` Text exposes the total regardless, so a
 * test can assert the count without depending on row virtualization.
 */

import { useState } from 'react';
import { router } from 'expo-router';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { ChangedFile } from '@vgit2/shared/types';

import { Icon, useAppTheme, withAlpha } from '../../theme';
import { usePullToRefresh } from './sourceControlRefresh';
import { useCommit } from './useCommit';
import { useStageMutations } from './useStageMutations';
import { useWorkingTreeChanges } from './useWorkingTreeChanges';

export interface ChangesViewProps {
  owner: string;
  repo: string;
  /** Gate the underlying status read (the tab passes `segment === 'changes'`). */
  enabled?: boolean;
  /**
   * Optional worktree path — scopes the status read + the diff-route
   * navigation to a non-main worktree. Omitted → the main checkout.
   */
  worktree?: string;
  /** Navigation seam (default: push the per-file diff route). Injectable for tests. */
  onSelectFile?: (file: ChangedFile) => void;
}

/** Stage/unstage action a group's rows expose. */
type StageAction = 'stage' | 'unstage';

/** A working-tree group: its label, the files, a stable key, and its row action. */
interface ChangeGroup {
  key: string;
  label: string;
  files: ChangedFile[];
  /** Staged rows unstage; everything else (unstaged/untracked/conflicted) stages. */
  action: StageAction;
  /**
   * Whether the group's rows expose a DESTRUCTIVE discard. Working-tree
   * changes (unstaged/untracked/conflicted) can be discarded; staged rows must be
   * unstaged first (discard reverts the working tree, not the index).
   */
  discardable: boolean;
}

/** A pending discard awaiting confirmation: the paths + a human label for the modal. */
interface DiscardTarget {
  paths: string[];
  label: string;
}

/** Map a {@link ChangedFile} status to its single-letter badge (M/A/D/R/U/C). */
export function statusBadgeLetter(status: ChangedFile['status']): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'modified':
      return 'M';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'untracked':
      return 'U';
    case 'conflicted':
      return 'C';
  }
}

/** The basename of a repo-relative path (the row's primary label). */
function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

export function ChangesView({
  owner,
  repo,
  enabled = true,
  worktree,
  onSelectFile,
}: ChangesViewProps) {
  const { theme } = useAppTheme();
  const vm = useWorkingTreeChanges(owner, repo, { enabled, worktree });
  const staging = useStageMutations(owner, repo, { worktree });
  const pull = usePullToRefresh(vm.refetch);

  // A discard is gated behind an explicit confirmation Modal: the row /
  // group action only RECORDS the target; confirming fires the mutation.
  const [discardTarget, setDiscardTarget] = useState<DiscardTarget | null>(null);

  // One RefreshControl serves every non-loading branch (list / empty / error) —
  // the PC mutates the tree out-of-band, so even a clean tree must be pullable.
  const refreshControl = (
    <RefreshControl
      testID="source-control-changes-refresh"
      refreshing={pull.refreshing}
      onRefresh={pull.onRefresh}
      tintColor={theme.colors.primary}
      colors={[theme.colors.primary]}
    />
  );

  const badgeColor: Record<ChangedFile['status'], string> = {
    added: theme.colors.success,
    modified: theme.colors.warning,
    deleted: theme.colors.danger,
    renamed: theme.colors.info,
    untracked: theme.colors.textTertiary,
    conflicted: theme.colors.danger,
  };

  const select =
    onSelectFile ??
    ((file: ChangedFile) =>
      router.push({
        pathname: '/repos/[owner]/[repo]/diff',
        params: {
          owner,
          repo,
          path: file.path,
          staged: file.staged ? '1' : '0',
          ...(worktree ? { worktree } : {}),
        },
      }));

  if (vm.isLoading) {
    return (
      <View style={styles.center} testID="source-control-changes-loading">
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
        testID="source-control-changes-error"
      >
        <Text style={[styles.muted, { color: theme.colors.error }]}>Couldn’t load changes</Text>
      </ScrollView>
    );
  }
  if (vm.isEmpty) {
    return (
      <ScrollView
        style={styles.fill}
        contentContainerStyle={styles.centerGrow}
        refreshControl={refreshControl}
        testID="source-control-changes-empty"
      >
        <Icon name="square-check" size={28} color={theme.colors.textTertiary} />
        <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>No changes</Text>
        <Text style={[styles.muted, { color: theme.colors.textSecondary }]}>
          Your working tree is clean.
        </Text>
      </ScrollView>
    );
  }

  const groups: ChangeGroup[] = [
    {
      key: 'conflicted',
      label: 'Conflicts',
      files: vm.conflicted,
      action: 'stage',
      discardable: true,
    },
    { key: 'staged', label: 'Staged', files: vm.staged, action: 'unstage', discardable: false },
    { key: 'unstaged', label: 'Unstaged', files: vm.unstaged, action: 'stage', discardable: true },
    {
      key: 'untracked',
      label: 'Untracked',
      files: vm.untracked,
      action: 'stage',
      discardable: true,
    },
  ];

  const runAction = (action: StageAction, paths: string[]) =>
    action === 'stage' ? staging.stage(paths) : staging.unstage(paths);

  const confirmDiscard = () => {
    if (discardTarget) staging.discard(discardTarget.paths);
    setDiscardTarget(null);
  };

  return (
    <View style={styles.fill} testID="source-control-changes">
      {/* Hidden, virtualization-proof total so tests assert the row count without
          depending on which rows the scroll view has realized. */}
      <Text style={styles.hidden} testID="source-control-changes-count">
        {vm.totalCount}
      </Text>
      <ScrollView contentContainerStyle={styles.scroll} refreshControl={refreshControl}>
        {groups
          .filter((g) => g.files.length > 0)
          .map((group) => (
            <ChangeGroupSection
              key={group.key}
              group={group}
              badgeColor={badgeColor}
              onSelectFile={select}
              onRunAction={runAction}
              onRequestDiscard={setDiscardTarget}
              isPending={staging.isPending}
            />
          ))}
      </ScrollView>

      {/* Commit composer — main checkout only (the backend commit is
          not worktree-scoped). Disabled when nothing is staged. */}
      {!worktree ? (
        <CommitComposer owner={owner} repo={repo} stagedCount={vm.staged.length} />
      ) : null}

      <DiscardConfirmModal
        target={discardTarget}
        onCancel={() => setDiscardTarget(null)}
        onConfirm={confirmDiscard}
      />
    </View>
  );
}

/**
 * The commit message composer. A docked footer with a message input +
 * a Commit button. The button is DISABLED when nothing is staged or the message
 * is blank (the AC's "disabled when nothing staged"); on success the staged group
 * empties and the commit appears in the graph (the {@link useCommit} hook
 * invalidates both the status + graph reads), and the input clears.
 */
function CommitComposer({
  owner,
  repo,
  stagedCount,
}: {
  owner: string;
  repo: string;
  stagedCount: number;
}) {
  const { theme } = useAppTheme();
  const { commitAsync, isPending } = useCommit(owner, repo);
  const [message, setMessage] = useState('');

  const trimmed = message.trim();
  const canCommit = stagedCount > 0 && trimmed.length > 0 && !isPending;

  const onCommit = () => {
    if (!canCommit) return;
    void commitAsync(trimmed)
      .then(() => setMessage(''))
      .catch(() => {
        // Surfaced via the mutation's error state; keep the message for a retry.
      });
  };

  return (
    <View
      style={[styles.composer, { borderTopColor: theme.colors.border }]}
      testID="source-control-commit-composer"
    >
      <TextInput
        style={[
          styles.composerInput,
          { color: theme.colors.text, borderColor: theme.colors.border },
        ]}
        placeholder={stagedCount > 0 ? 'Commit message' : 'Stage changes to commit'}
        placeholderTextColor={theme.colors.textTertiary}
        value={message}
        onChangeText={setMessage}
        multiline
        editable={stagedCount > 0 && !isPending}
        testID="source-control-commit-message"
      />
      <Pressable
        style={[
          styles.composerButton,
          { backgroundColor: canCommit ? theme.colors.primary : theme.colors.border },
        ]}
        onPress={onCommit}
        disabled={!canCommit}
        testID="source-control-commit-button"
        accessibilityRole="button"
        accessibilityLabel="Commit"
        accessibilityState={{ disabled: !canCommit }}
      >
        {isPending ? (
          <ActivityIndicator color="#ffffff" size="small" />
        ) : (
          <Text style={styles.composerButtonText}>Commit</Text>
        )}
      </Pressable>
    </View>
  );
}

/**
 * The destructive-discard confirmation Modal. A CENTERED transparent
 * dialog (the chat-delete-confirm / runtime-restart precedent — NOT full-screen,
 * so the `useWindowInsets` requirement does not apply), clearly labeling the
 * action as irreversible. Renders nothing until a discard is requested.
 */
function DiscardConfirmModal({
  target,
  onCancel,
  onConfirm,
}: {
  target: DiscardTarget | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { theme } = useAppTheme();
  if (!target) return null;
  return (
    <Modal
      transparent
      animationType="fade"
      visible
      onRequestClose={onCancel}
      testID="source-control-discard-modal"
    >
      <View style={styles.modalBackdrop}>
        <View style={[styles.modalCard, { backgroundColor: theme.colors.surface }]}>
          <Text style={[styles.modalTitle, { color: theme.colors.text }]}>Discard changes?</Text>
          <Text style={[styles.modalBody, { color: theme.colors.textSecondary }]}>
            This will permanently discard {target.label}. This action cannot be undone.
          </Text>
          <View style={styles.modalActions}>
            <Pressable
              style={[styles.modalButton, { borderColor: theme.colors.border }]}
              onPress={onCancel}
              testID="source-control-discard-cancel"
              accessibilityRole="button"
            >
              <Text style={[styles.modalButtonText, { color: theme.colors.text }]}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.modalButton, { backgroundColor: theme.colors.danger }]}
              onPress={onConfirm}
              testID="source-control-discard-confirm"
              accessibilityRole="button"
            >
              <Text style={[styles.modalButtonText, styles.modalDestructive]}>Discard</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function ChangeGroupSection({
  group,
  badgeColor,
  onSelectFile,
  onRunAction,
  onRequestDiscard,
  isPending,
}: {
  group: ChangeGroup;
  badgeColor: Record<ChangedFile['status'], string>;
  onSelectFile: (file: ChangedFile) => void;
  onRunAction: (action: StageAction, paths: string[]) => void;
  /** Record a destructive-discard request; the modal confirms it. */
  onRequestDiscard: (target: DiscardTarget) => void;
  isPending: (path: string) => boolean;
}) {
  const { theme } = useAppTheme();
  const [collapsed, setCollapsed] = useState(false);

  const actionLabel = group.action === 'stage' ? 'Stage all' : 'Unstage all';
  const actionIcon = group.action === 'stage' ? 'plus' : 'minus';

  return (
    <View style={styles.group} testID={`source-control-group-${group.key}`}>
      <View style={[styles.groupHeader, { borderBottomColor: theme.colors.border }]}>
        <Pressable
          style={styles.groupHeaderMain}
          onPress={() => setCollapsed((c) => !c)}
          testID={`source-control-group-${group.key}-header`}
        >
          <Icon
            name={collapsed ? 'chevron-right' : 'chevron-down'}
            size={12}
            color={theme.colors.textTertiary}
          />
          <Text style={[styles.groupLabel, { color: theme.colors.text }]}>{group.label}</Text>
          <Text style={[styles.groupCount, { color: theme.colors.textTertiary }]}>
            {group.files.length}
          </Text>
        </Pressable>
        {/* Group-level "Discard all" (destructive) — only for working-tree
            groups; gated behind the confirmation modal. */}
        {group.discardable && group.files.length > 0 ? (
          <Pressable
            style={styles.groupAction}
            onPress={() =>
              onRequestDiscard({
                paths: group.files.map((f) => f.path),
                label:
                  group.files.length === 1
                    ? basename(group.files[0]!.path)
                    : `${group.files.length} files in ${group.label}`,
              })
            }
            testID={`source-control-group-${group.key}-discard`}
            accessibilityRole="button"
            accessibilityLabel={`Discard all in ${group.label}`}
          >
            <Text style={[styles.groupActionText, { color: theme.colors.danger }]}>
              Discard all
            </Text>
          </Pressable>
        ) : null}
        {/* Group-level "Stage all" / "Unstage all". */}
        <Pressable
          style={styles.groupAction}
          onPress={() =>
            onRunAction(
              group.action,
              group.files.map((f) => f.path)
            )
          }
          testID={`source-control-group-${group.key}-action`}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
        >
          <Text style={[styles.groupActionText, { color: theme.colors.primary }]}>
            {actionLabel}
          </Text>
        </Pressable>
      </View>

      {!collapsed &&
        group.files.map((file) => {
          const color = badgeColor[file.status];
          const pending = isPending(file.path);
          return (
            <Pressable
              key={`${group.key}:${file.path}`}
              style={styles.row}
              onPress={() => onSelectFile(file)}
              testID={`source-control-file-${group.key}-${file.path}`}
            >
              <View style={[styles.badge, { backgroundColor: withAlpha(color, '29') }]}>
                <Text style={[styles.badgeText, { color }]}>{statusBadgeLetter(file.status)}</Text>
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
              {/* Per-row discard (destructive). Nested Pressable claims the
                  touch responder so a tap never falls through to diff navigation. */}
              {group.discardable ? (
                <Pressable
                  style={[styles.rowAction, { borderColor: theme.colors.border }]}
                  onPress={() =>
                    onRequestDiscard({ paths: [file.path], label: basename(file.path) })
                  }
                  disabled={pending}
                  hitSlop={8}
                  testID={`source-control-discard-${group.key}-${file.path}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Discard ${basename(file.path)}`}
                >
                  <Icon
                    name="trash"
                    size={14}
                    color={pending ? theme.colors.textTertiary : theme.colors.danger}
                  />
                </Pressable>
              ) : null}
              {/* Per-row stage/unstage. Nested Pressable claims the touch responder
                  so a tap here never falls through to the row's diff navigation. */}
              <Pressable
                style={[styles.rowAction, { borderColor: theme.colors.border }]}
                onPress={() => onRunAction(group.action, [file.path])}
                disabled={pending}
                hitSlop={8}
                testID={`source-control-stage-${group.key}-${file.path}`}
                accessibilityRole="button"
                accessibilityLabel={`${group.action === 'stage' ? 'Stage' : 'Unstage'} ${basename(file.path)}`}
              >
                <Icon
                  name={actionIcon}
                  size={14}
                  color={pending ? theme.colors.textTertiary : theme.colors.primary}
                />
              </Pressable>
              <Icon name="chevron-right" size={14} color={theme.colors.textTertiary} />
            </Pressable>
          );
        })}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scroll: { paddingBottom: 24 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 40 },
  // Empty/error states live in a ScrollView (pull-to-refresh needs a scroller);
  // flexGrow centers the content while keeping the full area pullable.
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
  group: { marginBottom: 4 },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  groupHeaderMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  groupLabel: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  groupCount: { fontSize: 12, fontWeight: '600' },
  groupAction: { paddingHorizontal: 8, paddingVertical: 4 },
  groupActionText: { fontSize: 12, fontWeight: '600' },
  rowAction: {
    width: 26,
    height: 26,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  badge: {
    width: 22,
    height: 22,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 12, fontWeight: '800' },
  fileName: { flex: 1, fontSize: 14 },
  counts: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  add: { fontSize: 12, fontWeight: '600' },
  del: { fontSize: 12, fontWeight: '600' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  composerInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
  },
  composerButton: {
    minWidth: 76,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  composerButtonText: { fontSize: 14, fontWeight: '700', color: '#ffffff' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: { width: '100%', maxWidth: 360, borderRadius: 12, padding: 20, gap: 12 },
  modalTitle: { fontSize: 17, fontWeight: '700' },
  modalBody: { fontSize: 14, lineHeight: 20 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  modalButton: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  modalButtonText: { fontSize: 14, fontWeight: '600' },
  modalDestructive: { color: '#ffffff' },
});
