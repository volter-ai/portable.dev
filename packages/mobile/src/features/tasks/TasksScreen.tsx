/**
 * TasksScreen — the Tasks tab. Thin view over {@link useTasks}:
 *
 *   - "Tasks" header + the My Tasks / All Tasks underline tab strip,
 *   - the filter bar (Owner selector, Backlog toggle, Filters toggle, and
 *     removable active-filter chips) + the collapsible filter menu
 *     (repository, label pills, assignee, state, Clear all) — selects are the
 *     native {@link SelectorSheet} pattern. The repository picker is a
 *     SEARCHABLE select in BOTH views; the `my`-view assignee filter stays a
 *     free-text `TextInput`,
 *   - the grouped scroll area: Done Today (collapsed) / In Review / Todo
 *     (`my`) / Todo Assigned + Todo Unassigned (`all`), a "Cached" badge, a
 *     2px shimmer while a background refresh runs, pull-to-refresh, and the
 *     📋 empty state with per-tab copy.
 *
 * Loading/error follow the mobile convention (spinner / error + retry,
 * `RepoListScreen` precedent). The
 * no-op `groupBy` select is deliberately dropped.
 */

import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '../../theme';
// Direct FILE import (not the chat barrel) — the established MarkdownText
// pattern: the barrel would drag expo-audio/socket/markdown mocks into every
// consumer test.
import { SelectorSheet, type SelectorOption } from '../chat/composer/SelectorSheet';

import { TaskGroup } from './TaskGroup';
import { TaskIssueItem } from './TaskIssueItem';
import { taskItemKey, type RelatedPrChip, type ReviewEntry } from './taskHelpers';
import { useTasks, type UseTasksOptions } from './useTasks';
import type { TaskIssue, TasksView } from './types';
import { TaskItemViewer } from './viewer/TaskItemViewer';
import type { UseViewerChatOptions } from './viewer/useViewerChat';
import {
  viewerTargetForPrUrl,
  viewerTargetForTaskItem,
  type ViewerTarget,
} from './viewer/viewerTypes';

export interface TasksScreenProps extends UseTasksOptions {
  /** AI-action seams for the item viewer (tests inject navigate/makeChatId). */
  viewerChat?: UseViewerChatOptions;
  /**
   * Navigate to the repos list (the "clone a repo" guidance CTA).
   * Defaults to Expo Router `router.push('/repos')`.
   */
  onBrowseRepos?: () => void;
}

type SheetKind = 'owner' | 'state' | 'repo' | 'assignee' | null;

const STATE_OPTIONS: SelectorOption[] = [
  { id: 'open', name: 'State: Open' },
  { id: 'closed', name: 'State: Closed' },
  { id: 'all', name: 'State: All' },
];

export function TasksScreen(props: TasksScreenProps) {
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();
  const t = useTasks(props);
  const browseRepos = props.onBrowseRepos ?? (() => router.push('/repos'));
  const [sheet, setSheet] = useState<SheetKind>(null);
  // The native pull spinner tracks the USER's gesture only — the automatic
  // background refresh must not yank the content down (a background refresh
  // shows only the 2px shimmer; `t.refreshing` drives that).
  const [pulling, setPulling] = useState(false);
  const onPullRefresh = async () => {
    setPulling(true);
    try {
      await t.refresh();
    } finally {
      setPulling(false);
    }
  };

  // Tapping a row opens the FULL in-app detail viewer; rows whose repo can't
  // be derived fall back to the
  // browser. Closing the viewer kicks a silent refresh (so the list reflects
  // any change made while the viewer was open).
  const [viewerTarget, setViewerTarget] = useState<ViewerTarget | null>(null);
  const openTaskItem = (item: TaskIssue) => {
    const targetForItem = viewerTargetForTaskItem(item);
    if (targetForItem) setViewerTarget(targetForItem);
    else t.openItem(item.html_url);
  };
  const openRelatedPr = (related: RelatedPrChip) => {
    const targetForPr = viewerTargetForPrUrl(related.url);
    if (targetForPr) setViewerTarget(targetForPr);
    else t.openItem(related.url);
  };
  const closeViewer = () => {
    setViewerTarget(null);
    void t.refresh();
  };

  const ownerOptions: SelectorOption[] = [
    { id: 'all', name: 'Owner: All' },
    ...t.filterOptions.owners.map((o) => ({ id: o, name: `Owner: ${o}` })),
  ];
  const repoOptions: SelectorOption[] = [
    { id: '', name: 'Repository: All' },
    ...t.filterOptions.repositories.map((r) => ({ id: r, name: `Repository: ${r}` })),
  ];
  const assigneeOptions: SelectorOption[] = [
    { id: '', name: 'Assignee: All' },
    ...t.filterOptions.assignees.map((a) => ({ id: a, name: `Assignee: ${a}` })),
  ];

  const totalItems =
    t.grouped.done.length +
    t.grouped.inReview.length +
    t.grouped.todo.length +
    t.grouped.todoAssigned.length +
    t.grouped.todoUnassigned.length;

  const itemFor = (issue: TaskIssue, group: string, showAssignee: boolean) => (
    <TaskIssueItem
      key={`${group}-${taskItemKey(issue)}`}
      testID={`task-item-${group}-${taskItemKey(issue)}`}
      item={issue}
      showAssignee={showAssignee}
      onPress={() => openTaskItem(issue)}
    />
  );

  const reviewItemFor = (entry: ReviewEntry, showAssignee: boolean) => {
    const related = entry.relatedPR;
    return (
      <TaskIssueItem
        key={entry.key}
        testID={`task-item-review-${taskItemKey(entry.item)}`}
        item={entry.item}
        showAssignee={showAssignee}
        relatedPR={related}
        onPress={() => openTaskItem(entry.item)}
        onRelatedPRPress={related ? () => openRelatedPr(related) : undefined}
      />
    );
  };

  return (
    <View
      testID="tasks-screen"
      style={[
        styles.container,
        { paddingTop: insets.top, backgroundColor: theme.colors.background },
      ]}
    >
      <Text style={[styles.heading, { color: theme.colors.text }]}>Tasks</Text>
      <Text style={styles.hidden} testID="tasks-active-view">
        {t.view}
      </Text>
      <Text style={styles.hidden} testID="tasks-count">
        {totalItems}
      </Text>

      {/* My Tasks / All Tasks underline tab strip. */}
      <View style={[styles.tabStrip, { borderBottomColor: theme.colors.border }]}>
        {(['my', 'all'] as TasksView[]).map((v) => {
          const active = t.view === v;
          return (
            <Pressable
              key={v}
              testID={`tasks-tab-${v}`}
              onPress={() => t.setView(v)}
              style={[
                styles.tab,
                active && { borderBottomColor: theme.colors.primary, borderBottomWidth: 3 },
              ]}
            >
              <Text
                style={[
                  styles.tabText,
                  {
                    color: active ? theme.colors.text : theme.colors.textTertiary,
                    fontWeight: active ? '500' : '400',
                  },
                ]}
              >
                {v === 'my' ? 'My Tasks' : 'All Tasks'}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Filter bar. */}
      <View
        style={[
          styles.filterBar,
          {
            borderBottomColor: theme.colors.border,
            backgroundColor: theme.colors.backgroundElevated,
          },
        ]}
      >
        <View style={styles.filterRow}>
          <Pressable
            testID="tasks-owner-filter"
            onPress={() => setSheet('owner')}
            style={[
              styles.ownerSelect,
              { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
            ]}
          >
            <Text
              style={[
                styles.filterText,
                {
                  color:
                    t.filters.ownerFilter !== 'all' ? theme.colors.text : theme.colors.textTertiary,
                },
              ]}
            >
              Owner: {t.filters.ownerFilter === 'all' ? 'All' : t.filters.ownerFilter} ▾
            </Text>
          </Pressable>

          <Pressable
            testID="tasks-backlog-toggle"
            onPress={t.toggleBacklog}
            style={[
              styles.pillButton,
              {
                backgroundColor: t.filters.showBacklog ? theme.colors.primary : theme.colors.hover,
              },
            ]}
          >
            <Text style={[styles.filterText, { color: theme.colors.text }]}>
              {t.filters.showBacklog ? '✓ ' : ''}Backlog
              {t.backlogCount > 0 ? ` (${t.backlogCount})` : ''}
            </Text>
          </Pressable>

          <Pressable
            testID="tasks-filters-toggle"
            onPress={() => t.setShowFilters(!t.showFilters)}
            style={[
              styles.pillButton,
              { backgroundColor: t.showFilters ? theme.colors.primary : theme.colors.hover },
            ]}
          >
            <Text
              style={[
                styles.filterText,
                { color: t.showFilters ? theme.colors.background : theme.colors.textTertiary },
              ]}
            >
              {t.showFilters ? '✕ Close Filters' : '⚙ Filters'}
            </Text>
          </Pressable>

          {/* Removable active-filter chips. */}
          {t.filters.stateFilter !== 'open' ? (
            <FilterChip
              testID="tasks-chip-state"
              label={`State: ${t.filters.stateFilter === 'closed' ? 'Closed' : 'All'} ✕`}
              onPress={() => t.setStateFilter('open')}
            />
          ) : null}
          {t.filters.repoFilter ? (
            <FilterChip
              testID="tasks-chip-repo"
              label={`Repo: "${t.filters.repoFilter}" ✕`}
              onPress={() => t.setRepoFilter('')}
            />
          ) : null}
          {t.filters.selectedLabels.map((label) => (
            <FilterChip
              key={label}
              testID={`tasks-chip-label-${label}`}
              label={`Label: "${label}" ✕`}
              onPress={() => t.toggleLabel(label)}
            />
          ))}
          {t.filters.assigneeFilter ? (
            <FilterChip
              testID="tasks-chip-assignee"
              label={`Assignee: "${t.filters.assigneeFilter}" ✕`}
              onPress={() => t.setAssigneeFilter('')}
            />
          ) : null}
        </View>

        {/* Collapsible filter menu. */}
        {t.showFilters ? (
          <View style={styles.filterMenu}>
            {/* Repository: a searchable select in BOTH views — the picker
                lists the available repos. */}
            <Pressable
              testID="tasks-filter-repo-select"
              onPress={() => setSheet('repo')}
              style={[styles.menuField, { backgroundColor: theme.colors.surface }]}
            >
              <Text style={[styles.filterText, { color: theme.colors.text }]}>
                Repository: {t.filters.repoFilter || 'All'} ▾
              </Text>
            </Pressable>

            <Text style={[styles.labelsCaption, { color: theme.colors.textSecondary }]}>
              Labels:{' '}
              {t.filters.selectedLabels.length > 0
                ? `${t.filters.selectedLabels.length} selected`
                : 'None'}
            </Text>
            {t.filterOptions.labels.length > 0 ? (
              <ScrollView
                style={styles.labelPillsBox}
                contentContainerStyle={styles.labelPills}
                nestedScrollEnabled
              >
                {t.filterOptions.labels.map((label) => {
                  const selected = t.filters.selectedLabels.includes(label);
                  return (
                    <Pressable
                      key={label}
                      testID={`tasks-filter-label-${label}`}
                      onPress={() => t.toggleLabel(label)}
                      style={[
                        styles.labelPill,
                        { backgroundColor: selected ? theme.colors.hover : 'transparent' },
                      ]}
                    >
                      <Text
                        style={{
                          fontSize: 10,
                          color: selected ? theme.colors.text : theme.colors.textTertiary,
                        }}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : null}

            {t.view === 'all' ? (
              <Pressable
                testID="tasks-filter-assignee-select"
                onPress={() => setSheet('assignee')}
                style={[styles.menuField, { backgroundColor: theme.colors.surface }]}
              >
                <Text style={[styles.filterText, { color: theme.colors.text }]}>
                  Assignee: {t.filters.assigneeFilter || 'All'} ▾
                </Text>
              </Pressable>
            ) : (
              <TextInput
                testID="tasks-filter-assignee"
                style={[
                  styles.menuField,
                  { backgroundColor: theme.colors.surface, color: theme.colors.text },
                ]}
                placeholder="Filter by assignee..."
                placeholderTextColor={theme.colors.textTertiary}
                value={t.filters.assigneeFilter}
                onChangeText={t.setAssigneeFilter}
                autoCapitalize="none"
                autoCorrect={false}
              />
            )}

            <Pressable
              testID="tasks-filter-state"
              onPress={() => setSheet('state')}
              style={[styles.menuField, { backgroundColor: theme.colors.surface }]}
            >
              <Text style={[styles.filterText, { color: theme.colors.text }]}>
                State:{' '}
                {t.filters.stateFilter === 'open'
                  ? 'Open'
                  : t.filters.stateFilter === 'closed'
                    ? 'Closed'
                    : 'All'}{' '}
                ▾
              </Text>
            </Pressable>

            {t.hasActiveFilters ? (
              <Pressable
                testID="tasks-clear-filters"
                onPress={t.clearFilters}
                style={[styles.menuField, { backgroundColor: theme.colors.hover }]}
              >
                <Text style={[styles.filterText, { color: theme.colors.textSecondary }]}>
                  Clear all filters
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>

      {/* Content. */}
      {t.isLoading ? (
        <ActivityIndicator
          testID="tasks-loading"
          style={styles.center}
          color={theme.colors.primary}
        />
      ) : t.isError ? (
        <View style={styles.center} testID="tasks-error">
          <Text style={[styles.errorTitle, { color: theme.colors.error }]}>
            Couldn’t load tasks
          </Text>
          <Pressable testID="tasks-retry" style={styles.retry} onPress={t.retry}>
            <Text style={[styles.retryText, { color: theme.colors.link }]}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          testID="tasks-scroll"
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              refreshing={pulling}
              onRefresh={onPullRefresh}
              tintColor={theme.colors.primary}
            />
          }
        >
          {t.refreshing ? <RefreshShimmer /> : null}
          {t.fromCache ? (
            <Text
              testID="tasks-cached-badge"
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
          ) : null}

          {t.grouped.done.length > 0 ? (
            <TaskGroup
              testID="task-group-done"
              title="Done Today"
              count={t.grouped.done.length}
              defaultExpanded={false}
            >
              {t.grouped.done.map((issue) => itemFor(issue, 'done', t.view !== 'my'))}
            </TaskGroup>
          ) : null}

          {t.grouped.inReviewPrCount > 0 ? (
            <TaskGroup
              testID="task-group-in-review"
              title="In Review"
              count={t.grouped.inReviewPrCount}
            >
              {t.grouped.inReview.map((entry) => reviewItemFor(entry, t.view !== 'my'))}
            </TaskGroup>
          ) : null}

          {t.view === 'my' && t.grouped.todo.length > 0 ? (
            <TaskGroup testID="task-group-todo" title="Todo" count={t.grouped.todo.length}>
              {t.grouped.todo.map((issue) => itemFor(issue, 'todo', false))}
            </TaskGroup>
          ) : null}

          {t.view === 'all' && t.grouped.todoAssigned.length > 0 ? (
            <TaskGroup
              testID="task-group-todo-assigned"
              title="Todo Assigned"
              count={t.grouped.todoAssigned.length}
            >
              {t.grouped.todoAssigned.map((issue) => itemFor(issue, 'todo-assigned', true))}
            </TaskGroup>
          ) : null}

          {t.view === 'all' && t.grouped.todoUnassigned.length > 0 ? (
            <TaskGroup
              testID="task-group-todo-unassigned"
              title="Todo Unassigned"
              count={t.grouped.todoUnassigned.length}
              defaultExpanded={false}
            >
              {t.grouped.todoUnassigned.map((issue) => itemFor(issue, 'todo-unassigned', true))}
            </TaskGroup>
          ) : null}

          {t.noLocalRepos ? (
            // No cloned repos — guide the user to clone one. Takes
            // precedence over the generic empty state (there's nothing to filter).
            <View style={styles.emptyState} testID="tasks-empty-no-repos">
              <Text style={styles.emptyEmoji}>📦</Text>
              <Text style={[styles.emptyTitle, { color: theme.colors.textSecondary }]}>
                No cloned repositories
              </Text>
              <Text style={[styles.emptySub, { color: theme.colors.textSecondary }]}>
                Tasks shows the issues and pull requests from the repositories you’ve cloned. Clone
                a repo you’re working on to see its tasks here.
              </Text>
              <Pressable
                testID="tasks-empty-browse-repos"
                onPress={browseRepos}
                style={[styles.emptyClear, { backgroundColor: theme.colors.primary }]}
              >
                <Text style={styles.emptyClearText}>Browse repositories</Text>
              </Pressable>
            </View>
          ) : t.grouped.isEmpty ? (
            <View style={styles.emptyState} testID="tasks-empty">
              <Text style={styles.emptyEmoji}>📋</Text>
              <Text style={[styles.emptyTitle, { color: theme.colors.textSecondary }]}>
                {t.hasActiveFilters ? 'No tasks match your filters' : 'No tasks to show'}
              </Text>
              {t.hasActiveFilters ? (
                <Pressable
                  testID="tasks-empty-clear"
                  onPress={t.clearFilters}
                  style={[styles.emptyClear, { backgroundColor: theme.colors.primary }]}
                >
                  <Text style={styles.emptyClearText}>Clear filters</Text>
                </Pressable>
              ) : (
                <Text style={[styles.emptySub, { color: theme.colors.textSecondary }]}>
                  {t.view === 'my'
                    ? "You don't have any assigned issues or open PRs"
                    : 'No issues found across your repositories'}
                </Text>
              )}
            </View>
          ) : null}
        </ScrollView>
      )}

      {/* Native selects (the SelectorSheet pattern). */}
      <SelectorSheet
        testID="tasks-owner-sheet"
        visible={sheet === 'owner'}
        title="Owner"
        options={ownerOptions}
        selectedId={t.filters.ownerFilter}
        optionTestIdPrefix="tasks-owner-option"
        onSelect={(id) => {
          t.setOwnerFilter(id);
          setSheet(null);
        }}
        onClose={() => setSheet(null)}
      />
      <SelectorSheet
        testID="tasks-state-sheet"
        visible={sheet === 'state'}
        title="State"
        options={STATE_OPTIONS}
        selectedId={t.filters.stateFilter}
        optionTestIdPrefix="tasks-state-option"
        onSelect={(id) => {
          t.setStateFilter(id as 'open' | 'closed' | 'all');
          setSheet(null);
        }}
        onClose={() => setSheet(null)}
      />
      <SelectorSheet
        testID="tasks-repo-sheet"
        visible={sheet === 'repo'}
        title="Repository"
        searchable
        searchPlaceholder="Search repositories…"
        options={repoOptions}
        selectedId={t.filters.repoFilter}
        optionTestIdPrefix="tasks-repo-option"
        onSelect={(id) => {
          t.setRepoFilter(id);
          setSheet(null);
        }}
        onClose={() => setSheet(null)}
      />
      <SelectorSheet
        testID="tasks-assignee-sheet"
        visible={sheet === 'assignee'}
        title="Assignee"
        options={assigneeOptions}
        selectedId={t.filters.assigneeFilter}
        optionTestIdPrefix="tasks-assignee-option"
        onSelect={(id) => {
          t.setAssigneeFilter(id);
          setSheet(null);
        }}
        onClose={() => setSheet(null)}
      />

      {/* The full in-app issue/PR detail. */}
      <TaskItemViewer
        target={viewerTarget}
        onClose={closeViewer}
        onOpenTarget={setViewerTarget}
        openExternal={t.openItem}
        chatOptions={props.viewerChat}
      />
    </View>
  );
}

function FilterChip({
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
      style={[styles.pillButton, { backgroundColor: theme.colors.hover }]}
    >
      <Text style={[styles.filterText, { color: theme.colors.text }]}>{label}</Text>
    </Pressable>
  );
}

/** The 2px background-refresh shimmer (gradient sweep → animated bar). */
function RefreshShimmer() {
  const { theme } = useAppTheme();
  const progress = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 1500,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [progress]);

  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-0.3 * Math.max(width, 1), Math.max(width, 1) * 1.2],
  });

  return (
    <View
      testID="tasks-refreshing"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={[styles.shimmerTrack, { backgroundColor: theme.colors.backgroundElevated }]}
    >
      <Animated.View
        style={[
          styles.shimmerBar,
          { backgroundColor: theme.colors.primary, transform: [{ translateX }] },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  heading: {
    fontSize: 14,
    fontWeight: '500',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
  },
  hidden: { fontSize: 12, opacity: 0, height: 0 },
  tabStrip: {
    flexDirection: 'row',
    gap: 24,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
  },
  tab: { paddingVertical: 8, marginBottom: -1 },
  tabText: { fontSize: 13 },
  filterBar: { paddingVertical: 8, paddingHorizontal: 10, borderBottomWidth: 1 },
  filterRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  ownerSelect: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  pillButton: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  filterText: { fontSize: 11 },
  filterMenu: { gap: 6, paddingTop: 12, paddingBottom: 8 },
  menuField: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, fontSize: 11 },
  labelsCaption: { fontSize: 11, marginBottom: -2 },
  // An 80px-max scrollable box (a plain View would CLIP overflow).
  labelPillsBox: { maxHeight: 80, flexGrow: 0 },
  labelPills: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  labelPill: { borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  errorTitle: { fontSize: 15, fontWeight: '600' },
  retry: { paddingHorizontal: 16, paddingVertical: 8 },
  retryText: { fontWeight: '600' },
  scroll: { flex: 1 },
  scrollContent: { padding: 8 },
  shimmerTrack: { height: 2, overflow: 'hidden', borderRadius: 1, marginBottom: 4 },
  shimmerBar: { height: 2, width: '30%' },
  cachedBadge: {
    alignSelf: 'flex-end',
    fontSize: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
    opacity: 0.7,
    marginBottom: 2,
  },
  emptyState: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 16 },
  emptyEmoji: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { fontSize: 17, fontWeight: '500' },
  emptySub: { fontSize: 14, marginTop: 8, textAlign: 'center' },
  emptyClear: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginTop: 16,
  },
  emptyClearText: { color: '#ffffff', fontSize: 14, fontWeight: '500' },
});
