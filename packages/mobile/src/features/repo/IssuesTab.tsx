/**
 * IssuesTab — the RepoPage Issues tab.
 *
 * A list view and an in-tab detail view (issue body, comments, post-a-comment,
 * assignee add/remove). Detail navigation is local component state — there is no
 * nested route yet, matching the screen's existing in-shell tab model.
 *
 * The list's filter bar is the GitHub-style experience:
 *   - an always-visible debounced search box,
 *   - Open/Closed count tabs (the active state shows its `totalCount`),
 *   - a Label dropdown (all repo labels, colored dots — multi-select / AND),
 *   - an Assignee dropdown (repo collaborators),
 *   - a Sort dropdown (Newest / Oldest / Recently updated),
 *   - dismissible active-filter pills,
 * and `IssueRow` now renders label color-dots + assignee avatars. All of it
 * wires through to the existing backend `issues` query params via
 * {@link useRepoIssues}; labels/collaborators come from {@link useRepoLabels} /
 * {@link useRepoCollaborators}.
 *
 * Thin view over {@link useRepoIssues} (list) and {@link useRepoIssue} (detail +
 * comment / assignee mutations).
 */

import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { GitHubUser, Issue, Label } from '@vgit2/shared/types';

import { SelectorSheet, type SelectorOption } from '../chat/composer/SelectorSheet';
import { useAppTheme } from '../../theme';
import { RowCard } from './RowCard';
import { useRepoIssue, type IssueComment } from './useRepoIssue';
import {
  useRepoCollaborators,
  useRepoIssues,
  useRepoLabels,
  type IssueDirection,
  type IssueListFilters,
  type IssueSort,
  type IssueState,
} from './useRepoIssues';

export interface IssuesTabProps {
  owner: string;
  repo: string;
}

/** The three sort presets surfaced in the UI. */
type SortKey = 'newest' | 'oldest' | 'updated';

const SORT_OPTIONS: SelectorOption[] = [
  { id: 'newest', name: 'Newest' },
  { id: 'oldest', name: 'Oldest' },
  { id: 'updated', name: 'Recently updated' },
];

/**
 * Map a sort preset to the backend `sort`/`direction` params. "newest" maps to
 * NOTHING — the backend already defaults to created/desc, so the default
 * request stays bare (and existing tests keep their query string).
 */
const SORT_FILTER: Record<SortKey, { sort?: IssueSort; direction?: IssueDirection }> = {
  newest: {},
  oldest: { sort: 'created', direction: 'asc' },
  updated: { sort: 'updated', direction: 'desc' },
};

const SORT_LABEL: Record<SortKey, string> = {
  newest: 'Newest',
  oldest: 'Oldest',
  updated: 'Recently updated',
};

const SEARCH_DEBOUNCE_MS = 350;

/** GitHub label colors are 6-hex without the leading `#`; guard + prefix it. */
function labelColor(color?: string): string {
  if (color && /^[0-9a-fA-F]{6}$/.test(color)) return `#${color}`;
  return '#888888';
}

export function IssuesTab({ owner, repo }: IssuesTabProps) {
  const [selected, setSelected] = useState<number | null>(null);

  if (selected != null) {
    return (
      <IssueDetail owner={owner} repo={repo} number={selected} onBack={() => setSelected(null)} />
    );
  }
  return <IssuesList owner={owner} repo={repo} onOpen={setSelected} />;
}

function IssuesList({
  owner,
  repo,
  onOpen,
}: {
  owner: string;
  repo: string;
  onOpen: (n: number) => void;
}) {
  const { theme } = useAppTheme();

  const [state, setState] = useState<IssueState>('open');
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [assignee, setAssignee] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('newest');
  const [openSheet, setOpenSheet] = useState<null | 'label' | 'assignee' | 'sort'>(null);

  // Debounce the search box into the committed query (which keys the request).
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  const filters: IssueListFilters = {
    state,
    labels: selectedLabels.length > 0 ? selectedLabels : undefined,
    assignee: assignee || undefined,
    text: searchQuery || undefined,
    ...SORT_FILTER[sortKey],
  };

  const dir = useRepoIssues(owner, repo, filters);
  const { labels } = useRepoLabels(owner, repo);
  const { collaborators } = useRepoCollaborators(owner, repo);

  const assigneeName = collaborators.find((c) => c.username === assignee)?.name || assignee;
  const assigneeOptions: SelectorOption[] = [
    { id: '', name: 'All assignees' },
    ...collaborators.map((c) => ({ id: c.username, name: c.name || c.username })),
  ];

  // Dismissible active-filter pills (one per applied filter).
  const pills: { key: string; testID: string; label: string; onClear: () => void }[] = [];
  if (searchQuery) {
    pills.push({
      key: 'text',
      testID: 'repo-issues-pill-text',
      label: `"${searchQuery}"`,
      onClear: () => {
        setSearchInput('');
        setSearchQuery('');
      },
    });
  }
  selectedLabels.forEach((l) =>
    pills.push({
      key: `label-${l}`,
      testID: `repo-issues-pill-label-${l}`,
      label: `Label: ${l}`,
      onClear: () => setSelectedLabels((prev) => prev.filter((x) => x !== l)),
    })
  );
  if (assignee) {
    pills.push({
      key: 'assignee',
      testID: 'repo-issues-pill-assignee',
      label: `Assignee: ${assigneeName}`,
      onClear: () => setAssignee(''),
    });
  }
  if (sortKey !== 'newest') {
    pills.push({
      key: 'sort',
      testID: 'repo-issues-pill-sort',
      label: `Sort: ${SORT_LABEL[sortKey]}`,
      onClear: () => setSortKey('newest'),
    });
  }

  const openLabel = state === 'open' && dir.totalCount != null ? `${dir.totalCount} Open` : 'Open';
  const closedLabel =
    state === 'closed' && dir.totalCount != null ? `${dir.totalCount} Closed` : 'Closed';

  return (
    <View style={styles.fill}>
      {/* Search + sort row */}
      <View style={styles.searchRow}>
        <View
          style={[
            styles.searchBox,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
          ]}
        >
          <Text style={[styles.searchIcon, { color: theme.colors.textTertiary }]}>🔍</Text>
          <TextInput
            testID="repo-issues-search"
            style={[styles.searchInput, { color: theme.colors.text }]}
            placeholder="Search issues…"
            placeholderTextColor={theme.colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            value={searchInput}
            onChangeText={setSearchInput}
          />
        </View>
        <DropdownButton
          label={SORT_LABEL[sortKey]}
          testID="repo-issues-filter-sort"
          active={sortKey !== 'newest'}
          onPress={() => setOpenSheet('sort')}
        />
      </View>

      {/* State tabs + label/assignee dropdowns */}
      <View style={styles.filterRow}>
        <FilterChip
          label={openLabel}
          testID="repo-issues-filter-open"
          active={state === 'open'}
          onPress={() => setState('open')}
        />
        <FilterChip
          label={closedLabel}
          testID="repo-issues-filter-closed"
          active={state === 'closed'}
          onPress={() => setState('closed')}
        />
        <DropdownButton
          label={selectedLabels.length > 0 ? `Labels (${selectedLabels.length})` : 'Label'}
          testID="repo-issues-filter-label"
          active={selectedLabels.length > 0}
          onPress={() => setOpenSheet('label')}
        />
        <DropdownButton
          label={assignee ? assigneeName : 'Assignee'}
          testID="repo-issues-filter-assignee"
          active={!!assignee}
          onPress={() => setOpenSheet('assignee')}
        />
      </View>

      {/* Active filter pills */}
      {pills.length > 0 ? (
        <View style={styles.pillRow} testID="repo-issues-active-filters">
          {pills.map((p) => (
            <Pressable
              key={p.key}
              testID={p.testID}
              onPress={p.onClear}
              style={[styles.pill, { backgroundColor: theme.colors.accentSoft }]}
            >
              <Text style={[styles.pillText, { color: theme.colors.text }]} numberOfLines={1}>
                {p.label}
              </Text>
              <Text style={[styles.pillRemove, { color: theme.colors.text }]}>✕</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* Virtualization-proof list length. */}
      <Text style={styles.hidden} testID="repo-issues-count">
        {dir.issues.length}
      </Text>

      {dir.isLoading ? (
        <ActivityIndicator
          testID="repo-issues-loading"
          style={styles.center}
          color={theme.colors.primary}
        />
      ) : dir.isError ? (
        <View style={styles.center} testID="repo-issues-error">
          <Text style={[styles.errorText, { color: theme.colors.error }]}>
            Couldn’t load issues
          </Text>
        </View>
      ) : (
        <FlatList
          testID="repo-issues-list"
          data={dir.issues}
          keyExtractor={(i) => String(i.number)}
          renderItem={({ item }) => <IssueRow issue={item} onPress={() => onOpen(item.number)} />}
          ListEmptyComponent={
            <Text
              style={[styles.emptyText, { color: theme.colors.textSecondary }]}
              testID="repo-issues-empty"
            >
              No {state} issues
            </Text>
          }
          ListFooterComponent={
            dir.hasMore ? (
              <Pressable
                testID="repo-issues-load-more"
                style={styles.loadMore}
                onPress={dir.loadMore}
                disabled={dir.isFetchingMore}
              >
                <Text style={[styles.loadMoreText, { color: theme.colors.primary }]}>
                  {dir.isFetchingMore ? 'Loading…' : 'Load more'}
                </Text>
              </Pressable>
            ) : null
          }
        />
      )}

      {/* Filter sheets */}
      <SelectorSheet
        testID="repo-issues-sort-sheet"
        visible={openSheet === 'sort'}
        title="Sort issues"
        options={SORT_OPTIONS}
        selectedId={sortKey}
        optionTestIdPrefix="repo-issues-sort-option"
        onSelect={(id) => {
          setSortKey(id as SortKey);
          setOpenSheet(null);
        }}
        onClose={() => setOpenSheet(null)}
      />
      <SelectorSheet
        testID="repo-issues-assignee-sheet"
        visible={openSheet === 'assignee'}
        title="Filter by assignee"
        options={assigneeOptions}
        selectedId={assignee}
        optionTestIdPrefix="repo-issues-assignee-option"
        onSelect={(id) => {
          setAssignee(id);
          setOpenSheet(null);
        }}
        onClose={() => setOpenSheet(null)}
      />
      <LabelFilterSheet
        visible={openSheet === 'label'}
        labels={labels}
        selected={selectedLabels}
        onToggle={(name) =>
          setSelectedLabels((prev) =>
            prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]
          )
        }
        onClose={() => setOpenSheet(null)}
      />
    </View>
  );
}

function IssueRow({ issue, onPress }: { issue: Issue; onPress: () => void }) {
  const { theme } = useAppTheme();
  const labels = issue.labels ?? [];
  const assignees = issue.assignees ?? [];
  return (
    <RowCard testID={`repo-issue-open-${issue.number}`} onPress={onPress}>
      <View style={styles.rowMain}>
        <View style={styles.rowTop}>
          <Text style={[styles.rowTitle, { color: theme.colors.text }]} numberOfLines={2}>
            #{issue.number} {issue.title}
          </Text>
          {assignees.length > 0 ? (
            <View style={styles.rowAssignees} testID={`repo-issue-row-assignees-${issue.number}`}>
              {assignees.slice(0, 3).map((a) => (
                <AssigneeAvatar key={a.login} user={a} issueNumber={issue.number} />
              ))}
            </View>
          ) : null}
        </View>
        <Text style={[styles.rowMeta, { color: theme.colors.textSecondary }]} numberOfLines={1}>
          {issue.state} · {issue.comments} comment{issue.comments === 1 ? '' : 's'}
        </Text>
        {labels.length > 0 ? (
          <View style={styles.rowLabels}>
            {labels.slice(0, 4).map((l) => (
              <View
                key={l.name}
                testID={`repo-issue-label-${issue.number}-${l.name}`}
                style={[styles.labelPill, { backgroundColor: theme.colors.surfaceHover }]}
              >
                <View style={[styles.labelDot, { backgroundColor: labelColor(l.color) }]} />
                <Text
                  style={[styles.labelPillText, { color: theme.colors.textSecondary }]}
                  numberOfLines={1}
                >
                  {l.name}
                </Text>
              </View>
            ))}
            {labels.length > 4 ? (
              <Text style={[styles.labelMore, { color: theme.colors.textTertiary }]}>
                +{labels.length - 4}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </RowCard>
  );
}

function AssigneeAvatar({ user, issueNumber }: { user: GitHubUser; issueNumber: number }) {
  const { theme } = useAppTheme();
  const testID = `repo-issue-assignee-avatar-${issueNumber}-${user.login}`;
  if (user.avatar_url) {
    return (
      <Image
        testID={testID}
        source={{ uri: user.avatar_url }}
        style={[styles.avatar, { borderColor: theme.colors.border }]}
      />
    );
  }
  return (
    <View
      testID={testID}
      style={[styles.avatar, styles.avatarFallback, { backgroundColor: theme.colors.accentSoft }]}
    >
      <Text style={[styles.avatarInitial, { color: theme.colors.text }]}>
        {(user.login || '?').slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

function LabelFilterSheet({
  visible,
  labels,
  selected,
  onToggle,
  onClose,
}: {
  visible: boolean;
  labels: Label[];
  selected: string[];
  onToggle: (name: string) => void;
  onClose: () => void;
}) {
  const { theme } = useAppTheme();
  if (!visible) return null;
  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={onClose}
      testID="repo-issues-label-sheet"
    >
      <Pressable
        style={styles.sheetBackdrop}
        onPress={onClose}
        testID="repo-issues-label-sheet-backdrop"
      />
      <View style={[styles.sheet, { backgroundColor: theme.colors.backgroundElevated }]}>
        <Text style={[styles.sheetTitle, { color: theme.colors.text }]}>Filter by label</Text>
        {labels.length === 0 ? (
          <Text
            testID="repo-issues-label-empty"
            style={[styles.sheetEmpty, { color: theme.colors.textSecondary }]}
          >
            No labels
          </Text>
        ) : (
          <ScrollView>
            {labels.map((l) => {
              const isSel = selected.includes(l.name);
              return (
                <Pressable
                  key={l.name}
                  testID={`repo-issues-label-option-${l.name}`}
                  style={[styles.sheetOption, isSel && { backgroundColor: theme.colors.hover }]}
                  onPress={() => onToggle(l.name)}
                >
                  <View style={styles.labelOptionMain}>
                    <View style={[styles.labelDot, { backgroundColor: labelColor(l.color) }]} />
                    <Text
                      style={[
                        styles.sheetOptionText,
                        { color: theme.colors.text, fontWeight: isSel ? '600' : '400' },
                      ]}
                    >
                      {l.name}
                    </Text>
                  </View>
                  {isSel ? (
                    <Text style={[styles.sheetOptionCheck, { color: theme.colors.primary }]}>
                      ✓
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        )}
        <Pressable
          testID="repo-issues-label-done"
          style={[styles.sheetDone, { backgroundColor: theme.colors.primary }]}
          onPress={onClose}
        >
          <Text style={[styles.sheetDoneText, { color: theme.colors.textInverse }]}>Done</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

function IssueDetail({
  owner,
  repo,
  number,
  onBack,
}: {
  owner: string;
  repo: string;
  number: number;
  onBack: () => void;
}) {
  const { theme } = useAppTheme();
  const vm = useRepoIssue(owner, repo, number);
  const [commentText, setCommentText] = useState('');
  const [assigneeText, setAssigneeText] = useState('');

  return (
    <ScrollView contentContainerStyle={styles.detailScroll} testID="repo-issue-detail">
      <Pressable testID="repo-issue-detail-back" onPress={onBack} hitSlop={8} style={styles.back}>
        <Text style={[styles.backText, { color: theme.colors.primary }]}>‹ Issues</Text>
      </Pressable>

      {vm.isLoading ? (
        <ActivityIndicator
          testID="repo-issue-detail-loading"
          style={styles.center}
          color={theme.colors.primary}
        />
      ) : vm.isError || !vm.issue ? (
        <View style={styles.center} testID="repo-issue-detail-error">
          <Text style={[styles.errorText, { color: theme.colors.error }]}>
            Couldn’t load this issue
          </Text>
        </View>
      ) : (
        <>
          <Text
            style={[styles.detailTitle, { color: theme.colors.text }]}
            testID="repo-issue-detail-title"
          >
            #{vm.issue.number} {vm.issue.title}
          </Text>
          {vm.issue.body ? (
            <Text style={[styles.detailBody, { color: theme.colors.textSecondary }]}>
              {vm.issue.body}
            </Text>
          ) : null}

          {/* Assignees */}
          <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>
            Assignees
          </Text>
          <View style={styles.assigneeRow}>
            {vm.assignees.length === 0 ? (
              <Text
                style={[styles.emptyInline, { color: theme.colors.textSecondary }]}
                testID="repo-issue-assignees-empty"
              >
                No assignees
              </Text>
            ) : (
              vm.assignees.map((a: GitHubUser) => (
                <View
                  key={a.login}
                  style={[styles.chip, { backgroundColor: theme.colors.accentSoft }]}
                  testID={`repo-issue-assignee-${a.login}`}
                >
                  <Text style={[styles.chipText, { color: theme.colors.text }]}>{a.login}</Text>
                  <Pressable
                    testID={`repo-issue-assignee-remove-${a.login}`}
                    onPress={() => vm.removeAssignee(a.login)}
                    hitSlop={6}
                  >
                    <Text style={[styles.chipRemove, { color: theme.colors.text }]}>✕</Text>
                  </Pressable>
                </View>
              ))
            )}
          </View>
          <View style={styles.inlineForm}>
            <TextInput
              testID="repo-issue-assignee-input"
              style={[
                styles.input,
                {
                  borderColor: theme.colors.border,
                  color: theme.colors.text,
                  backgroundColor: theme.colors.surface,
                },
              ]}
              placeholder="Add assignee (username)"
              placeholderTextColor={theme.colors.textTertiary}
              autoCapitalize="none"
              value={assigneeText}
              onChangeText={setAssigneeText}
            />
            <Pressable
              testID="repo-issue-assignee-add"
              style={[styles.smallBtn, { backgroundColor: theme.colors.primary }]}
              disabled={vm.isMutatingAssignees}
              onPress={() => {
                vm.addAssignee(assigneeText);
                setAssigneeText('');
              }}
            >
              <Text style={[styles.smallBtnText, { color: theme.colors.textInverse }]}>Assign</Text>
            </Pressable>
          </View>

          {/* Comments */}
          <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>
            Comments
            <Text testID="repo-issue-comments-count" style={styles.hidden}>
              {vm.comments.length}
            </Text>
          </Text>
          {vm.comments.length === 0 ? (
            <Text
              style={[styles.emptyInline, { color: theme.colors.textSecondary }]}
              testID="repo-issue-comments-empty"
            >
              No comments yet
            </Text>
          ) : (
            vm.comments.map((c: IssueComment) => (
              <View
                key={c.id}
                style={[styles.comment, { borderBottomColor: theme.colors.borderLight }]}
                testID={`repo-issue-comment-${c.id}`}
              >
                <Text style={[styles.commentAuthor, { color: theme.colors.text }]}>
                  {c.user?.login ?? 'unknown'}
                </Text>
                <Text style={[styles.commentBody, { color: theme.colors.textSecondary }]}>
                  {c.body}
                </Text>
              </View>
            ))
          )}

          <View style={styles.inlineForm}>
            <TextInput
              testID="repo-issue-comment-input"
              style={[
                styles.input,
                styles.commentInput,
                {
                  borderColor: theme.colors.border,
                  color: theme.colors.text,
                  backgroundColor: theme.colors.surface,
                },
              ]}
              placeholder="Leave a comment"
              placeholderTextColor={theme.colors.textTertiary}
              multiline
              value={commentText}
              onChangeText={setCommentText}
            />
          </View>
          <Pressable
            testID="repo-issue-comment-submit"
            style={[styles.submitBtn, { backgroundColor: theme.colors.primary }]}
            disabled={vm.isAddingComment || !commentText.trim()}
            onPress={() => {
              vm.addComment(commentText);
              setCommentText('');
            }}
          >
            <Text style={[styles.submitText, { color: theme.colors.textInverse }]}>
              {vm.isAddingComment ? 'Posting…' : 'Comment'}
            </Text>
          </Pressable>
        </>
      )}
    </ScrollView>
  );
}

function FilterChip({
  label,
  testID,
  active,
  onPress,
}: {
  label: string;
  testID: string;
  active: boolean;
  onPress: () => void;
}) {
  const { theme } = useAppTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={[
        styles.chipBtn,
        {
          backgroundColor: active ? theme.colors.primary : theme.colors.surface,
          borderColor: active ? theme.colors.primary : theme.colors.border,
        },
      ]}
    >
      <Text
        style={[
          styles.chipBtnText,
          { color: active ? theme.colors.textInverse : theme.colors.textSecondary },
          active && styles.chipBtnTextActive,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function DropdownButton({
  label,
  testID,
  active,
  onPress,
}: {
  label: string;
  testID: string;
  active: boolean;
  onPress: () => void;
}) {
  const { theme } = useAppTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={[
        styles.chipBtn,
        {
          backgroundColor: theme.colors.surface,
          borderColor: active ? theme.colors.primary : theme.colors.border,
        },
      ]}
    >
      <Text
        style={[
          styles.chipBtnText,
          { color: active ? theme.colors.primary : theme.colors.textSecondary },
        ]}
        numberOfLines={1}
      >
        {label} ▾
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hidden: { height: 0, opacity: 0 },
  searchRow: { flexDirection: 'row', gap: 8, alignItems: 'center', paddingBottom: 8 },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  searchIcon: { fontSize: 13 },
  searchInput: { flex: 1, paddingVertical: 8, fontSize: 14 },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 8 },
  chipBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipBtnText: { fontSize: 13 },
  chipBtnTextActive: { fontWeight: '600' },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 8 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    maxWidth: 220,
  },
  pillText: { fontSize: 12, fontWeight: '500', flexShrink: 1 },
  pillRemove: { fontSize: 12, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 24 },
  errorText: { fontSize: 15, fontWeight: '600' },
  emptyText: { paddingVertical: 24, textAlign: 'center' },
  emptyInline: { paddingVertical: 4 },
  rowMain: { gap: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  rowTitle: { flex: 1, fontSize: 15, fontWeight: '600' },
  rowMeta: { fontSize: 12 },
  rowAssignees: { flexDirection: 'row', gap: -6 },
  avatar: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarInitial: { fontSize: 11, fontWeight: '700' },
  rowLabels: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 2 },
  labelPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    maxWidth: 160,
  },
  labelDot: { width: 8, height: 8, borderRadius: 4 },
  labelPillText: { fontSize: 11, flexShrink: 1 },
  labelMore: { fontSize: 11, fontWeight: '600' },
  loadMore: { padding: 16, alignItems: 'center' },
  loadMoreText: { fontWeight: '600' },
  detailScroll: { paddingBottom: 48, gap: 8 },
  back: { paddingVertical: 6 },
  backText: { fontSize: 15, fontWeight: '600' },
  detailTitle: { fontSize: 18, fontWeight: '700' },
  detailBody: { fontSize: 14, marginTop: 4 },
  sectionLabel: { fontSize: 13, fontWeight: '700', marginTop: 16 },
  assigneeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
  },
  chipText: { fontWeight: '600', fontSize: 13 },
  chipRemove: { fontWeight: '700' },
  inlineForm: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 8 },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  commentInput: { minHeight: 60, textAlignVertical: 'top' },
  smallBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  smallBtnText: { fontWeight: '600', fontSize: 13 },
  comment: {
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  commentAuthor: { fontWeight: '700', fontSize: 13 },
  commentBody: { fontSize: 14 },
  submitBtn: {
    marginTop: 8,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  submitText: { fontWeight: '700' },
  // Label multi-select sheet (mirrors the SelectorSheet chrome).
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    gap: 8,
    maxHeight: '60%',
  },
  sheetTitle: { fontSize: 18, fontWeight: '700', marginBottom: 4 },
  sheetEmpty: { paddingVertical: 12 },
  sheetOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 12,
  },
  labelOptionMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  sheetOptionText: { fontSize: 16, flexShrink: 1 },
  sheetOptionCheck: { fontSize: 16, fontWeight: '700' },
  sheetDone: {
    marginTop: 4,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  sheetDoneText: { fontWeight: '700' },
});
