/**
 * SourceControlTab — the repo "Source Control" tab (portable.dev#17).
 *
 * Gated on the repo being locally cloned (the OverviewTab `isLocal` 404 pattern,
 * via {@link useRepoDetails} — the same query the page header + Overview tab use,
 * deduped by key). Once cloned, it shows a segmented control [ Graph | Changes ]:
 *
 *   - Graph   — the headline multi-lane commit graph ({@link CommitGraphView} —
 *               owns the default segment).
 *   - Changes — the grouped working-tree surface ({@link ChangesView}):
 *               Conflicts / Staged / Unstaged / Untracked, each row tappable into
 *               the per-file diff screen.
 *
 * The header's branch label opens the SEARCHABLE branch/worktree switcher (the
 * shared {@link SelectorSheet}, type-to-filter): every git worktree is listed by
 * its checked-out branch, and picking one re-scopes the header + Changes reads
 * AND the header's Push / Pull to that worktree via the `worktree` param the
 * backend validates against the real `git worktree list` set. The Graph stays
 * repo-wide (it already renders every ref); the commit composer remains
 * main-checkout only, and a worktree-scoped Changes view instead docks the
 * {@link WorktreeChatComposer} — start a chat that RUNS inside that worktree.
 *
 * The Changes status read is gated behind the active segment so the default Graph
 * segment never pays for it.
 */

import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Worktree } from '@vgit2/shared/types';

import { useAppTheme } from '../../theme';
import { SelectorSheet, type SelectorOption } from '../chat/composer/SelectorSheet';
import { ChangesView } from './ChangesView';
import { CloneFirstNotice } from './CloneFirstNotice';
import { CommitGraphView } from './CommitGraphView';
import { PushPullHeader } from './PushPullHeader';
import { useRepoDetails } from './useRepoOverview';
import { useWorktrees } from './useWorktrees';
import { WorktreeChatComposer } from './WorktreeChatComposer';

export interface SourceControlTabProps {
  owner: string;
  repo: string;
}

type Segment = 'graph' | 'changes';

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: 'graph', label: 'Graph' },
  { key: 'changes', label: 'Changes' },
];

/** The trailing path segment (a worktree's folder name). */
function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const parts = trimmed.split('/');
  return parts[parts.length - 1] || path;
}

/**
 * Map the worktree list to switcher options: each entry is labeled by its
 * checked-out branch (a detached worktree falls back to its folder + short
 * sha), with the folder path as the searchable secondary line.
 */
export function worktreeSwitcherOptions(worktrees: Worktree[]): SelectorOption[] {
  return worktrees.map((wt) => ({
    id: wt.path,
    name: wt.detached
      ? `${folderName(wt.path)} (detached @ ${wt.head.slice(0, 7)})`
      : (wt.branch ?? folderName(wt.path)),
    description: wt.isMain ? `Main checkout — ${wt.path}` : wt.path,
  }));
}

export function SourceControlTab({ owner, repo }: SourceControlTabProps) {
  const { theme } = useAppTheme();
  const details = useRepoDetails(owner, repo);
  const [segment, setSegment] = useState<Segment>('graph');
  // The selected NON-main worktree (null = the main checkout). Scopes the
  // header + Changes reads via `?worktree=`.
  const [worktree, setWorktree] = useState<Worktree | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const worktrees = useWorktrees(owner, repo, { enabled: details.data?.isLocal === true });

  if (details.isLoading) {
    return (
      <ActivityIndicator
        testID="source-control-loading"
        style={styles.center}
        color={theme.colors.primary}
      />
    );
  }
  if (details.isError) {
    return (
      <View style={styles.center} testID="source-control-error">
        <Text style={[styles.errorText, { color: theme.colors.error }]}>
          Couldn’t load source control
        </Text>
      </View>
    );
  }
  if (details.data?.isLocal !== true) {
    return <CloneFirstNotice testID="source-control-clone-gate" detail="to use source control" />;
  }

  const mainPath = worktrees.worktrees.find((w) => w.isMain)?.path ?? '';
  const selectWorktree = (id: string) => {
    const picked = worktrees.worktrees.find((w) => w.path === id);
    setWorktree(picked && !picked.isMain ? picked : null);
    setSwitcherOpen(false);
  };
  const openSwitcher = () => {
    setSwitcherOpen(true);
    // Worktrees are added/removed on the PC out-of-band — re-read the list so
    // the sheet's options are current the moment it opens.
    void worktrees.refetch();
  };

  return (
    <View style={styles.fill} testID="source-control-tab">
      <PushPullHeader
        owner={owner}
        repo={repo}
        worktree={worktree?.path}
        onBranchPress={openSwitcher}
      />
      <View style={[styles.segmented, { borderColor: theme.colors.border }]}>
        {SEGMENTS.map((s) => {
          const active = segment === s.key;
          return (
            <Pressable
              key={s.key}
              testID={`source-control-segment-${s.key}`}
              onPress={() => setSegment(s.key)}
              style={[styles.segment, active && { backgroundColor: theme.colors.primary }]}
            >
              <Text
                style={[
                  styles.segmentText,
                  { color: active ? theme.colors.textInverse : theme.colors.textSecondary },
                ]}
              >
                {s.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {segment === 'changes' ? (
        <>
          <ChangesView owner={owner} repo={repo} enabled worktree={worktree?.path} />
          {/* A worktree-scoped Changes view has no commit composer (main-only);
              its footer slot instead starts a chat INSIDE that worktree. */}
          {worktree ? (
            <WorktreeChatComposer
              owner={owner}
              repo={repo}
              worktree={worktree.path}
              branchLabel={worktree.branch ?? folderName(worktree.path)}
            />
          ) : null}
        </>
      ) : (
        <CommitGraphView owner={owner} repo={repo} enabled={segment === 'graph'} />
      )}

      <SelectorSheet
        testID="source-control-branch-sheet"
        visible={switcherOpen}
        title="Switch branch"
        options={worktreeSwitcherOptions(worktrees.worktrees)}
        selectedId={worktree?.path ?? mainPath}
        optionTestIdPrefix="source-control-branch-option"
        onSelect={selectWorktree}
        onClose={() => setSwitcherOpen(false)}
        searchable
        searchPlaceholder="Search branches and worktrees…"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 32 },
  errorText: { fontSize: 15, fontWeight: '600' },
  segmented: {
    flexDirection: 'row',
    margin: 12,
    borderWidth: 1,
    borderRadius: 8,
    padding: 2,
    gap: 2,
  },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 6 },
  segmentText: { fontSize: 13, fontWeight: '600' },
});
