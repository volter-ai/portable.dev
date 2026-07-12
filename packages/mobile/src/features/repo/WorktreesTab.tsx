/**
 * WorktreesTab — the repo "Worktrees" tab (portable.dev#17 — read-only list).
 *
 * READ-ONLY surface (worktree mutation is OUT of scope — a follow-up). Gates
 * on the repo being locally cloned (the OverviewTab `isLocal` 404 pattern; the
 * SAME `useRepoDetails` query the page header + Overview tab use, deduped by key).
 * Once cloned it shows the {@link WorktreesView} list; tapping a worktree opens
 * its changes in-tab via {@link WorktreeChangesScreen} (no nested route — the
 * in-shell tab model). The per-file diff DOES push the diff route, carrying the
 * worktree scope.
 *
 * No stage/commit/discard, no create/remove, no start-chat (all deferred to
 * a follow-up).
 */

import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import type { Worktree } from '@vgit2/shared/types';

import { useAppTheme } from '../../theme';
import { CloneFirstNotice } from './CloneFirstNotice';
import { useRepoDetails } from './useRepoOverview';
import { WorktreeChangesScreen } from './WorktreeChangesScreen';
import { WorktreesView } from './WorktreesView';

export interface WorktreesTabProps {
  owner: string;
  repo: string;
}

export function WorktreesTab({ owner, repo }: WorktreesTabProps) {
  const { theme } = useAppTheme();
  const details = useRepoDetails(owner, repo);
  const [selected, setSelected] = useState<Worktree | null>(null);

  if (details.isLoading) {
    return (
      <ActivityIndicator
        testID="worktrees-loading"
        style={styles.center}
        color={theme.colors.primary}
      />
    );
  }
  if (details.isError) {
    return (
      <View style={styles.center} testID="worktrees-error">
        <Text style={[styles.errorText, { color: theme.colors.error }]}>
          Couldn’t load worktrees
        </Text>
      </View>
    );
  }
  if (details.data?.isLocal !== true) {
    return <CloneFirstNotice testID="worktrees-clone-gate" detail="to view its worktrees" />;
  }

  return (
    <View style={styles.fill} testID="worktrees-tab">
      {selected ? (
        <WorktreeChangesScreen
          owner={owner}
          repo={repo}
          worktree={selected}
          onBack={() => setSelected(null)}
        />
      ) : (
        <WorktreesView owner={owner} repo={repo} onSelectWorktree={setSelected} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 32 },
  errorText: { fontSize: 15, fontWeight: '600' },
});
