/**
 * WorktreeChangesScreen — a single worktree's changes (portable.dev#17).
 *
 * Pushed in-tab when a {@link WorktreesView} row is tapped. A bordered header
 * (back chevron + the worktree's branch/folder label) over the worktree-scoped
 * git surface:
 *
 *   - {@link PushPullHeader} — ahead/behind counters + Pull / Push scoped to
 *     the worktree (a conflicted tree blocks Push; a fresh worktree branch is
 *     auto-published on its first push);
 *   - the shared {@link ChangesView}, scoped via the worktree's absolute path
 *     (the `?worktree=` param the status / stage / file-diff endpoints accept)
 *     — stage / unstage / discard / per-file diffs all work here;
 *   - {@link WorktreeChatComposer} — start a chat that RUNS inside this
 *     worktree (the message rides `chat:create` with the worktree path).
 *
 * Worktree CREATE / REMOVE / PRUNE stay out of scope (follow-up).
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Worktree } from '@vgit2/shared/types';

import { ChangesView } from './ChangesView';
import { PushPullHeader } from './PushPullHeader';
import { WorktreeChatComposer } from './WorktreeChatComposer';
import { Icon, useAppTheme } from '../../theme';

export interface WorktreeChangesScreenProps {
  owner: string;
  repo: string;
  /** The worktree to inspect (its `path` scopes the reads). */
  worktree: Worktree;
  /** Back-navigation seam (the tab returns to the worktrees list). */
  onBack?: () => void;
}

/** The trailing path segment (the worktree's folder name). */
function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const parts = trimmed.split('/');
  return parts[parts.length - 1] || path;
}

export function WorktreeChangesScreen({
  owner,
  repo,
  worktree,
  onBack,
}: WorktreeChangesScreenProps) {
  const { theme } = useAppTheme();
  const title = worktree.detached
    ? folderName(worktree.path)
    : (worktree.branch ?? folderName(worktree.path));

  return (
    <View style={styles.container} testID="worktree-changes-screen">
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <Pressable testID="worktree-changes-back" onPress={onBack} hitSlop={8} style={styles.back}>
          <Icon name="chevron-left" size={16} color={theme.colors.textSecondary} />
        </Pressable>
        <View style={styles.titleWrap}>
          <Text
            style={[styles.title, { color: theme.colors.text }]}
            numberOfLines={1}
            testID="worktree-changes-title"
          >
            {title}
          </Text>
          <Text style={[styles.subtitle, { color: theme.colors.textTertiary }]} numberOfLines={1}>
            {folderName(worktree.path)}
          </Text>
        </View>
      </View>
      <PushPullHeader owner={owner} repo={repo} worktree={worktree.path} />
      <View style={styles.body}>
        <ChangesView owner={owner} repo={repo} worktree={worktree.path} />
      </View>
      <WorktreeChatComposer
        owner={owner}
        repo={repo}
        worktree={worktree.path}
        branchLabel={title}
      />
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
  titleWrap: { flex: 1 },
  title: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 11, marginTop: 1 },
  body: { flex: 1 },
});
