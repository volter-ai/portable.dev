/**
 * IssueViewer — the full-screen issue detail. Top to bottom:
 *
 *   header "Issue #N · owner/repo" + ✕ → title + state badge (open=success,
 *   closed=info) → "Start issue chat" / "Quick fix" AI actions (open only,
 *   disabled while the socket is down) → meta line (author avatar · login ·
 *   opened time · N comments) → "Assigned to:" row (display only)
 *   → label pills → the body card (author header + markdown) → the FULL
 *   timeline (comment cards + every event row) → the composer ("Add a comment
 *   or close/reopen issue": comment box, split close button with a
 *   close-reason sheet, Comment submit).
 *
 * Data: `useRepoIssue` (`GET /api/repos/:o/:r/issues/:n` → issue + timeline;
 * POST comment; PATCH state). The row's preloaded `TaskIssue` renders
 * immediately while the fetch hydrates the timeline (the preloaded
 * `issueData` fast path).
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useAppTheme } from '../../../theme';
// Direct FILE import (not the chat barrel) — established pattern.
import { SelectorSheet } from '../../chat/composer/SelectorSheet';
import { useRepoIssue } from '../../repo/useRepoIssue';
import type { TaskIssue } from '../types';

import { formatRelativeTime } from './relativeTime';
import {
  AvatarCircle,
  AuthorCard,
  StateBadge,
  ViewerHeader,
  ViewerLabelPill,
  ViewerTimeline,
} from './ViewerChrome';
import { issueChatPrompt, issueChatTitle, quickFixPrompt, quickFixTitle } from './viewerPrompts';
import type { UseViewerChat } from './useViewerChat';
import type { ViewerTarget } from './viewerTypes';

const CLOSE_REASONS = [
  { id: 'completed', name: 'Close as completed' },
  { id: 'not_planned', name: 'Close as not planned' },
  { id: 'duplicate', name: 'Close as duplicate' },
];

export interface IssueViewerProps {
  target: ViewerTarget;
  onClose: () => void;
  onOpenTarget: (target: ViewerTarget) => void;
  onRepoPress: () => void;
  openExternal: (url: string) => void;
  chat: UseViewerChat;
}

export function IssueViewer({
  target,
  onClose,
  onOpenTarget,
  onRepoPress,
  openExternal,
  chat,
}: IssueViewerProps) {
  const { theme } = useAppTheme();
  const { owner, repo, number, preloaded } = target;
  const vm = useRepoIssue(owner, repo, number);
  const [commentText, setCommentText] = useState('');
  const [closeReason, setCloseReason] = useState('completed');
  const [reasonSheetOpen, setReasonSheetOpen] = useState(false);

  // Preloaded-data fast path: render the row data immediately; the fetch
  // hydrates the timeline (and fresher fields) in the background.
  const issue = vm.issue ?? preloaded;
  const promptInput = issue ? { number, title: issue.title, body: issue.body, owner, repo } : null;

  const commentCount = vm.timeline.filter((e) => e.event === 'commented').length;
  const isOpen = issue?.state === 'open';
  const hasComment = commentText.trim().length > 0;

  const submitComment = () => {
    vm.addComment(commentText);
    setCommentText('');
  };

  const setStateWithComment = async (state: 'open' | 'closed') => {
    try {
      if (hasComment) await vm.addCommentAsync(commentText);
      vm.setIssueState(state, state === 'closed' ? closeReason : 'reopened');
      setCommentText('');
    } catch {
      // Comment failed — keep the text; the error box below surfaces it.
    }
  };

  const startChat = (kind: 'discuss' | 'fix') => {
    if (!promptInput) return;
    const title = kind === 'discuss' ? issueChatTitle(promptInput) : quickFixTitle(promptInput);
    const prompt = kind === 'discuss' ? issueChatPrompt(promptInput) : quickFixPrompt(promptInput);
    void chat.start({ title, prompt, owner, repo }).then((ok) => {
      if (ok) onClose();
    });
  };

  return (
    <View
      testID="issue-viewer"
      style={[styles.container, { backgroundColor: theme.colors.background }]}
    >
      <ViewerHeader
        label={`Issue #${number}`}
        repoFullName={`${owner}/${repo}`}
        onRepoPress={onRepoPress}
        onClose={onClose}
        testIDPrefix="issue-viewer"
      />

      {!issue ? (
        vm.isError ? (
          <View style={styles.center} testID="issue-viewer-error">
            <Text style={{ color: theme.colors.danger, fontSize: 14 }}>Failed to load issue</Text>
          </View>
        ) : (
          <ActivityIndicator
            testID="issue-viewer-loading"
            style={styles.center}
            color={theme.colors.primary}
          />
        )
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {/* Title + state badge */}
          <View style={styles.titleRow}>
            <Text testID="issue-viewer-title" style={[styles.title, { color: theme.colors.text }]}>
              {issue.title}
            </Text>
            <StateBadge
              testID="issue-viewer-state"
              label={issue.state}
              color={isOpen ? theme.colors.success : theme.colors.info}
            />
          </View>

          {/* AI actions (open issues only; gated on the live socket). */}
          {isOpen ? (
            <View style={styles.actionsRow}>
              <Pressable
                testID="issue-viewer-start-chat"
                disabled={!chat.connected || chat.busy}
                onPress={() => startChat('discuss')}
                style={[
                  styles.actionButton,
                  { backgroundColor: theme.colors.primary },
                  (!chat.connected || chat.busy) && styles.disabled,
                ]}
              >
                <Text style={styles.actionText}>Start issue chat</Text>
              </Pressable>
              <Pressable
                testID="issue-viewer-quick-fix"
                disabled={!chat.connected || chat.busy}
                onPress={() => startChat('fix')}
                style={[
                  styles.actionButton,
                  { backgroundColor: theme.colors.success },
                  (!chat.connected || chat.busy) && styles.disabled,
                ]}
              >
                <Text style={styles.actionText}>Quick fix</Text>
              </Pressable>
            </View>
          ) : null}

          {/* Meta line */}
          <View style={styles.metaRow}>
            <AvatarCircle url={issue.user?.avatar_url} size={16} />
            <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
              {issue.user?.login ?? 'unknown'} opened {relativeOpened(issue)} •{' '}
              <Text testID="issue-viewer-comment-count">{commentCount}</Text> comments
            </Text>
          </View>

          {/* Assignees (display only) */}
          {(issue.assignees ?? []).length > 0 ? (
            <View style={styles.metaRow} testID="issue-viewer-assignees">
              <Text style={[styles.metaLabel, { color: theme.colors.textSecondary }]}>
                Assigned to:
              </Text>
              {(issue.assignees ?? []).map((assignee) => (
                <View key={assignee.login} style={styles.assignee}>
                  <AvatarCircle url={assignee.avatar_url} size={16} />
                  <Text style={[styles.metaText, { color: theme.colors.text }]}>
                    {assignee.login}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          {/* Labels */}
          {(issue.labels ?? []).length > 0 ? (
            <View style={styles.labelsRow} testID="issue-viewer-labels">
              {(issue.labels ?? []).map((label) => (
                <ViewerLabelPill key={label.name} name={label.name ?? ''} color={label.color} />
              ))}
            </View>
          ) : null}

          {/* Body card */}
          <AuthorCard
            login={issue.user?.login ?? 'unknown'}
            avatarUrl={issue.user?.avatar_url}
            createdAt={issue.created_at}
            body={issue.body ?? ''}
            testID="issue-viewer-body"
          />

          {/* Timeline */}
          {vm.isLoading ? (
            <ActivityIndicator
              testID="issue-viewer-timeline-loading"
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
              testIDPrefix="issue-viewer"
            />
          )}

          {/* Composer + close/reopen */}
          <View style={styles.composer}>
            <Text style={[styles.composerTitle, { color: theme.colors.text }]}>
              {isOpen ? 'Add a comment or close issue' : 'Add a comment or reopen issue'}
            </Text>
            {vm.isCommentError || vm.isStateError ? (
              <Text
                testID="issue-viewer-mutation-error"
                style={[
                  styles.errorBox,
                  { borderColor: theme.colors.danger, color: theme.colors.danger },
                ]}
              >
                {vm.isCommentError
                  ? 'Failed to post the comment.'
                  : 'Failed to update the issue state.'}
              </Text>
            ) : null}
            <TextInput
              testID="issue-viewer-comment-input"
              style={[
                styles.input,
                {
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.border,
                  color: theme.colors.text,
                },
              ]}
              placeholder="Write a comment..."
              placeholderTextColor={theme.colors.textTertiary}
              multiline
              value={commentText}
              onChangeText={setCommentText}
              editable={!vm.isAddingComment && !vm.isSettingState}
            />
            <View style={styles.composerButtons}>
              {isOpen ? (
                <View style={styles.splitButton}>
                  <Pressable
                    testID="issue-viewer-close"
                    disabled={vm.isSettingState}
                    onPress={() => void setStateWithComment('closed')}
                    style={[
                      styles.surfaceButton,
                      styles.splitMain,
                      { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
                    ]}
                  >
                    <Text style={[styles.surfaceButtonText, { color: theme.colors.text }]}>
                      {vm.isSettingState
                        ? 'Closing...'
                        : hasComment
                          ? 'Close with comment'
                          : 'Close issue'}
                    </Text>
                  </Pressable>
                  <Pressable
                    testID="issue-viewer-close-reason"
                    onPress={() => setReasonSheetOpen(true)}
                    style={[
                      styles.surfaceButton,
                      styles.splitChevron,
                      { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
                    ]}
                  >
                    <Text style={[styles.surfaceButtonText, { color: theme.colors.text }]}>▾</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  testID="issue-viewer-reopen"
                  disabled={vm.isSettingState}
                  onPress={() => void setStateWithComment('open')}
                  style={[
                    styles.surfaceButton,
                    { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
                  ]}
                >
                  <Text style={[styles.surfaceButtonText, { color: theme.colors.text }]}>
                    {vm.isSettingState
                      ? 'Reopening...'
                      : hasComment
                        ? 'Reopen with comment'
                        : 'Reopen issue'}
                  </Text>
                </Pressable>
              )}
              <Pressable
                testID="issue-viewer-comment-submit"
                disabled={!hasComment || vm.isAddingComment}
                onPress={submitComment}
                style={[
                  styles.primaryButton,
                  { backgroundColor: theme.colors.primary },
                  (!hasComment || vm.isAddingComment) && styles.disabled,
                ]}
              >
                <Text style={styles.actionText}>
                  {vm.isAddingComment ? 'Posting...' : 'Comment'}
                </Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      )}

      <SelectorSheet
        testID="issue-viewer-reason-sheet"
        visible={reasonSheetOpen}
        title="Close issue"
        options={CLOSE_REASONS}
        selectedId={closeReason}
        optionTestIdPrefix="issue-viewer-reason"
        onSelect={(id) => {
          setCloseReason(id);
          setReasonSheetOpen(false);
        }}
        onClose={() => setReasonSheetOpen(false)}
      />
    </View>
  );
}

/** The meta line uses the timeline-style relative format. */
function relativeOpened(issue: TaskIssue | { created_at?: string }): string {
  return issue.created_at ? formatRelativeTime(issue.created_at) : '';
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1 },
  scrollContent: { padding: 12, paddingBottom: 32 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 8 },
  title: { flex: 1, fontSize: 18, fontWeight: '600', lineHeight: 25 },
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
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 6,
  },
  metaText: { fontSize: 12 },
  metaLabel: { fontSize: 12, fontWeight: '500' },
  assignee: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  labelsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4, marginBottom: 12 },
  timelineLoading: { paddingVertical: 16 },
  composer: { marginTop: 24, gap: 8 },
  composerTitle: { fontSize: 14, fontWeight: '600' },
  errorBox: {
    borderWidth: 1,
    borderRadius: 6,
    padding: 12,
    fontSize: 13,
  },
  input: {
    minHeight: 100,
    borderWidth: 1,
    borderRadius: 6,
    padding: 12,
    fontSize: 13,
    textAlignVertical: 'top',
  },
  composerButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  splitButton: { flexDirection: 'row' },
  surfaceButton: {
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  surfaceButtonText: { fontSize: 13, fontWeight: '500' },
  splitMain: { borderTopRightRadius: 0, borderBottomRightRadius: 0 },
  splitChevron: {
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    borderLeftWidth: 0,
    paddingHorizontal: 10,
  },
  primaryButton: { borderRadius: 6, paddingVertical: 8, paddingHorizontal: 16 },
});
