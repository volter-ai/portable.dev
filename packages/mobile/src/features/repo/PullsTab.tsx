/**
 * PullsTab — the RepoPage Pull Requests tab.
 *
 * A list view (open/closed filter + paginated PR rows) and an in-tab read-only
 * detail view (title, body, changed files, comments). Detail navigation is local
 * component state — same in-shell model as {@link IssuesTab}. Thin view over {@link useRepoPulls} (list) and
 * {@link useRepoPull} (detail).
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { PullRequest } from '@vgit2/shared/types';

import { useAppTheme } from '../../theme';
import { RowCard } from './RowCard';
import type { IssueState } from './useRepoIssues';
import { useRepoPull, type PullFile } from './useRepoPull';
import { useRepoPulls } from './useRepoPulls';

export interface PullsTabProps {
  owner: string;
  repo: string;
}

export function PullsTab({ owner, repo }: PullsTabProps) {
  const [selected, setSelected] = useState<number | null>(null);

  if (selected != null) {
    return (
      <PullDetail owner={owner} repo={repo} number={selected} onBack={() => setSelected(null)} />
    );
  }
  return <PullsList owner={owner} repo={repo} onOpen={setSelected} />;
}

function PullsList({
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
  const dir = useRepoPulls(owner, repo, state);

  return (
    <View style={styles.fill}>
      <View style={styles.filterRow}>
        <FilterChip
          label="Open"
          testID="repo-prs-filter-open"
          active={state === 'open'}
          onPress={() => setState('open')}
        />
        <FilterChip
          label="Closed"
          testID="repo-prs-filter-closed"
          active={state === 'closed'}
          onPress={() => setState('closed')}
        />
      </View>

      <Text style={styles.hidden} testID="repo-prs-count">
        {dir.pulls.length}
      </Text>

      {dir.isLoading ? (
        <ActivityIndicator
          testID="repo-prs-loading"
          style={styles.center}
          color={theme.colors.primary}
        />
      ) : dir.isError ? (
        <View style={styles.center} testID="repo-prs-error">
          <Text style={[styles.errorText, { color: theme.colors.error }]}>
            Couldn’t load pull requests
          </Text>
        </View>
      ) : (
        <FlatList
          testID="repo-prs-list"
          data={dir.pulls}
          keyExtractor={(p) => String(p.number)}
          renderItem={({ item }) => <PullRow pull={item} onPress={() => onOpen(item.number)} />}
          ListEmptyComponent={
            <Text
              style={[styles.emptyText, { color: theme.colors.textSecondary }]}
              testID="repo-prs-empty"
            >
              No {state} pull requests
            </Text>
          }
          ListFooterComponent={
            dir.hasMore ? (
              <Pressable
                testID="repo-prs-load-more"
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
    </View>
  );
}

function PullRow({ pull, onPress }: { pull: PullRequest; onPress: () => void }) {
  const { theme } = useAppTheme();
  return (
    <RowCard testID={`repo-pr-open-${pull.number}`} onPress={onPress}>
      <View style={styles.rowMain}>
        <Text style={[styles.rowTitle, { color: theme.colors.text }]} numberOfLines={2}>
          #{pull.number} {pull.title}
        </Text>
        <Text style={[styles.rowMeta, { color: theme.colors.textSecondary }]} numberOfLines={1}>
          {pull.merged_at ? 'merged' : pull.state} · {pull.head?.ref ?? '?'} →{' '}
          {pull.base?.ref ?? '?'}
        </Text>
      </View>
    </RowCard>
  );
}

function PullDetail({
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
  const vm = useRepoPull(owner, repo, number);

  return (
    <ScrollView contentContainerStyle={styles.detailScroll} testID="repo-pr-detail">
      <Pressable testID="repo-pr-detail-back" onPress={onBack} hitSlop={8} style={styles.back}>
        <Text style={[styles.backText, { color: theme.colors.primary }]}>‹ Pull Requests</Text>
      </Pressable>

      {vm.isLoading ? (
        <ActivityIndicator
          testID="repo-pr-detail-loading"
          style={styles.center}
          color={theme.colors.primary}
        />
      ) : vm.isError || !vm.pull ? (
        <View style={styles.center} testID="repo-pr-detail-error">
          <Text style={[styles.errorText, { color: theme.colors.error }]}>
            Couldn’t load this pull request
          </Text>
        </View>
      ) : (
        <>
          <Text
            style={[styles.detailTitle, { color: theme.colors.text }]}
            testID="repo-pr-detail-title"
          >
            #{vm.pull.number} {vm.pull.title}
          </Text>
          <Text style={[styles.rowMeta, { color: theme.colors.textSecondary }]}>
            {vm.pull.head?.ref} → {vm.pull.base?.ref}
            {vm.pull.merged_at ? ' · merged' : ` · ${vm.pull.state}`}
          </Text>
          {vm.pull.body ? (
            <Text style={[styles.detailBody, { color: theme.colors.textSecondary }]}>
              {vm.pull.body}
            </Text>
          ) : null}

          <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>
            Changed files ({vm.files.length})
          </Text>
          {vm.files.length === 0 ? (
            <Text
              style={[styles.emptyInline, { color: theme.colors.textSecondary }]}
              testID="repo-pr-files-empty"
            >
              No file changes
            </Text>
          ) : (
            vm.files.map((f: PullFile) => (
              <Text
                key={f.filename}
                style={[styles.file, { color: theme.colors.text }]}
                testID={`repo-pr-file-${f.filename}`}
              >
                {f.filename}
              </Text>
            ))
          )}

          <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>Comments</Text>
          {vm.comments.length === 0 ? (
            <Text
              style={[styles.emptyInline, { color: theme.colors.textSecondary }]}
              testID="repo-pr-comments-empty"
            >
              No comments yet
            </Text>
          ) : (
            vm.comments.map((c) => (
              <View
                key={c.id}
                style={[styles.comment, { borderBottomColor: theme.colors.borderLight }]}
                testID={`repo-pr-comment-${c.id}`}
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
        { backgroundColor: active ? theme.colors.primary : theme.colors.hover },
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

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hidden: { height: 0, opacity: 0 },
  filterRow: { flexDirection: 'row', gap: 8, paddingBottom: 8 },
  chipBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
  },
  chipBtnText: { fontSize: 13 },
  chipBtnTextActive: { fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 24 },
  errorText: { fontSize: 15, fontWeight: '600' },
  emptyText: { opacity: 0.6, paddingVertical: 24, textAlign: 'center' },
  emptyInline: { opacity: 0.6, paddingVertical: 4 },
  rowMain: { gap: 2 },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowMeta: { fontSize: 12, opacity: 0.6 },
  loadMore: { padding: 16, alignItems: 'center' },
  loadMoreText: { fontWeight: '600' },
  detailScroll: { paddingBottom: 48, gap: 8 },
  back: { paddingVertical: 6 },
  backText: { fontSize: 15, fontWeight: '600' },
  detailTitle: { fontSize: 18, fontWeight: '700' },
  detailBody: { fontSize: 14, opacity: 0.85, marginTop: 4 },
  sectionLabel: { fontSize: 13, fontWeight: '700', marginTop: 16, opacity: 0.7 },
  file: { fontSize: 13, fontFamily: 'monospace', paddingVertical: 2 },
  comment: {
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  commentAuthor: { fontWeight: '700', fontSize: 13 },
  commentBody: { fontSize: 14, opacity: 0.85 },
});
