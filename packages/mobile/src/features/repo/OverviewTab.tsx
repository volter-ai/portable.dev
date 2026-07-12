/**
 * OverviewTab — the repo working dashboard.
 *
 * Sections, in order:
 *   1. Homepage link bar (favicon + URL, opens the system browser)
 *   2. "Work on {repo}..." input (cloned) OR the Clone-to-Local card (not cloned)
 *   3. Quick-action pills (horizontal scroll, status dots)
 *   4. Git status bar — branch chip + ↑ahead/↓behind + "n changed" / "✓ up to date"
 *   5. "Continue chats" — this repo's recent chats, FILLING the remaining space
 *      (the home page's anchored `fill` mode: the page never scrolls as a whole,
 *      only the chats area scrolls internally)
 *
 * The directory tree lives in its OWN "Files" tab ({@link FilesTab}) — promoted
 * out of this dashboard so the chats area gets the freed space.
 * There is NO README here — the overview never renders one.
 * Deliberate v1 gaps (documented, not bugs): the branch chip routes to
 * the Branches tab instead of opening the search dropdown; file rows use a
 * single glyph color (no per-language brand colors); runtime-type quick actions
 * land on the runtime hub.
 *
 * Thin view over {@link useRepoOverview} (data + actions).
 */

import { router } from 'expo-router';
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { GitStatus, QuickAction } from '@vgit2/shared/types';

import type { RepoTab } from './repoTabs';
import { RepoChatInput } from './RepoChatInput';
import { useRepoOverview, type UseRepoOverview } from './useRepoOverview';
import { selectRepoChats } from './repoChats';
import { useChats } from '../api/hooks';
// Direct FILE imports (never the chat/home barrels — the mock-avalanche rule).
import { useChatActionSheet } from '../chat/ChatActionSheet';
import { POLLED_CHAT_LIST_OPTIONS } from '../chat/chatListPolling';
import { faviconUrl } from '../chat/frameworks';
import { HomeChatsSection } from '../home/HomeChatsSection';
import { Icon, useAppTheme, withAlpha, type Theme } from '../../theme';

/**
 * Cap for the Overview "Continue chats" area. The section fills the space below
 * the fixed dashboard sections and scrolls internally (the home `fill` mode), so
 * it can show a deeper backlog than the old bounded ~3-card preview.
 */
const REPO_CHATS_PREVIEW_MAX = 12;

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
  // The repo page is a Stack screen (no bottom tab bar), so the anchored page
  // absorbs the bottom safe-area inset itself.
  const insets = useSafeAreaInsets();
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
    // ANCHORED page (the home-page model): the dashboard sections stay pinned and
    // only the "Continue chats" area below scrolls, filling the space the old
    // directory tree used to reserve (the tree now lives in the Files tab).
    <View style={[styles.page, { paddingBottom: insets.bottom }]} testID="repo-overview">
      {homepage ? <HomepageBar homepage={homepage} theme={theme} /> : null}

      <View style={styles.sections}>
        {vm.isLocal ? (
          <RepoChatInput
            owner={owner}
            repo={repo}
            placeholder={`Work on ${repo}...`}
            canSend={vm.canStartWork}
            onSubmit={vm.startWork}
            direction="down"
            inputTestID="repo-overview-input"
            sendTestID="repo-overview-send"
            voiceTestID="repo-overview-voice"
          />
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

        {/* This repo's recent chats — fills the remaining vertical space and
            scrolls internally (the only scrollable region on the anchored page). */}
        <HomeChatsSection
          chats={repoChats}
          loading={chatsQuery.isLoading}
          onChatPress={(chatId) => nav(`/chat/${chatId}`)}
          onChatLongPress={chatActions.open}
          onSeeMore={() => nav('/chats')}
          fill
        />
        {chatActions.element}
      </View>
    </View>
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
    // flexGrow:0 is load-bearing: RN's ScrollView base style is flexGrow:1, so
    // inside the ANCHORED page column (fixed height, no outer scroll) the row
    // would otherwise absorb the leftover height and stretch the pills into
    // full-height capsules.
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.quickActionsScroll}
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

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 24 },
  errorText: { fontSize: 15, fontWeight: '600' },
  page: { flex: 1 },
  // flex:1 so the chats section (fill) expands to fill the space below the fixed
  // dashboard sections.
  sections: { flex: 1, gap: 16, paddingTop: 12 },

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
  quickActionsScroll: { flexGrow: 0 },
  quickActionsRow: { gap: 8, paddingBottom: 4, alignItems: 'center' },
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
});
