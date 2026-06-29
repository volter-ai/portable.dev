/**
 * ActionsTab — the RepoPage Actions tab.
 *
 * A list view (paginated workflow-run rows) and an in-tab detail view
 * (run status/timing + per-job logs as step breakdowns). Detail navigation is
 * local component state — there is no nested route yet, matching the screen's
 * existing in-shell tab model.
 *
 * Thin view over {@link useRepoActions} (list) and {@link useWorkflowRun}
 * (detail + jobs/steps).
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

import type { WorkflowRun } from '@vgit2/shared/types';

import { useAppTheme } from '../../theme';
import { RowCard } from './RowCard';
import { useRepoActions } from './useRepoActions';
import { useWorkflowRun, type WorkflowJob, type WorkflowStep } from './useWorkflowRun';

export interface ActionsTabProps {
  owner: string;
  repo: string;
}

export function ActionsTab({ owner, repo }: ActionsTabProps) {
  const [selected, setSelected] = useState<number | null>(null);

  if (selected != null) {
    return (
      <WorkflowRunDetail
        owner={owner}
        repo={repo}
        runId={selected}
        onBack={() => setSelected(null)}
      />
    );
  }
  return <RunsList owner={owner} repo={repo} onOpen={setSelected} />;
}

function RunsList({
  owner,
  repo,
  onOpen,
}: {
  owner: string;
  repo: string;
  onOpen: (id: number) => void;
}) {
  const { theme } = useAppTheme();
  const dir = useRepoActions(owner, repo);

  return (
    <View style={styles.fill}>
      {/* Virtualization-proof list length. */}
      <Text style={styles.hidden} testID="repo-actions-count">
        {dir.runs.length}
      </Text>

      {dir.isLoading ? (
        <ActivityIndicator
          testID="repo-actions-loading"
          style={styles.center}
          color={theme.colors.primary}
        />
      ) : dir.isError ? (
        <View style={styles.center} testID="repo-actions-error">
          <Text style={[styles.errorText, { color: theme.colors.error }]}>
            Couldn’t load workflow runs
          </Text>
        </View>
      ) : (
        <FlatList
          testID="repo-actions-list"
          data={dir.runs}
          keyExtractor={(r) => String(r.id)}
          renderItem={({ item }) => <RunRow run={item} onPress={() => onOpen(item.id)} />}
          ListEmptyComponent={
            <Text
              style={[styles.emptyText, { color: theme.colors.textSecondary }]}
              testID="repo-actions-empty"
            >
              No workflow runs
            </Text>
          }
          ListFooterComponent={
            dir.hasMore ? (
              <Pressable
                testID="repo-actions-load-more"
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
      )}
    </View>
  );
}

function RunRow({ run, onPress }: { run: WorkflowRun; onPress: () => void }) {
  const { theme } = useAppTheme();
  return (
    <RowCard testID={`repo-action-open-${run.id}`} onPress={onPress}>
      <View style={styles.rowMain}>
        <Text style={[styles.rowTitle, { color: theme.colors.text }]} numberOfLines={2}>
          {statusGlyph(run.status, run.conclusion)} {run.display_title || run.name}
        </Text>
        <Text style={[styles.rowMeta, { color: theme.colors.textSecondary }]} numberOfLines={1}>
          #{run.run_number} · {run.head_branch} · {run.event}
        </Text>
      </View>
    </RowCard>
  );
}

function WorkflowRunDetail({
  owner,
  repo,
  runId,
  onBack,
}: {
  owner: string;
  repo: string;
  runId: number;
  onBack: () => void;
}) {
  const { theme } = useAppTheme();
  const vm = useWorkflowRun(owner, repo, runId);

  return (
    <ScrollView contentContainerStyle={styles.detailScroll} testID="repo-action-detail">
      <Pressable testID="repo-action-detail-back" onPress={onBack} hitSlop={8} style={styles.back}>
        <Text style={[styles.backText, { color: theme.colors.link }]}>‹ Actions</Text>
      </Pressable>

      {vm.isLoading ? (
        <ActivityIndicator
          testID="repo-action-detail-loading"
          style={styles.center}
          color={theme.colors.primary}
        />
      ) : vm.isError || !vm.run ? (
        <View style={styles.center} testID="repo-action-detail-error">
          <Text style={[styles.errorText, { color: theme.colors.error }]}>
            Couldn’t load this workflow run
          </Text>
        </View>
      ) : (
        <>
          <Text
            style={[styles.detailTitle, { color: theme.colors.text }]}
            testID="repo-action-detail-title"
          >
            {vm.run.display_title || vm.run.name}
          </Text>

          {/* Status + timing. */}
          <View style={styles.metaBlock}>
            <Text
              style={[styles.metaLine, { color: theme.colors.textSecondary }]}
              testID="repo-action-detail-status"
            >
              {statusGlyph(vm.run.status, vm.run.conclusion)} {vm.run.status}
              {vm.run.conclusion ? ` · ${vm.run.conclusion}` : ''}
            </Text>
            <Text style={[styles.metaLine, { color: theme.colors.textSecondary }]}>
              #{vm.run.run_number} · {vm.run.head_branch} · {vm.run.event}
            </Text>
            <Text
              style={[styles.metaLine, { color: theme.colors.textSecondary }]}
              testID="repo-action-detail-timing"
            >
              Started {formatTime(vm.run.created_at)} · Updated {formatTime(vm.run.updated_at)}
            </Text>
          </View>

          {/* Jobs + step logs. */}
          <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>
            Jobs
            <Text testID="repo-action-jobs-count" style={styles.hidden}>
              {vm.jobs.length}
            </Text>
          </Text>
          {vm.jobs.length === 0 ? (
            <Text
              style={[styles.emptyInline, { color: theme.colors.textSecondary }]}
              testID="repo-action-jobs-empty"
            >
              No jobs for this run
            </Text>
          ) : (
            vm.jobs.map((job: WorkflowJob) => <JobCard key={job.id} job={job} />)
          )}
        </>
      )}
    </ScrollView>
  );
}

function JobCard({ job }: { job: WorkflowJob }) {
  const { theme } = useAppTheme();
  return (
    <View
      style={[
        styles.jobCard,
        { backgroundColor: theme.colors.backgroundElevated, borderColor: theme.colors.border },
      ]}
      testID={`repo-action-job-${job.id}`}
    >
      <Text style={[styles.jobName, { color: theme.colors.text }]}>
        {statusGlyph(job.status, job.conclusion)} {job.name}
      </Text>
      <Text
        style={[styles.jobMeta, { color: theme.colors.textSecondary }]}
        testID={`repo-action-job-timing-${job.id}`}
      >
        {job.status}
        {job.conclusion ? ` · ${job.conclusion}` : ''} ·{' '}
        {job.started_at ? formatTime(job.started_at) : '—'}
        {job.completed_at ? ` → ${formatTime(job.completed_at)}` : ''}
      </Text>
      {(job.steps ?? []).map((step: WorkflowStep) => (
        <View
          key={step.number}
          style={styles.stepRow}
          testID={`repo-action-step-${job.id}-${step.number}`}
        >
          <Text style={[styles.stepName, { color: theme.colors.textSecondary }]} numberOfLines={2}>
            {statusGlyph(step.status, step.conclusion)} {step.name}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** A compact text glyph for run/job/step status (FontAwesome is not bundled). */
function statusGlyph(status: string, conclusion: string | null): string {
  if (status === 'completed') {
    if (conclusion === 'success') return '✓';
    if (conclusion === 'failure' || conclusion === 'timed_out') return '✗';
    if (conclusion === 'cancelled' || conclusion === 'skipped') return '∅';
    return '•';
  }
  if (status === 'in_progress') return '◐';
  if (status === 'queued') return '◷';
  return '•';
}

/** Format an ISO timestamp to a short, locale-stable label. */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hidden: { height: 0, opacity: 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 24 },
  errorText: { fontSize: 15, fontWeight: '600' },
  emptyText: { paddingVertical: 24, textAlign: 'center' },
  emptyInline: { paddingVertical: 4 },
  rowMain: { gap: 2 },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowMeta: { fontSize: 12 },
  loadMore: { padding: 16, alignItems: 'center' },
  loadMoreText: { fontWeight: '600' },
  detailScroll: { paddingBottom: 48, gap: 8 },
  back: { paddingVertical: 6 },
  backText: { fontSize: 15, fontWeight: '600' },
  detailTitle: { fontSize: 18, fontWeight: '700' },
  metaBlock: { gap: 2, marginTop: 4 },
  metaLine: { fontSize: 13 },
  sectionLabel: { fontSize: 13, fontWeight: '700', marginTop: 16 },
  jobCard: {
    marginTop: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  jobName: { fontSize: 15, fontWeight: '600' },
  jobMeta: { fontSize: 12 },
  stepRow: { paddingVertical: 3, paddingLeft: 8 },
  stepName: { fontSize: 13 },
});
