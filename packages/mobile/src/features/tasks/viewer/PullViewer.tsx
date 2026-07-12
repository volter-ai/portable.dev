/**
 * PullViewer — the full-screen PR detail. Top to bottom:
 *
 *   header "PR #N · owner/repo" + ✕ → title + state badge (Open=success,
 *   Merged=info via `merged_at` — the REST state is only open/closed —
 *   Closed=danger) + Draft pill → "Review with AI" / "Quick Merge" actions
 *   (open only; Quick Merge hidden for drafts; both socket-gated) → the
 *   `base ← head` branch chips → the stats row (comments / files / +adds /
 *   −dels / commits) → the 40px author block (compact `formatTimeAgo`) →
 *   the Conversation | Files (N) tabs:
 *     - Conversation: the description card (markdown) + the FULL timeline.
 *       READ-ONLY — there is no comment composer; don't invent one.
 *     - Files: per-file collapsible blocks (+N/−N), the patch rendered by the
 *       shared {@link UnifiedDiffView}, "No diff available (binary file or
 *       large file)" when `patch` is absent.
 */

import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { UnifiedDiffView } from '../../../components/UnifiedDiffView';
import { Icon, useAppTheme } from '../../../theme';
// Direct FILE import (not the chat barrel) — established pattern.
import { MarkdownText } from '../../chat/blocks/MarkdownText';
import { useRepoPull, type PullFile } from '../../repo/useRepoPull';

import { formatTimeAgo } from '../taskHelpers';

import { AvatarCircle, StateBadge, ViewerHeader, ViewerTimeline } from './ViewerChrome';
import { quickMergePrompt, quickMergeTitle, reviewPrPrompt, reviewPrTitle } from './viewerPrompts';
import type { UseViewerChat } from './useViewerChat';
import type { ViewerTarget } from './viewerTypes';

export interface PullViewerProps {
  target: ViewerTarget;
  onClose: () => void;
  onOpenTarget: (target: ViewerTarget) => void;
  onRepoPress: () => void;
  openExternal: (url: string) => void;
  chat: UseViewerChat;
}

export function PullViewer({
  target,
  onClose,
  onOpenTarget,
  onRepoPress,
  openExternal,
  chat,
}: PullViewerProps) {
  const { theme } = useAppTheme();
  const { owner, repo, number, preloaded } = target;
  const vm = useRepoPull(owner, repo, number);
  const [tab, setTab] = useState<'conversation' | 'files'>('conversation');

  // Preloaded-data fast path (normalized defaults — merged_at→null etc.).
  const pr = vm.pull ?? (preloaded ? { ...preloaded, merged_at: null } : undefined);

  if (!pr) {
    return (
      <View
        testID="pull-viewer"
        style={[styles.container, { backgroundColor: theme.colors.background }]}
      >
        <ViewerHeader
          label={`PR #${number}`}
          repoFullName={`${owner}/${repo}`}
          onRepoPress={onRepoPress}
          onClose={onClose}
          testIDPrefix="pull-viewer"
        />
        {vm.isError ? (
          <View style={styles.center} testID="pull-viewer-error">
            <Text style={{ color: theme.colors.danger, fontSize: 14 }}>
              Failed to load pull request
            </Text>
          </View>
        ) : (
          <ActivityIndicator
            testID="pull-viewer-loading"
            style={styles.center}
            color={theme.colors.primary}
          />
        )}
      </View>
    );
  }

  const full = pr as unknown as Partial<{
    state: string;
    title: string;
    body?: string | null;
    draft?: boolean;
    merged_at?: string | null;
    created_at: string;
    user?: { login: string; avatar_url?: string } | null;
    head?: { ref?: string };
    base?: { ref?: string };
    comments?: number;
    review_comments?: number;
    commits?: number;
    additions?: number;
    deletions?: number;
    changed_files?: number;
  }>;

  const isOpen = full.state === 'open';
  const statusColor = isOpen
    ? theme.colors.success
    : full.merged_at
      ? theme.colors.info
      : theme.colors.danger;
  const statusText = isOpen ? 'Open' : full.merged_at ? 'Merged' : 'Closed';
  const changedFiles = full.changed_files ?? vm.files.length;
  const headRef = full.head?.ref ?? 'unknown';
  const baseRef = full.base?.ref ?? 'unknown';

  const startChat = (kind: 'review' | 'merge') => {
    const input = { number, title: full.title ?? '', owner, repo, headRef, baseRef };
    const title = kind === 'review' ? reviewPrTitle(input) : quickMergeTitle(input);
    const prompt = kind === 'review' ? reviewPrPrompt(input) : quickMergePrompt(input);
    void chat.start({ title, prompt, owner, repo }).then((ok) => {
      if (ok) onClose();
    });
  };

  return (
    <View
      testID="pull-viewer"
      style={[styles.container, { backgroundColor: theme.colors.background }]}
    >
      <ViewerHeader
        label={`PR #${number}`}
        repoFullName={`${owner}/${repo}`}
        onRepoPress={onRepoPress}
        onClose={onClose}
        testIDPrefix="pull-viewer"
      />

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {/* Title + badges */}
        <View style={styles.titleRow}>
          <Text testID="pull-viewer-title" style={[styles.title, { color: theme.colors.text }]}>
            {full.title}
          </Text>
          <StateBadge testID="pull-viewer-state" label={statusText} color={statusColor} />
          {full.draft ? (
            <Text
              testID="pull-viewer-draft"
              style={[
                styles.draftPill,
                { backgroundColor: theme.colors.hover, color: theme.colors.textSecondary },
              ]}
            >
              Draft
            </Text>
          ) : null}
        </View>

        {/* AI actions (open PRs only; merge hidden for drafts). */}
        {isOpen ? (
          <View style={styles.actionsRow}>
            <Pressable
              testID="pull-viewer-review"
              disabled={!chat.connected || chat.busy}
              onPress={() => startChat('review')}
              style={[
                styles.actionButton,
                { backgroundColor: theme.colors.primary },
                (!chat.connected || chat.busy) && styles.disabled,
              ]}
            >
              <Text style={styles.actionText}>Review with AI</Text>
            </Pressable>
            {!full.draft ? (
              <Pressable
                testID="pull-viewer-merge"
                disabled={!chat.connected || chat.busy}
                onPress={() => startChat('merge')}
                style={[
                  styles.actionButton,
                  { backgroundColor: theme.colors.success },
                  (!chat.connected || chat.busy) && styles.disabled,
                ]}
              >
                <Text style={styles.actionText}>Quick Merge</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {/* Branch row: base ← head */}
        <View style={styles.branchRow} testID="pull-viewer-branches">
          <Icon name="code-branch" size={13} color={theme.colors.textSecondary} strokeWidth={2} />
          <Text
            style={[
              styles.branchChip,
              { backgroundColor: theme.colors.backgroundElevated, color: theme.colors.text },
            ]}
          >
            {baseRef}
          </Text>
          <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>←</Text>
          <Text
            style={[
              styles.branchChip,
              { backgroundColor: theme.colors.backgroundElevated, color: theme.colors.text },
            ]}
          >
            {headRef}
          </Text>
        </View>

        {/* Stats row */}
        <View style={styles.statsRow} testID="pull-viewer-stats">
          <Text style={[styles.stat, { color: theme.colors.textSecondary }]}>
            💬 {(full.comments ?? 0) + (full.review_comments ?? 0)} comments
          </Text>
          <Text style={[styles.stat, { color: theme.colors.textSecondary }]}>
            {changedFiles} files
          </Text>
          <Text style={[styles.stat, { color: theme.colors.success }]}>+{full.additions ?? 0}</Text>
          <Text style={[styles.stat, { color: theme.colors.danger }]}>-{full.deletions ?? 0}</Text>
          <Text style={[styles.stat, { color: theme.colors.textSecondary }]}>
            {full.commits ?? 0} commits
          </Text>
        </View>

        {/* Author block */}
        <View style={styles.authorRow}>
          <AvatarCircle url={full.user?.avatar_url} size={40} />
          <View>
            <Text style={{ color: theme.colors.text, fontWeight: '500', fontSize: 14 }}>
              {full.user?.login ?? 'unknown'}
            </Text>
            {full.created_at ? (
              <Text style={{ color: theme.colors.textTertiary, fontSize: 12 }}>
                {formatTimeAgo(full.created_at)}
              </Text>
            ) : null}
          </View>
        </View>

        {/* Tabs */}
        <View style={[styles.tabStrip, { borderBottomColor: theme.colors.border }]}>
          {(['conversation', 'files'] as const).map((key) => {
            const active = tab === key;
            return (
              <Pressable
                key={key}
                testID={`pull-viewer-tab-${key}`}
                onPress={() => setTab(key)}
                style={[
                  styles.tab,
                  active && { borderBottomColor: theme.colors.primary, borderBottomWidth: 2 },
                ]}
              >
                <Text
                  style={{
                    fontSize: 13,
                    color: active ? theme.colors.text : theme.colors.textSecondary,
                    fontWeight: active ? '500' : '400',
                  }}
                >
                  {key === 'conversation' ? 'Conversation' : `Files (${changedFiles})`}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {tab === 'conversation' ? (
          <View testID="pull-viewer-conversation">
            {full.body ? (
              <View
                style={[styles.description, { backgroundColor: theme.colors.backgroundElevated }]}
                testID="pull-viewer-description"
              >
                <MarkdownText content={full.body} testID="pull-viewer-description-markdown" />
              </View>
            ) : null}
            {vm.isLoading ? (
              <ActivityIndicator
                testID="pull-viewer-timeline-loading"
                color={theme.colors.primary}
                style={styles.timelineLoading}
              />
            ) : (
              <ViewerTimeline
                timeline={vm.timeline}
                onOpenTarget={onOpenTarget}
                openExternal={openExternal}
                owner={owner}
                repo={repo}
                testIDPrefix="pull-viewer"
              />
            )}
          </View>
        ) : (
          <View testID="pull-viewer-files">
            {vm.isLoading ? (
              <ActivityIndicator color={theme.colors.primary} style={styles.timelineLoading} />
            ) : vm.files.length === 0 ? (
              <Text style={[styles.filesEmpty, { color: theme.colors.textSecondary }]}>
                No files changed
              </Text>
            ) : (
              vm.files.map((file) => <FileBlock key={file.filename} file={file} />)
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

/** A collapsible changed-file block: header (+N/−N) over the patch lines. */
function FileBlock({ file }: { file: PullFile }) {
  const { theme } = useAppTheme();
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.fileBlock}>
      <Pressable
        testID={`pull-viewer-file-${file.filename}`}
        onPress={() => setExpanded((e) => !e)}
        style={[styles.fileHeader, { backgroundColor: theme.colors.backgroundElevated }]}
      >
        <Text style={{ color: theme.colors.textTertiary, fontSize: 10 }}>
          {expanded ? '▾' : '▸'}
        </Text>
        <Text numberOfLines={1} style={[styles.fileName, { color: theme.colors.text }]}>
          {file.filename}
        </Text>
        <Text style={{ color: theme.colors.success, fontSize: 12 }}>+{file.additions ?? 0}</Text>
        <Text style={{ color: theme.colors.danger, fontSize: 12 }}>-{file.deletions ?? 0}</Text>
      </Pressable>
      {expanded ? (
        file.patch ? (
          <UnifiedDiffView diff={file.patch} testID={`pull-viewer-patch-${file.filename}`} />
        ) : (
          <Text style={[styles.noDiff, { color: theme.colors.textSecondary }]}>
            No diff available (binary file or large file)
          </Text>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1 },
  scrollContent: { padding: 12, paddingBottom: 32 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 8,
    flexWrap: 'wrap',
  },
  title: { flex: 1, fontSize: 18, fontWeight: '600', lineHeight: 25, minWidth: '60%' },
  draftPill: {
    fontSize: 12,
    fontWeight: '500',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 16,
    overflow: 'hidden',
  },
  actionsRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  actionButton: {
    flex: 1,
    alignItems: 'center',
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  actionText: { color: '#fff', fontSize: 13, fontWeight: '500' },
  disabled: { opacity: 0.5 },
  branchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  branchChip: {
    fontFamily: 'monospace',
    fontSize: 12,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  statsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginBottom: 16 },
  stat: { fontSize: 13 },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 24 },
  tabStrip: { flexDirection: 'row', borderBottomWidth: 1, marginBottom: 16 },
  tab: { paddingVertical: 8, paddingHorizontal: 16, marginBottom: -1 },
  description: { borderRadius: 8, padding: 16, marginBottom: 24 },
  timelineLoading: { paddingVertical: 16 },
  filesEmpty: { textAlign: 'center', fontSize: 13, paddingVertical: 24 },
  fileBlock: { marginBottom: 12 },
  fileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 6,
    padding: 8,
  },
  fileName: { flex: 1, fontFamily: 'monospace', fontSize: 13 },
  noDiff: { textAlign: 'center', fontSize: 13, paddingVertical: 24 },
});
