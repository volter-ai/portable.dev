/**
 * OverviewTab — the repo working dashboard.
 *
 * Sections, in order:
 *   1. Homepage link bar (favicon + URL, opens the system browser)
 *   2. "Work on {repo}..." input (cloned) OR the Clone-to-Local card (not cloned)
 *   3. Quick-action pills (horizontal scroll, status dots)
 *   4. Git status bar — branch chip + ↑ahead/↓behind + "n changed" / "✓ up to date"
 *   5. "Continue chats" preview — this repo's recent chats (the same bounded,
 *      internally-scrolling section as the home page), so the file tree below
 *      still pokes up from the bottom
 *   6. Directory tree card — lazy per-folder listing; file tap → file viewer
 *
 * There is NO README here — the overview never renders one.
 * Deliberate v1 gaps (documented, not bugs): the branch chip routes to
 * the Branches tab instead of opening the search dropdown; the directory card
 * ships only the Files sub-tab (no Env/Diff/Commits); file rows use a single
 * glyph color (no per-language brand colors); runtime-type quick actions land
 * on the runtime hub.
 *
 * Thin view over {@link useRepoOverview} (data + actions) and
 * {@link useRepoTree} (per-level directory queries).
 */

import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { GitStatus, QuickAction } from '@vgit2/shared/types';

import type { RepoTab } from './repoTabs';
import { useRepoOverview, type UseRepoOverview } from './useRepoOverview';
import { useRepoTree, type RepoTreeEntry } from './useRepoTree';
import { selectRepoChats } from './repoChats';
import { useChats, useRepoCommands } from '../api/hooks';
import { queryKeys } from '../api/keys';
// Direct FILE imports (never the chat/home barrels — the mock-avalanche rule).
import { useChatActionSheet } from '../chat/ChatActionSheet';
import { POLLED_CHAT_LIST_OPTIONS } from '../chat/chatListPolling';
import { ShortFormComposer } from '../chat/composer/ShortFormComposer';
import { SlashCommandPicker, parseSlashQuery } from '../chat/composer/SlashCommandPicker';
import { faviconUrl } from '../chat/frameworks';
import { getRelativeTime } from '../home/homeHelpers';
import { HomeChatsSection } from '../home/HomeChatsSection';
import { Icon, useAppTheme, withAlpha, type Theme } from '../../theme';

/** The iOS Files-app folder blue. */
const FOLDER_COLOR = '#5AC8FA';

/**
 * Minimum time the refresh control stays in its active (busy) state, so the
 * feedback is perceptible even when the refetch returns instantly from cache
 * (holds the busy state for ~500ms).
 */
const MIN_REFRESH_FEEDBACK_MS = 500;

/**
 * Cap for the Overview "Continue chats" preview. The section is bounded-height
 * (~3 cards visible) and scrolls internally, so feeding it a handful of recent
 * chats keeps the preview scrollable while the file tree below stays on screen.
 */
const REPO_CHATS_PREVIEW_MAX = 8;

export interface OverviewTabProps {
  owner: string;
  repo: string;
  /** Tab-switch seam — the branch chip routes to the Branches tab (v1). */
  onSelectTab?: (tab: RepoTab) => void;
  /** Navigation seam for file taps + the chat hand-off (default `router.push`). */
  navigate?: (path: string) => void;
}

export function OverviewTab({ owner, repo, onSelectTab, navigate }: OverviewTabProps) {
  const { theme } = useAppTheme();
  // The route shell doesn't thread a navigate seam — default to the imperative
  // router so file taps + the chat hand-off work in the live app.
  const nav = navigate ?? ((path: string) => router.push(path));
  const vm = useRepoOverview(owner, repo, { navigate: nav });
  // This repo's recent chats for the "Continue chats" preview. `retry:false` so a
  // missing/failing list never retries or blocks the dashboard — the section just
  // stays hidden (it renders nothing with no chats). It also POLLS without caching
  // (POLLED_CHAT_LIST_OPTIONS) so chats started/updated on the PC surface here while
  // you sit on the Overview tab; the poll stops when this tab unmounts (inner-tab
  // switch) — RepoPageScreen renders only the active tab.
  const chatsQuery = useChats({ retry: false, ...POLLED_CHAT_LIST_OPTIONS });
  const repoChats = selectRepoChats(
    chatsQuery.data?.chats ?? [],
    owner,
    repo,
    REPO_CHATS_PREVIEW_MAX
  );
  // Long-press a chat in the Overview preview → the shared Pin/Save/Archive/Delete
  // sheet (the same menu as the /chats directory + the home preview).
  const chatActions = useChatActionSheet();

  if (vm.isLoadingDetails) {
    return (
      <ActivityIndicator
        testID="repo-overview-loading"
        style={styles.center}
        color={theme.colors.primary}
      />
    );
  }
  if (vm.isErrorDetails) {
    return (
      <View style={styles.center} testID="repo-overview-error">
        <Text style={[styles.errorText, { color: theme.colors.error }]}>
          Couldn’t load the repository
        </Text>
      </View>
    );
  }

  const homepage = vm.details?.homepage || null;

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      testID="repo-overview"
      // The slash-command picker opens as an overlay over this page; without this the
      // page ScrollView grabs the first tap to dismiss the keyboard, so an option needs
      // two taps. "handled" lets a tap the picker captures pass through.
      keyboardShouldPersistTaps="handled"
    >
      {homepage ? <HomepageBar homepage={homepage} theme={theme} /> : null}

      <View style={styles.sections}>
        {vm.isLocal ? (
          <WorkOnInput owner={owner} repo={repo} vm={vm} theme={theme} />
        ) : (
          <CloneCard owner={owner} repo={repo} vm={vm} theme={theme} />
        )}

        {vm.isLocal && (vm.loadingQuickActions || vm.quickActions.length > 0) ? (
          <QuickActionsRow vm={vm} theme={theme} />
        ) : null}

        {vm.isLocal && vm.gitStatus ? (
          <GitStatusBar
            gitStatus={vm.gitStatus}
            theme={theme}
            onBranchPress={() => onSelectTab?.('branches')}
          />
        ) : null}

        {/* This repo's recent chats — bounded + internally scrolling (the home
            preview), so the file tree below still pokes up from the bottom. Renders
            nothing when this repo has no chats. */}
        {repoChats.length > 0 ? (
          <HomeChatsSection
            chats={repoChats}
            onChatPress={(chatId) => nav(`/chat/${chatId}`)}
            onChatLongPress={chatActions.open}
            onSeeMore={() => nav('/chats')}
          />
        ) : null}
        {chatActions.element}

        {vm.isLocal ? (
          <DirectoryCard owner={owner} repo={repo} navigate={nav} theme={theme} />
        ) : null}
      </View>
    </ScrollView>
  );
}

/** Section 1 — the homepage link bar (favicon + URL + ↗). */
function HomepageBar({ homepage, theme }: { homepage: string; theme: Theme }) {
  return (
    <Pressable
      testID="repo-overview-homepage"
      accessibilityRole="link"
      onPress={() => void Linking.openURL(homepage)}
      style={[styles.homepageBar, { backgroundColor: theme.colors.surface }]}
    >
      <Image source={{ uri: faviconUrl(homepage) }} style={styles.homepageFavicon} />
      <Text style={[styles.homepageUrl, { color: theme.colors.text }]} numberOfLines={1}>
        {homepage}
      </Text>
      <Text style={[styles.homepageExternal, { color: theme.colors.textSecondary }]}>↗</Text>
    </Pressable>
  );
}

/** Section 3 (local) — the "Work on {repo}..." chat input. */
function WorkOnInput({
  owner,
  repo,
  vm,
  theme,
}: {
  owner: string;
  repo: string;
  vm: UseRepoOverview;
  theme: Theme;
}) {
  const [text, setText] = useState('');
  const [slashDismissed, setSlashDismissed] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const canSend = vm.canStartWork && text.trim().length > 0;

  // Slash-command / skill picker — loaded for the repo so the commands are present
  // in this initial window (before any chat exists). Active while typing `/…`.
  const commandsQuery = useRepoCommands(owner, repo);
  const slashQuery = parseSlashQuery(text);
  const slashActive = slashQuery !== null && !slashDismissed;

  // Argument-hint ghost text: once a command is fully typed/selected (`/name `), show its
  // `argument-hint` greyed after the value — hidden while the picker is still open.
  const argHint = (() => {
    const m = /^\/(\S+)\s*$/.exec(text);
    if (!m) return '';
    const cmd = (commandsQuery.data?.commands ?? []).find((c) => c.name === m[1]);
    if (!cmd?.argumentHint) return '';
    return (text.endsWith(' ') ? '' : ' ') + cmd.argumentHint;
  })();

  const send = () => {
    if (!canSend) return;
    const message = text;
    setText('');
    void vm.startWork(message).catch(() => setText(message));
  };

  // Insert `/<name> ` and keep focus so the user can add arguments before sending.
  const pickCommand = (name: string) => {
    setText(`/${name} `);
    inputRef.current?.focus();
  };

  // `zIndex` floats the overlay (+ its dropdown) above the sections below it in the
  // Overview ScrollView; the picker itself is absolute, so it never reflows them.
  return (
    <View style={styles.workOnWrap}>
      {slashActive ? (
        <SlashCommandPicker
          direction="down"
          commands={commandsQuery.data?.commands ?? []}
          query={slashQuery ?? ''}
          loading={commandsQuery.isLoading}
          onSelect={pickCommand}
          onDismiss={() => setSlashDismissed(true)}
        />
      ) : null}
      <View style={[styles.inputCard, { backgroundColor: theme.colors.surface }, theme.shadows.sm]}>
        {/* The shared short-form composer (the SAME widget as the home page): a mic while
            the input is empty, the holdable Send widget once the user types. */}
        <ShortFormComposer
          value={text}
          onChangeText={(t) => {
            setText(t);
            setSlashDismissed(false);
          }}
          onSubmit={send}
          canSend={canSend}
          placeholder={`Work on ${repo}...`}
          inputRef={inputRef}
          inputStyle={styles.input}
          ghostText={slashActive ? undefined : argHint}
          inputTestID="repo-overview-input"
          sendTestID="repo-overview-send"
          voiceTestID="repo-overview-voice"
        />
      </View>
    </View>
  );
}

/** Section 3 (not local) — clone status copy + the Clone-to-Local button. */
function CloneCard({
  owner,
  repo,
  vm,
  theme,
}: {
  owner: string;
  repo: string;
  vm: UseRepoOverview;
  theme: Theme;
}) {
  return (
    <View style={[styles.cloneCard, { backgroundColor: theme.colors.surfaceHover }]}>
      <Text style={[styles.cloneCopy, { color: theme.colors.textSecondary }]}>
        {vm.isCloning
          ? `Cloning ${owner}/${repo}… this may take a moment.`
          : 'This repository is not cloned locally. Clone it to work with the agent for hands-on development.'}
      </Text>
      <Pressable
        testID="repo-overview-clone"
        accessibilityRole="button"
        onPress={vm.clone}
        disabled={vm.isCloning}
        style={[
          styles.cloneButton,
          { backgroundColor: theme.colors.hover, opacity: vm.isCloning ? 0.6 : 1 },
        ]}
      >
        {vm.isCloning ? (
          <ActivityIndicator size="small" color={theme.colors.textSecondary} />
        ) : (
          <Icon name="download" size={12} color={theme.colors.text} />
        )}
        <Text style={[styles.cloneButtonText, { color: theme.colors.text }]}>Clone to Local</Text>
      </Pressable>
    </View>
  );
}

/** Section 4 — the horizontally scrolling quick-action pills. */
function QuickActionsRow({ vm, theme }: { vm: UseRepoOverview; theme: Theme }) {
  const dotColor = (action: QuickAction) =>
    action.statusDotColor === 'yellow'
      ? theme.colors.warning
      : action.statusDotColor === 'grey'
        ? theme.colors.textTertiary
        : theme.colors.success;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.quickActionsRow}
      testID="repo-quick-actions"
    >
      {vm.loadingQuickActions
        ? [0, 1, 2].map((i) => (
            <View
              key={i}
              style={[
                styles.quickActionPill,
                styles.quickActionPlaceholder,
                {
                  backgroundColor: theme.colors.surface,
                },
              ]}
            />
          ))
        : vm.quickActions.map((action) => {
            const disabled = action.type === 'message' && !vm.canStartWork;
            return (
              <Pressable
                key={action.id}
                testID={`repo-quick-action-${action.id}`}
                accessibilityRole="button"
                disabled={disabled}
                onPress={() => void vm.runQuickAction(action)}
                style={[
                  styles.quickActionPill,
                  { backgroundColor: theme.colors.surface, opacity: disabled ? 0.5 : 1 },
                ]}
              >
                {action.hasStatusDot ? (
                  <View style={[styles.statusDot, { backgroundColor: dotColor(action) }]} />
                ) : null}
                <Text style={[styles.quickActionLabel, { color: theme.colors.textSecondary }]}>
                  {action.label}
                  {action.labelBold ? (
                    <Text style={[styles.quickActionBold, { color: theme.colors.text }]}>
                      {' '}
                      {action.labelBold}
                    </Text>
                  ) : null}
                </Text>
              </Pressable>
            );
          })}
    </ScrollView>
  );
}

/** Section 5 — the compact git status bar. */
function GitStatusBar({
  gitStatus,
  theme,
  onBranchPress,
}: {
  gitStatus: GitStatus;
  theme: Theme;
  onBranchPress: () => void;
}) {
  const changed = gitStatus.staged + gitStatus.modified + gitStatus.untracked;
  const upToDate = gitStatus.ahead === 0 && gitStatus.behind === 0 && changed === 0;

  return (
    <View
      style={[styles.gitBar, { backgroundColor: theme.colors.surface }]}
      testID="repo-overview-git"
    >
      <Pressable
        testID="repo-overview-branch"
        accessibilityRole="button"
        onPress={onBranchPress}
        style={[
          styles.branchChip,
          {
            backgroundColor: theme.colors.surface,
            borderColor: withAlpha(theme.colors.border, '40'),
          },
        ]}
      >
        <Icon name="code-branch" size={11} color={theme.colors.text} />
        <Text
          style={[
            styles.branchName,
            { color: theme.colors.text, fontFamily: theme.typography.fontFamilyMono },
          ]}
          numberOfLines={1}
        >
          {gitStatus.branch}
        </Text>
        <Icon name="chevron-down" size={10} color={theme.colors.textSecondary} />
      </Pressable>

      {gitStatus.ahead > 0 ? (
        <Text style={[styles.gitCount, { color: theme.colors.success }]} testID="repo-git-ahead">
          ↑{gitStatus.ahead}
        </Text>
      ) : null}
      {gitStatus.behind > 0 ? (
        <Text style={[styles.gitCount, { color: theme.colors.warning }]} testID="repo-git-behind">
          ↓{gitStatus.behind}
        </Text>
      ) : null}
      {changed > 0 ? (
        <>
          <Text style={[styles.gitBullet, { color: theme.colors.textSecondary }]}>•</Text>
          <Text style={[styles.gitCount, { color: theme.colors.text }]} testID="repo-git-changed">
            {changed} changed
          </Text>
        </>
      ) : null}
      {upToDate ? (
        <Text
          style={[styles.gitCount, { color: theme.colors.success }]}
          testID="repo-git-up-to-date"
        >
          ✓ up to date
        </Text>
      ) : null}
    </View>
  );
}

/** Section 6 — the directory tree card (Files sub-tab + refresh). */
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
  sections: { gap: 16, paddingTop: 12 },

  // Homepage link bar (padding 0.5rem 1rem, surface bg).
  homepageBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    marginTop: 4,
  },
  homepageFavicon: { width: 14, height: 14, borderRadius: 2 },
  homepageUrl: { flex: 1, fontSize: 13 },
  homepageExternal: { fontSize: 10, opacity: 0.5 },

  // "Work on {repo}..." input card.
  workOnWrap: { zIndex: 1000 },
  inputCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    paddingVertical: 8,
    paddingLeft: 14,
    paddingRight: 8,
  },
  input: { flex: 1, fontSize: 15, paddingVertical: 6 },

  // Clone card (surfaceHover bg, 0.75rem padding, 0.5rem radius).
  cloneCard: { borderRadius: 8, padding: 12, gap: 10 },
  cloneCopy: { fontSize: 11, lineHeight: 16 },
  cloneButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  cloneButtonText: { fontSize: 11, fontWeight: '500' },

  // Quick-action pills (pill radius 999, 0.5rem 0.875rem padding).
  quickActionsRow: { gap: 8, paddingBottom: 4 },
  quickActionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  quickActionPlaceholder: { width: 96, height: 33 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  quickActionLabel: { fontSize: 13 },
  quickActionBold: { fontWeight: '600' },

  // Git status bar (0.375rem 0.625rem padding, 0.25rem radius, 11px text).
  gitBar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 4,
  },
  branchChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderRadius: 4,
    maxWidth: '60%',
  },
  branchName: { fontSize: 11, fontWeight: '500', flexShrink: 1 },
  gitCount: { fontSize: 11, fontWeight: '500' },
  gitBullet: { fontSize: 11 },

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
