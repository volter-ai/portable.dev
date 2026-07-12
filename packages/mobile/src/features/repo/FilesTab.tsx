/**
 * FilesTab — the repo "Files" tab: the lazily expanding directory tree card
 * (previously the Overview dashboard's bottom section, promoted to its own tab
 * so the Overview stays focused on the chats).
 *
 * Gates on the repo being locally cloned (the `isLocal` 404 pattern; the SAME
 * `useRepoDetails` query the page header + Overview tab use, deduped by key) and
 * renders {@link CloneFirstNotice} otherwise. The card keeps its own refresh
 * control (invalidates the whole tree PREFIX — root + every expanded level);
 * a file tap navigates to the file viewer route.
 *
 * Thin view over {@link useRepoTree} (per-level directory queries).
 */

import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CloneFirstNotice } from './CloneFirstNotice';
import { useRepoDetails } from './useRepoOverview';
import { useRepoTree, type RepoTreeEntry } from './useRepoTree';
import { queryKeys } from '../api/keys';
import { getRelativeTime } from '../home/homeHelpers';
import { Icon, useAppTheme, type Theme } from '../../theme';

/** The iOS Files-app folder blue. */
const FOLDER_COLOR = '#5AC8FA';

/**
 * Minimum time the refresh control stays in its active (busy) state, so the
 * feedback is perceptible even when the refetch returns instantly from cache
 * (holds the busy state for ~500ms).
 */
const MIN_REFRESH_FEEDBACK_MS = 500;

export interface FilesTabProps {
  owner: string;
  repo: string;
  /** Navigation seam for file taps (default `router.push`). */
  navigate?: (path: string) => void;
}

export function FilesTab({ owner, repo, navigate }: FilesTabProps) {
  const { theme } = useAppTheme();
  // The route shell doesn't thread a navigate seam — default to the imperative
  // router so file taps work in the live app.
  const nav = navigate ?? ((path: string) => router.push(path));
  const details = useRepoDetails(owner, repo);

  if (details.isLoading) {
    return (
      <ActivityIndicator
        testID="files-loading"
        style={styles.center}
        color={theme.colors.primary}
      />
    );
  }
  if (details.isError) {
    return (
      <View style={styles.center} testID="files-error">
        <Text style={[styles.errorText, { color: theme.colors.error }]}>
          Couldn’t load the repository
        </Text>
      </View>
    );
  }
  if (details.data?.isLocal !== true) {
    return <CloneFirstNotice testID="files-clone-gate" detail="to browse its files" />;
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="files-tab">
      <DirectoryCard owner={owner} repo={repo} navigate={nav} theme={theme} />
    </ScrollView>
  );
}

/** The directory tree card (Files sub-tab header + refresh). */
function DirectoryCard({
  owner,
  repo,
  navigate,
  theme,
}: {
  owner: string;
  repo: string;
  navigate: (path: string) => void;
  theme: Theme;
}) {
  const root = useRepoTree(owner, repo, '');
  const queryClient = useQueryClient();

  // Visible refresh feedback. The OLD `() => void root.refetch()` re-hit
  // only the root level and surfaced NOTHING on screen: the body spinner is keyed
  // on `isLoading` (first-load only, never flips on a refetch) and the glyph was a
  // static icon. We now invalidate the whole tree PREFIX — refetching the root AND
  // every currently-mounted (expanded) folder level — while holding a
  // perceptible busy state on the control even when the refetch returns instantly.
  const [refreshing, setRefreshing] = useState(false);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  const handleRefresh = useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    void Promise.all([
      // Prefix match (exact:false) → root + every expanded level refetch; the
      // awaited promise reflects the in-flight refetch (`isFetching`), unlike the
      // first-load-only `isLoading` the body spinner reads.
      queryClient.invalidateQueries({ queryKey: queryKeys.treePrefix(owner, repo) }),
      new Promise<void>((resolve) => setTimeout(resolve, MIN_REFRESH_FEEDBACK_MS)),
    ]).finally(() => {
      if (mountedRef.current) setRefreshing(false);
    });
  }, [refreshing, queryClient, owner, repo]);

  const openFile = (path: string) => navigate(`/repos/${owner}/${repo}/file/${path}`);

  return (
    <View style={[styles.treeCard, { backgroundColor: theme.colors.surface }]} testID="repo-tree">
      <View style={[styles.treeHeader, { borderBottomColor: theme.colors.border }]}>
        <View
          style={[
            styles.treeTab,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
          ]}
        >
          <Text style={[styles.treeTabText, { color: theme.colors.text }]}>Files</Text>
        </View>
        <Pressable
          testID="repo-tree-refresh"
          accessibilityRole="button"
          accessibilityLabel="Refresh files"
          accessibilityState={{ busy: refreshing, disabled: refreshing }}
          onPress={handleRefresh}
          disabled={refreshing}
          hitSlop={8}
          style={[styles.treeRefresh, { opacity: refreshing ? 0.5 : 1 }]}
        >
          {refreshing ? (
            <ActivityIndicator
              testID="repo-tree-refreshing"
              size="small"
              color={theme.colors.textSecondary}
            />
          ) : (
            <Icon name="refresh" size={13} color={theme.colors.textSecondary} />
          )}
        </Pressable>
      </View>

      <View style={styles.treeBody}>
        {root.isLoading ? (
          <ActivityIndicator
            testID="repo-tree-loading"
            style={styles.treePad}
            color={theme.colors.primary}
          />
        ) : root.isError ? (
          <Text style={[styles.treeEmpty, { color: theme.colors.error }]} testID="repo-tree-error">
            Couldn’t read the directory
          </Text>
        ) : !root.data?.contents.length ? (
          <Text
            style={[styles.treeEmpty, { color: theme.colors.textSecondary }]}
            testID="repo-tree-empty"
          >
            Directory is empty
          </Text>
        ) : (
          root.data.contents.map((entry) => (
            <TreeNode
              key={entry.path}
              entry={entry}
              level={0}
              owner={owner}
              repo={repo}
              onOpenFile={openFile}
              theme={theme}
            />
          ))
        )}
      </View>
    </View>
  );
}

/** One tree row; expanded folders mount their child level (lazy query). */
function TreeNode({
  entry,
  level,
  owner,
  repo,
  onOpenFile,
  theme,
}: {
  entry: RepoTreeEntry;
  level: number;
  owner: string;
  repo: string;
  onOpenFile: (path: string) => void;
  theme: Theme;
}) {
  const [expanded, setExpanded] = useState(false);
  const isDir = entry.type === 'directory';
  const emptyDir = isDir && entry.hasChildren === false;

  return (
    <>
      <Pressable
        testID={`repo-tree-node-${entry.path}`}
        accessibilityRole="button"
        onPress={() => (isDir ? setExpanded((e) => !e) : onOpenFile(entry.path))}
        style={[styles.treeRow, { paddingLeft: level * 16 + 12 }]}
      >
        <View style={emptyDir ? styles.treeIconDim : undefined}>
          <Icon
            name={isDir ? 'folder' : 'file'}
            size={14}
            color={isDir ? FOLDER_COLOR : theme.colors.textSecondary}
          />
        </View>
        <Text
          style={[
            styles.treeName,
            { color: entry.isHidden ? theme.colors.textTertiary : theme.colors.text },
          ]}
          numberOfLines={1}
        >
          {entry.name}
        </Text>
        {!isDir && entry.lastModified ? (
          <Text style={[styles.treeTime, { color: theme.colors.textTertiary }]}>
            {getRelativeTime(entry.lastModified)}
          </Text>
        ) : null}
      </Pressable>

      {isDir && expanded ? (
        <TreeLevel
          owner={owner}
          repo={repo}
          path={entry.path}
          level={level + 1}
          onOpenFile={onOpenFile}
          theme={theme}
        />
      ) : null}
    </>
  );
}

/** A lazily fetched directory level (mounted only while its folder is expanded). */
function TreeLevel({
  owner,
  repo,
  path,
  level,
  onOpenFile,
  theme,
}: {
  owner: string;
  repo: string;
  path: string;
  level: number;
  onOpenFile: (path: string) => void;
  theme: Theme;
}) {
  const tree = useRepoTree(owner, repo, path);

  if (tree.isLoading) {
    return (
      <ActivityIndicator
        size="small"
        style={[styles.treeLevelLoading, { marginLeft: level * 16 + 12 }]}
        color={theme.colors.primary}
      />
    );
  }
  if (tree.isError || !tree.data?.contents.length) return null;

  return (
    <>
      {tree.data.contents.map((entry) => (
        <TreeNode
          key={entry.path}
          entry={entry}
          level={level}
          owner={owner}
          repo={repo}
          onOpenFile={onOpenFile}
          theme={theme}
        />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 24 },
  errorText: { fontSize: 15, fontWeight: '600' },
  scroll: { paddingBottom: 32 },

  // Directory tree card (surface bg, 0.5rem radius, bordered tab header).
  treeCard: { borderRadius: 8, overflow: 'hidden' },
  treeHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 8,
    borderBottomWidth: 1,
  },
  treeTab: {
    borderWidth: 1,
    borderBottomWidth: 0,
    borderTopLeftRadius: 6,
    borderTopRightRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginBottom: -1,
  },
  treeTabText: { fontSize: 12, fontWeight: '500' },
  treeRefresh: { padding: 6, marginBottom: 4 },
  treeBody: { paddingVertical: 8 },
  treePad: { paddingVertical: 16 },
  treeEmpty: { textAlign: 'center', paddingVertical: 16, fontSize: 13 },
  treeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 5,
    paddingRight: 12,
  },
  treeIconDim: { opacity: 0.4 },
  treeName: { flex: 1, fontSize: 13 },
  treeTime: { fontSize: 11 },
  treeLevelLoading: { alignSelf: 'flex-start', paddingVertical: 4 },
});
