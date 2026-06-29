/**
 * RepoListScreen — the searchable, paginated repository list.
 *
 * Thin view over {@link useRepoDirectory}. The compact header
 * title, the search bar with the embedded filter toggle (Language + Sort live in a
 * collapsible panel whose `<select>`s become native `SelectorSheet`s — the
 * sanctioned tasks-feature pattern), the "Found N repositories" results count, the
 * minimal two-line `RepoCard` (20px owner avatar + name + NEW/reason badges, second
 * line = compact git-status indicators or the default branch), the "Cached" pill,
 * and the DUAL empty states (no repos at all vs. no search results + "Clear all
 * filters"). Also: the Cloned badge, pull-to-refresh (native spinner — there's no
 * background-refresh shimmer trigger here since the app never
 * auto-refreshes after the cached page), the "Load more" footer, and DISTINCT
 * loading / error / empty states (spinner instead of pulse skeletons, the
 * documented mobile convention).
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { GitStatus, RepositoryWithLocal } from '@vgit2/shared/types';

import { Icon, useAppTheme, withAlpha } from '../../theme';

// Direct FILE imports (the sanctioned cross-feature pattern — tasks does the same).
import { SelectorSheet } from '../chat/composer/SelectorSheet';
// The repos-list error remedy is "Connect PC" (re-scan the pairing QR): a failed
// list means the PC connection is broken. (In local-first GitHub credentials live on
// the PC — the launcher resolves them — so there is no phone-side GitHub connect.)
import { PcConnectModal, type PcConnectModalProps } from '../pc-connect/PcConnectModal';

import {
  useRepoDirectory,
  REPOS_DEFAULT_SORT,
  type RepoSort,
  type UseRepoDirectoryOptions,
} from './useRepoDirectory';

export interface RepoListScreenProps extends UseRepoDirectoryOptions {
  /** Override the PC-connect (QR re-scan) seams of the error-state modal (tests). */
  pcConnect?: Pick<PcConnectModalProps, 'link' | 'connect' | 'renderScanner'>;
}

/** Sort options for the sort selector. */
const SORT_OPTIONS: { id: RepoSort; name: string }[] = [
  { id: 'updated', name: 'Recently updated' },
  { id: 'stars', name: 'Most stars' },
  { id: 'name', name: 'Name (A-Z)' },
];

const ALL_LANGUAGES_ID = 'all';

export function RepoListScreen({ pcConnect, ...dirOptions }: RepoListScreenProps) {
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();
  const dir = useRepoDirectory(dirOptions);

  const [showFilters, setShowFilters] = useState(false);
  const [languageSheetOpen, setLanguageSheetOpen] = useState(false);
  const [sortSheetOpen, setSortSheetOpen] = useState(false);
  // "Connect PC" on the fetch-error state re-opens the QR scanner — a failing list
  // is a broken PC connection, so re-pairing (not GitHub) is the remedy.
  const [connectPcOpen, setConnectPcOpen] = useState(false);

  // The filter glyph tints primary while the panel is open OR a non-default
  // language/sort filter is applied (search alone doesn't tint it).
  const filtersTinted = showFilters || !!dir.language || dir.sort !== REPOS_DEFAULT_SORT;
  const filtered = !!dir.searchInput || !!dir.language;

  const sortLabel = SORT_OPTIONS.find((o) => o.id === dir.sort)?.name ?? 'Recently updated';

  const clearAll = () => {
    dir.clearFilters();
    setShowFilters(false);
  };

  return (
    <View
      style={[
        styles.container,
        { paddingTop: insets.top, backgroundColor: theme.colors.background },
      ]}
      testID="repo-list"
    >
      <Text style={[styles.heading, { color: theme.colors.text }]}>Repositories</Text>
      <Text style={styles.count} testID="repo-list-count">
        {dir.repos.length}
      </Text>

      {/* Search bar: input + divider + filter toggle (+ clear). */}
      <View style={[styles.searchBar, { borderColor: theme.colors.border }]}>
        <Icon name="search" size={14} color={theme.colors.textSecondary} strokeWidth={2} />
        <TextInput
          testID="repo-search-input"
          style={[styles.searchInput, { color: theme.colors.text }]}
          placeholder="Search repositories..."
          placeholderTextColor={theme.colors.textTertiary}
          value={dir.searchInput}
          onChangeText={dir.setSearch}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
        <Pressable
          testID="repo-filters-toggle"
          style={styles.barButton}
          onPress={() => setShowFilters((v) => !v)}
          hitSlop={8}
        >
          <Icon
            name="filter"
            size={14}
            color={filtersTinted ? theme.colors.primary : theme.colors.textSecondary}
            strokeWidth={2}
          />
        </Pressable>
        {dir.hasActiveFilters ? (
          <>
            <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
            <Pressable
              testID="repo-clear-filters"
              style={styles.barButton}
              onPress={clearAll}
              hitSlop={8}
            >
              <Icon name="xmark" size={14} color={theme.colors.textSecondary} strokeWidth={2} />
            </Pressable>
          </>
        ) : null}
      </View>

      {/* Filters panel — a slide-down card; selects → SelectorSheets. */}
      {showFilters ? (
        <View
          style={[styles.filtersPanel, { backgroundColor: theme.colors.surfaceHover }]}
          testID="repo-filters-panel"
        >
          <View>
            <Text style={[styles.filterLabel, { color: theme.colors.textSecondary }]}>
              Language
            </Text>
            <SelectTrigger
              testID="repo-language-select"
              label={dir.language ?? 'All languages'}
              onPress={() => setLanguageSheetOpen(true)}
            />
          </View>
          <View>
            <Text style={[styles.filterLabel, { color: theme.colors.textSecondary }]}>Sort by</Text>
            <SelectTrigger
              testID="repo-sort-select"
              label={sortLabel}
              onPress={() => setSortSheetOpen(true)}
            />
          </View>
        </View>
      ) : null}

      {/* Search results count (only while a search/language narrows). */}
      {filtered && dir.totalCount !== undefined ? (
        <Text
          style={[styles.resultsCount, { color: theme.colors.textSecondary }]}
          testID="repo-results-count"
        >
          Found {dir.totalCount} {dir.totalCount === 1 ? 'repository' : 'repositories'}
        </Text>
      ) : null}

      {dir.isLoading ? (
        <ActivityIndicator
          testID="repo-list-loading"
          style={styles.center}
          color={theme.colors.primary}
        />
      ) : dir.isError ? (
        <View style={styles.center} testID="repo-list-error">
          <Text style={[styles.errorTitle, { color: theme.colors.error }]}>
            Couldn’t load repositories
          </Text>
          <Pressable testID="repo-list-retry" style={styles.retry} onPress={dir.refetch}>
            <Text style={[styles.retryText, { color: theme.colors.link }]}>Try again</Text>
          </Pressable>
          <Pressable
            testID="repo-list-connect-pc"
            accessibilityRole="button"
            style={[styles.connectButton, { backgroundColor: theme.colors.primary }]}
            onPress={() => setConnectPcOpen(true)}
          >
            <Text style={[styles.connectButtonText, { color: theme.colors.textInverse }]}>
              Connect PC
            </Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          testID="repo-list-flatlist"
          style={styles.list}
          data={dir.repos}
          keyExtractor={(r) => String(r.id)}
          renderItem={({ item }) => (
            <RepoCard
              repo={item}
              cloning={dir.cloningRepoId === item.id}
              onPress={() => dir.openRepo(item)}
            />
          )}
          refreshing={dir.refreshing}
          onRefresh={dir.refresh}
          onEndReachedThreshold={0.5}
          onEndReached={dir.loadMore}
          ListHeaderComponent={
            dir.isFromCache && !dir.refreshing ? (
              <View style={styles.cachedRow}>
                <Text
                  testID="repo-list-cached-badge"
                  style={[
                    styles.cachedBadge,
                    {
                      color: theme.colors.textTertiary,
                      backgroundColor: theme.colors.backgroundElevated,
                    },
                  ]}
                >
                  Cached
                </Text>
              </View>
            ) : null
          }
          ListEmptyComponent={
            filtered ? (
              <View style={styles.emptyState} testID="repo-list-empty">
                <Text style={styles.emptyEmoji}>🔍</Text>
                <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
                  No repositories found
                </Text>
                <Text style={[styles.emptySub, { color: theme.colors.textSecondary }]}>
                  Try adjusting your search or filters
                </Text>
                <Pressable
                  testID="repo-list-empty-clear"
                  onPress={clearAll}
                  style={[styles.emptyClear, { backgroundColor: theme.colors.hover }]}
                >
                  <Text style={[styles.emptyClearText, { color: theme.colors.textSecondary }]}>
                    Clear all filters
                  </Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.emptyState} testID="repo-list-empty">
                <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
                  No Repositories
                </Text>
                <Text style={[styles.emptySub, { color: theme.colors.textSecondary }]}>
                  Try creating a new project by describing it in the input bar
                </Text>
              </View>
            )
          }
          ListFooterComponent={
            dir.hasMore ? (
              <Pressable
                testID="repo-list-load-more"
                style={styles.loadMore}
                onPress={dir.loadMore}
                disabled={dir.isFetchingMore}
              >
                <Text style={[styles.loadMoreText, { color: theme.colors.textSecondary }]}>
                  {dir.isFetchingMore ? 'Loading...' : 'Load more'}
                </Text>
              </Pressable>
            ) : null
          }
        />
      )}

      {/* Native selects (the SelectorSheet pattern). */}
      <SelectorSheet
        testID="repo-language-sheet"
        visible={languageSheetOpen}
        title="Language"
        options={[
          { id: ALL_LANGUAGES_ID, name: 'All languages' },
          ...dir.languages.map((lang) => ({ id: lang, name: lang })),
        ]}
        selectedId={dir.language ?? ALL_LANGUAGES_ID}
        optionTestIdPrefix="repo-language"
        onSelect={(id) => {
          dir.setLanguage(id === ALL_LANGUAGES_ID ? null : id);
          setLanguageSheetOpen(false);
        }}
        onClose={() => setLanguageSheetOpen(false)}
      />
      <SelectorSheet
        testID="repo-sort-sheet"
        visible={sortSheetOpen}
        title="Sort by"
        options={SORT_OPTIONS}
        selectedId={dir.sort}
        optionTestIdPrefix="repo-sort"
        onSelect={(id) => {
          dir.setSort(id as RepoSort);
          setSortSheetOpen(false);
        }}
        onClose={() => setSortSheetOpen(false)}
      />

      <PcConnectModal
        visible={connectPcOpen}
        link={pcConnect?.link}
        connect={pcConnect?.connect}
        renderScanner={pcConnect?.renderScanner}
        onConnected={() => {
          // Re-pointed at the PC — refetch the list that failed on the dead link.
          dir.refetch();
        }}
        onDismiss={() => setConnectPcOpen(false)}
      />
    </View>
  );
}

/** Select look: surface field with the current value + a chevron. */
function SelectTrigger({
  testID,
  label,
  onPress,
}: {
  testID: string;
  label: string;
  onPress: () => void;
}) {
  const { theme } = useAppTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={[
        styles.selectTrigger,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
    >
      <Text style={[styles.selectTriggerText, { color: theme.colors.text }]} numberOfLines={1}>
        {label}
      </Text>
      <Icon name="chevron-down" size={12} color={theme.colors.textSecondary} strokeWidth={2} />
    </Pressable>
  );
}

/**
 * RepoCard — line 1 = 20px owner avatar + repo NAME +
 * NEW badge / reason (+ the local-status badge), line 2 (indented 28px) = compact
 * git-status indicators for a local clone, else the default branch.
 *
 * A CLONED repo shows the green "Cloned" badge; an UNCLONED remote shows a "Clone"
 * pill (tapping the card clones it to the workspace), which becomes a spinner +
 * "Cloning…" while the clone is in flight (`cloning`).
 */
function RepoCard({
  repo,
  cloning = false,
  onPress,
}: {
  repo: RepositoryWithLocal;
  cloning?: boolean;
  onPress: () => void;
}) {
  const { theme } = useAppTheme();
  const [avatarFailed, setAvatarFailed] = useState(false);
  const cloned = repo.isLocal || repo.localStatus === 'cloned';
  const avatarUrl = !avatarFailed && repo.owner?.avatar_url ? repo.owner.avatar_url : null;

  return (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: pressed ? theme.colors.surfaceHover : theme.colors.surface },
      ]}
      testID={`repo-card-${repo.id}`}
      onPress={onPress}
      disabled={cloning}
    >
      <View style={styles.cardHeader}>
        {avatarUrl ? (
          <Image
            source={{ uri: avatarUrl }}
            onError={() => setAvatarFailed(true)}
            style={[styles.avatar, { backgroundColor: theme.colors.border }]}
          />
        ) : (
          <View style={[styles.avatar, { backgroundColor: theme.colors.border }]} />
        )}
        <Text style={[styles.cardName, { color: theme.colors.text }]} numberOfLines={1}>
          {repo.name}
        </Text>
        <View style={styles.badgeCluster}>
          {repo.isNew ? (
            <Text
              style={[
                styles.newBadge,
                {
                  color: theme.colors.primary,
                  backgroundColor: withAlpha(theme.colors.primary, '15'),
                },
              ]}
              testID={`repo-new-${repo.id}`}
            >
              NEW
            </Text>
          ) : null}
          {cloned ? (
            <Text
              style={[
                styles.clonedBadge,
                {
                  backgroundColor: withAlpha(theme.colors.success, '22'),
                  color: theme.colors.success,
                },
              ]}
              testID={`repo-cloned-${repo.id}`}
            >
              Cloned
            </Text>
          ) : cloning ? (
            <View style={styles.cloningBadge} testID={`repo-cloning-${repo.id}`}>
              <ActivityIndicator size="small" color={theme.colors.primary} />
              <Text style={[styles.cloningText, { color: theme.colors.primary }]}>Cloning…</Text>
            </View>
          ) : (
            <View
              style={[
                styles.cloneBadge,
                { backgroundColor: withAlpha(theme.colors.primary, '15') },
              ]}
              testID={`repo-clone-${repo.id}`}
            >
              <Icon name="download" size={10} color={theme.colors.primary} strokeWidth={2} />
              <Text style={[styles.cloneText, { color: theme.colors.primary }]}>Clone</Text>
            </View>
          )}
          {repo.reason ? (
            <Text style={[styles.reason, { color: theme.colors.textTertiary }]} numberOfLines={1}>
              {repo.reason}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={styles.cardSecondLine}>
        {repo.isLocal && repo.gitStatus ? (
          <RepoGitStatusLine gitStatus={repo.gitStatus} testID={`repo-git-status-${repo.id}`} />
        ) : repo.default_branch ? (
          <Text
            style={[styles.branch, { color: theme.colors.textSecondary }]}
            numberOfLines={1}
            testID={`repo-branch-${repo.id}`}
          >
            {repo.default_branch}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * Compact git-status indicators (compact + showBranch): branch •
 * +insertions/-deletions • ↑ahead • ↓behind • staged/modified/untracked counts,
 * bullet-separated, zero-count segments omitted. (No `unpushedCount` on the shared
 * type — the fallback chain lands on `gitStatus.ahead`.)
 */
function RepoGitStatusLine({ gitStatus, testID }: { gitStatus: GitStatus; testID: string }) {
  const { theme } = useAppTheme();
  const dot = <Text style={[styles.gitText, { color: theme.colors.textTertiary }]}>•</Text>;
  const hasDiff = gitStatus.insertions > 0 || gitStatus.deletions > 0;
  const hasFiles = gitStatus.staged > 0 || gitStatus.modified > 0 || gitStatus.untracked > 0;

  return (
    <View style={styles.gitLine} testID={testID}>
      {gitStatus.branch ? (
        <Text style={[styles.gitText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
          {gitStatus.branch}
        </Text>
      ) : null}
      {hasDiff ? (
        <>
          {gitStatus.branch ? dot : null}
          {gitStatus.insertions > 0 ? (
            <Text style={[styles.gitText, { color: theme.colors.success }]}>
              +{gitStatus.insertions}
            </Text>
          ) : null}
          {gitStatus.deletions > 0 ? (
            <Text style={[styles.gitText, { color: theme.colors.error }]}>
              -{gitStatus.deletions}
            </Text>
          ) : null}
        </>
      ) : null}
      {gitStatus.ahead > 0 ? (
        <>
          {dot}
          <Text style={[styles.gitText, { color: theme.colors.info }]}>↑{gitStatus.ahead}</Text>
        </>
      ) : null}
      {gitStatus.behind > 0 ? (
        <>
          {dot}
          <Text style={[styles.gitText, { color: theme.colors.warning }]}>↓{gitStatus.behind}</Text>
        </>
      ) : null}
      {hasFiles ? (
        <>
          {dot}
          {gitStatus.staged > 0 ? (
            <Text style={[styles.gitText, { color: theme.colors.textSecondary }]}>
              {gitStatus.staged}S
            </Text>
          ) : null}
          {gitStatus.modified > 0 ? (
            <Text style={[styles.gitText, { color: theme.colors.warning }]}>
              {gitStatus.modified}M
            </Text>
          ) : null}
          {gitStatus.untracked > 0 ? (
            <Text style={[styles.gitText, { color: theme.colors.textSecondary }]}>
              {gitStatus.untracked}U
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  // 0.875rem / 500 — the compact page title.
  heading: { fontSize: 14, fontWeight: '500', paddingTop: 12, marginBottom: 12 },
  count: { fontSize: 12, opacity: 0, height: 0 },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  searchInput: { flex: 1, fontSize: 14, padding: 0, marginLeft: 8 },
  divider: { width: 1, height: 20, marginHorizontal: 8 },
  barButton: { paddingHorizontal: 4, paddingVertical: 4 },
  filtersPanel: { marginTop: 12, borderRadius: 8, padding: 12, gap: 12 },
  filterLabel: { fontSize: 12, fontWeight: '500', marginBottom: 6 },
  selectTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  selectTriggerText: { fontSize: 14, flexShrink: 1 },
  resultsCount: { marginTop: 8, fontSize: 12, textAlign: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  errorTitle: { fontSize: 15, fontWeight: '600' },
  retry: { paddingHorizontal: 16, paddingVertical: 8 },
  retryText: { fontWeight: '600' },
  connectButton: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8 },
  connectButtonText: { fontSize: 14, fontWeight: '600' },
  list: { marginTop: 12 },
  cachedRow: { alignItems: 'flex-end', marginBottom: 4 },
  cachedBadge: {
    fontSize: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    opacity: 0.7,
    overflow: 'hidden',
  },
  // Grid card: surface bg, radius 8, padding 10/12, gap 8 between cards.
  card: {
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  avatar: { width: 20, height: 20, borderRadius: 10 },
  cardName: { flex: 1, fontSize: 14, fontWeight: '500' },
  badgeCluster: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  newBadge: {
    fontSize: 10,
    fontWeight: '600',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    letterSpacing: 0.4,
    overflow: 'hidden',
  },
  clonedBadge: {
    fontSize: 10,
    fontWeight: '600',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  cloneBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  cloneText: { fontSize: 10, fontWeight: '600' },
  cloningBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2 },
  cloningText: { fontSize: 10, fontWeight: '600' },
  reason: { fontSize: 11, maxWidth: 120 },
  // paddingLeft 28px aligns under the name (20px avatar + 8px gap).
  cardSecondLine: { paddingLeft: 28, marginTop: 6, minHeight: 14, justifyContent: 'center' },
  branch: { fontSize: 11 },
  gitLine: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  gitText: { fontSize: 11 },
  emptyState: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 16, gap: 8 },
  emptyEmoji: { fontSize: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  emptySub: { fontSize: 14, textAlign: 'center', maxWidth: 320, lineHeight: 20 },
  emptyClear: {
    marginTop: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  emptyClearText: { fontSize: 14 },
  loadMore: { padding: 16, alignItems: 'center' },
  loadMoreText: { fontSize: 12 },
});
