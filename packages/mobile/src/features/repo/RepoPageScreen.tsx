/**
 * RepoPageScreen — the repository detail shell.
 *
 * Chrome: a bordered header (chevron back + 20px owner avatar + repo
 * name), the horizontal underline tab strip ({@link REPO_TABS} — `PRs`,
 * `Details`), and the active tab's content. The
 * Overview tab is the working dashboard ({@link OverviewTab} — there is NO
 * README on the overview).
 *
 * Thin view over {@link useRepoPage} (tab state + allowed-tabs guard),
 * {@link useRepoDetails} (header avatar), and {@link useRepoBranches}.
 */

import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { BranchWithDate } from '@vgit2/shared/types';

import { Icon, useAppTheme } from '../../theme';
import { ActionsTab } from './ActionsTab';
import { GenerationsTab } from './GenerationsTab';
import { IssuesTab } from './IssuesTab';
import { OverviewTab } from './OverviewTab';
import { PullsTab } from './PullsTab';
import { SettingsTab } from './SettingsTab';
import { WorkflowsTab } from './WorkflowsTab';
import { RowCard } from './RowCard';
import { IMPLEMENTED_REPO_TABS, REPO_TABS, type RepoTab } from './repoTabs';
import { useRepoBranches, type UseRepoBranchesOptions } from './useRepoBranches';
import { useRepoDetails } from './useRepoOverview';
import { useRepoPage } from './useRepoPage';

export interface RepoPageScreenProps {
  owner: string;
  repo: string;
  /** Initial `?tab=` param — runs through the allowed-tabs guard. */
  tab?: string | null;
  /** Back-navigation seam (default: no-op; the route shell supplies router.back). */
  onBack?: () => void;
  /** Branch-comparison override forwarded to {@link useRepoBranches}. */
  onCompareBranch?: UseRepoBranchesOptions['onCompareBranch'];
  /** Navigation seam forwarded to {@link useRepoBranches}. */
  navigate?: UseRepoBranchesOptions['navigate'];
}

export function RepoPageScreen({
  owner,
  repo,
  tab,
  onBack,
  onCompareBranch,
  navigate,
}: RepoPageScreenProps) {
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();
  const { activeTab, setTab } = useRepoPage({ initialTab: tab });
  // Header avatar (20px owner avatar next to the repo name) — the same
  // query the Overview tab uses, deduped by key.
  const details = useRepoDetails(owner, repo);
  const avatarUrl = details.data?.owner?.avatar_url;

  return (
    <View
      style={[
        styles.container,
        { paddingTop: insets.top, backgroundColor: theme.colors.background },
      ]}
      testID="repo-page"
    >
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <Pressable testID="repo-back" onPress={onBack} hitSlop={8} style={styles.back}>
          <Icon name="chevron-left" size={16} color={theme.colors.textSecondary} />
        </Pressable>
        {avatarUrl ? (
          <Image source={{ uri: avatarUrl }} style={styles.avatar} testID="repo-owner-avatar" />
        ) : (
          <View style={[styles.avatar, { backgroundColor: theme.colors.surface }]} />
        )}
        <Text
          style={[styles.title, { color: theme.colors.text }]}
          numberOfLines={1}
          testID="repo-title"
        >
          {repo}
        </Text>
      </View>

      {/* Hidden marker exposing the resolved active tab (virtualization-proof). */}
      <Text style={styles.hidden} testID="repo-active-tab">
        {activeTab}
      </Text>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[styles.tabBar, { borderBottomColor: theme.colors.border }]}
        contentContainerStyle={styles.tabBarContent}
        testID="repo-tab-bar"
      >
        {REPO_TABS.map((t) => {
          const isActive = activeTab === t.key;
          return (
            <Pressable
              key={t.key}
              testID={`repo-tab-${t.key}`}
              onPress={() => setTab(t.key)}
              style={[
                styles.tab,
                {
                  borderBottomWidth: 3,
                  borderBottomColor: isActive ? theme.colors.primary : 'transparent',
                },
              ]}
            >
              <Text
                style={[
                  styles.tabText,
                  isActive
                    ? { color: theme.colors.text, fontWeight: '500' }
                    : { color: theme.colors.textTertiary },
                ]}
              >
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.body}>
        {activeTab === 'overview' ? (
          <OverviewTab owner={owner} repo={repo} onSelectTab={setTab} navigate={navigate} />
        ) : activeTab === 'branches' ? (
          <BranchesTab
            owner={owner}
            repo={repo}
            onCompareBranch={onCompareBranch}
            navigate={navigate}
          />
        ) : activeTab === 'issues' ? (
          <IssuesTab owner={owner} repo={repo} />
        ) : activeTab === 'prs' ? (
          <PullsTab owner={owner} repo={repo} />
        ) : activeTab === 'actions' ? (
          <ActionsTab owner={owner} repo={repo} />
        ) : activeTab === 'workflows' ? (
          <WorkflowsTab owner={owner} repo={repo} />
        ) : activeTab === 'generations' ? (
          <GenerationsTab owner={owner} repo={repo} />
        ) : activeTab === 'settings' ? (
          <SettingsTab owner={owner} repo={repo} />
        ) : (
          <PlaceholderTab tab={activeTab} />
        )}
      </View>
    </View>
  );
}

function BranchesTab({
  owner,
  repo,
  onCompareBranch,
  navigate,
}: {
  owner: string;
  repo: string;
  onCompareBranch?: UseRepoBranchesOptions['onCompareBranch'];
  navigate?: UseRepoBranchesOptions['navigate'];
}) {
  const { theme } = useAppTheme();
  const dir = useRepoBranches(owner, repo, { onCompareBranch, navigate });

  if (dir.isLoading) {
    return (
      <ActivityIndicator
        testID="repo-branches-loading"
        style={styles.center}
        color={theme.colors.primary}
      />
    );
  }
  if (dir.isError) {
    return (
      <View style={styles.center} testID="repo-branches-error">
        <Text style={[styles.errorText, { color: theme.colors.error }]}>
          Couldn’t load branches
        </Text>
      </View>
    );
  }
  return (
    <FlatList
      testID="repo-branches-list"
      data={dir.branches}
      keyExtractor={(b) => b.name}
      renderItem={({ item }) => (
        <BranchRow branch={item} onCompare={() => dir.compareBranch(item)} />
      )}
      ListEmptyComponent={
        <Text
          style={[styles.emptyText, { color: theme.colors.textSecondary }]}
          testID="repo-branches-empty"
        >
          No branches
        </Text>
      }
      ListFooterComponent={
        dir.hasMore ? (
          <Pressable
            testID="repo-branches-load-more"
            style={styles.loadMore}
            onPress={dir.loadMore}
            disabled={dir.isFetchingMore}
          >
            <Text style={[styles.loadMoreText, { color: theme.colors.link }]}>
              {dir.isFetchingMore ? 'Loading…' : 'Load more'}
            </Text>
          </Pressable>
        ) : null
      }
    />
  );
}

function BranchRow({ branch, onCompare }: { branch: BranchWithDate; onCompare: () => void }) {
  const { theme } = useAppTheme();
  return (
    <RowCard testID={`repo-branch-${branch.name}`} style={styles.branchRow}>
      <View style={styles.branchInfo}>
        <Text style={[styles.branchName, { color: theme.colors.text }]} numberOfLines={1}>
          ⎇ {branch.name}
        </Text>
        {branch.lastCommitDate ? (
          <Text
            style={[styles.branchDate, { color: theme.colors.textSecondary }]}
            testID={`repo-branch-date-${branch.name}`}
          >
            Last commit {formatDate(branch.lastCommitDate)}
          </Text>
        ) : null}
      </View>
      <Pressable
        testID={`repo-branch-compare-${branch.name}`}
        onPress={onCompare}
        hitSlop={8}
        style={[styles.compareBtn, { backgroundColor: theme.colors.accentSoft }]}
      >
        <Text style={[styles.compareText, { color: theme.colors.primary }]}>Compare</Text>
      </Pressable>
    </RowCard>
  );
}

function PlaceholderTab({ tab }: { tab: RepoTab }) {
  const { theme } = useAppTheme();
  // Implemented tabs never reach here; this is for the wired-but-future tabs.
  const isImplemented = (IMPLEMENTED_REPO_TABS as readonly string[]).includes(tab);
  if (isImplemented) return null;
  return (
    <View style={styles.center} testID={`repo-tab-placeholder-${tab}`}>
      <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>Coming soon</Text>
    </View>
  );
}

/** Format an ISO date to a short, locale-stable label. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Header: 0.5rem 0.75rem padding, bottom border, 0.75rem gap.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
  },
  back: { paddingVertical: 4, paddingRight: 2 },
  avatar: { width: 20, height: 20, borderRadius: 10 },
  title: { flex: 1, fontSize: 14, fontWeight: '500' },
  hidden: { height: 0, opacity: 0 },
  // Tab strip: 1.5rem gap, 0.75rem side padding, bottom border.
  tabBar: { flexGrow: 0, borderBottomWidth: 1 },
  tabBarContent: { gap: 24, paddingHorizontal: 12, paddingRight: 16 },
  tab: { paddingVertical: 8, marginBottom: -1 },
  tabText: { fontSize: 13 },
  body: { flex: 1, marginTop: 12, paddingHorizontal: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 24 },
  errorText: { fontSize: 15, fontWeight: '600' },
  emptyText: { paddingVertical: 24, textAlign: 'center' },
  // Layout only — the card chrome (bg/radius/padding) comes from RowCard.
  branchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  branchInfo: { flex: 1, gap: 2 },
  branchName: { fontSize: 15, fontWeight: '600' },
  branchDate: { fontSize: 12 },
  compareBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
  },
  compareText: { fontWeight: '600', fontSize: 13 },
  loadMore: { padding: 16, alignItems: 'center' },
  loadMoreText: { fontWeight: '600' },
});
