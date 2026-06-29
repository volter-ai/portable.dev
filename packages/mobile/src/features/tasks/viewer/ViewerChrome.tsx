/**
 * Shared chrome for the issue/PR viewers:
 *
 *   - {@link ViewerHeader}: "Issue #N · owner/repo" + ✕ (the ONLY close
 *     affordance), repo link → repo page.
 *   - {@link StateBadge}: the white-on-color state pill.
 *   - {@link ViewerLabelPill}: GitHub-colored label pill (luminance contrast).
 *   - {@link AuthorCard}: the surface card with the 24px-avatar author header
 *     used by the issue body and every comment (markdown body).
 *   - {@link ViewerTimeline}: the full chronological event list — comment and
 *     review cards plus inline rows for closed/reopened/merged/labeled/
 *     assigned/milestoned/renamed/referenced/committed/review_requested/
 *     cross-referenced events (cross-references swap to the other viewer).
 *
 * FontAwesome is web-only — event icons are text/emoji glyphs + the native
 * line-icon set (the chat-block precedent).
 */

import { type ReactNode } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, useAppTheme } from '../../../theme';
// Direct FILE import (not the chat barrel) — the established MarkdownText pattern.
import { MarkdownText } from '../../chat/blocks/MarkdownText';
import type { IssueTimelineEntry } from '../../repo/useRepoIssue';
import { getContrastColor } from '../taskHelpers';

import { formatRelativeTime } from './relativeTime';
import type { ViewerTarget } from './viewerTypes';

// ── Header ───────────────────────────────────────────────────────────────────

export function ViewerHeader({
  label,
  repoFullName,
  onRepoPress,
  onClose,
  testIDPrefix,
}: {
  label: string;
  repoFullName: string;
  onRepoPress: () => void;
  onClose: () => void;
  testIDPrefix: string;
}) {
  const { theme } = useAppTheme();
  return (
    <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
      <View style={styles.headerTitleRow}>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>{label}</Text>
        <Text style={[styles.headerDot, { color: theme.colors.textTertiary }]}>·</Text>
        <Pressable testID={`${testIDPrefix}-repo-link`} onPress={onRepoPress} style={styles.shrink}>
          <Text
            style={[styles.headerRepo, { color: theme.colors.textSecondary }]}
            numberOfLines={1}
          >
            {repoFullName}
          </Text>
        </Pressable>
      </View>
      <Pressable
        testID={`${testIDPrefix}-dismiss`}
        onPress={onClose}
        style={styles.closeButton}
        accessibilityLabel="Close"
      >
        <Icon name="xmark" size={18} color={theme.colors.textSecondary} strokeWidth={2} />
      </Pressable>
    </View>
  );
}

// ── Small pieces ─────────────────────────────────────────────────────────────

export function StateBadge({
  label,
  color,
  testID,
}: {
  label: string;
  color: string;
  testID?: string;
}) {
  return (
    <Text testID={testID} style={[styles.stateBadge, { backgroundColor: color }]}>
      {label}
    </Text>
  );
}

export function ViewerLabelPill({ name, color }: { name: string; color?: string }) {
  const { theme } = useAppTheme();
  return (
    <Text
      style={[
        styles.labelPill,
        {
          backgroundColor: color ? `#${color}` : theme.colors.hover,
          color: getContrastColor(color),
        },
      ]}
    >
      {name}
    </Text>
  );
}

export function AvatarCircle({ url, size }: { url?: string; size: number }) {
  const { theme } = useAppTheme();
  if (!url) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: theme.colors.hover,
        }}
      />
    );
  }
  return (
    <Image
      source={{ uri: url }}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
      }}
    />
  );
}

/** The issue-body / comment card: author header over a markdown body. */
export function AuthorCard({
  login,
  avatarUrl,
  createdAt,
  body,
  suffix,
  testID,
}: {
  login: string;
  avatarUrl?: string;
  createdAt?: string;
  body: string;
  /** Extra muted text after the time (e.g. a review's `path:line`). */
  suffix?: string;
  testID?: string;
}) {
  const { theme } = useAppTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.card,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
    >
      <View style={[styles.cardHeader, { borderBottomColor: theme.colors.border }]}>
        <AvatarCircle url={avatarUrl} size={24} />
        <Text style={[styles.cardAuthor, { color: theme.colors.text }]}>{login}</Text>
        {createdAt ? (
          <Text style={[styles.cardTime, { color: theme.colors.textSecondary }]}>
            {formatRelativeTime(createdAt)}
            {suffix ? ` • ${suffix}` : ''}
          </Text>
        ) : null}
      </View>
      <MarkdownText content={body || '_No description provided._'} testID={`${testID}-body`} />
    </View>
  );
}

// ── Timeline ─────────────────────────────────────────────────────────────────

export interface ViewerTimelineProps {
  timeline: IssueTimelineEntry[];
  /** Open another issue/PR viewer (cross-referenced events). */
  onOpenTarget: (target: ViewerTarget) => void;
  /** Open an external url (commit links). */
  openExternal: (url: string) => void;
  /** Fallback owner/repo for cross-references missing `repository.full_name`. */
  owner: string;
  repo: string;
  testIDPrefix: string;
}

export function ViewerTimeline(props: ViewerTimelineProps) {
  const { theme } = useAppTheme();
  if (props.timeline.length === 0) {
    return (
      <Text style={[styles.timelineEmpty, { color: theme.colors.textSecondary }]}>
        No activity yet
      </Text>
    );
  }
  return (
    <View testID={`${props.testIDPrefix}-timeline`}>
      {props.timeline.map((event, index) => (
        <TimelineEvent
          key={event.node_id ?? `${event.event}-${event.id ?? index}-${index}`}
          event={event}
          {...props}
        />
      ))}
    </View>
  );
}

function TimelineEvent({
  event,
  onOpenTarget,
  openExternal,
  owner,
  repo,
  testIDPrefix,
}: ViewerTimelineProps & { event: IssueTimelineEntry }) {
  const { theme } = useAppTheme();
  const actor = event.actor ?? event.user ?? null;
  const time = event.created_at ? formatRelativeTime(event.created_at) : '';
  const muted = theme.colors.textSecondary;

  const Strong = ({ children }: { children: ReactNode }) => (
    <Text style={{ color: theme.colors.text, fontWeight: '500' }}>{children}</Text>
  );

  const row = (glyph: ReactNode, sentence: ReactNode, testID?: string) => (
    <View style={styles.eventRow} testID={testID}>
      <View style={styles.eventGlyph}>{glyph}</View>
      {actor ? <AvatarCircle url={actor.avatar_url} size={16} /> : null}
      <Text style={[styles.eventText, { color: muted }]}>
        {sentence}
        {time ? <Text style={{ color: muted }}> {time}</Text> : null}
      </Text>
    </View>
  );

  const dot = (color: string, char = '●') => <Text style={{ color, fontSize: 10 }}>{char}</Text>;

  switch (event.event) {
    case 'commented':
      return (
        <AuthorCard
          login={event.user?.login ?? 'unknown'}
          avatarUrl={event.user?.avatar_url}
          createdAt={event.created_at}
          body={event.body ?? ''}
          testID={`${testIDPrefix}-comment-${event.id ?? 'x'}`}
        />
      );
    case 'reviewed':
      if (event.body) {
        return (
          <AuthorCard
            login={event.user?.login ?? 'unknown'}
            avatarUrl={event.user?.avatar_url}
            createdAt={event.created_at}
            body={event.body}
            suffix={event.path && event.line ? `${event.path}:${event.line}` : undefined}
            testID={`${testIDPrefix}-review-${event.id ?? 'x'}`}
          />
        );
      }
      return row(
        dot(muted, '•'),
        <>
          <Strong>{actor?.login ?? 'Someone'}</Strong> reviewed this
        </>
      );
    case 'closed':
      return row(
        dot(theme.colors.danger),
        <>
          <Strong>{actor?.login ?? 'Someone'}</Strong> closed this
        </>,
        `${testIDPrefix}-event-closed`
      );
    case 'reopened':
      return row(
        dot(theme.colors.success, '◉'),
        <>
          <Strong>{actor?.login ?? 'Someone'}</Strong> reopened this
        </>,
        `${testIDPrefix}-event-reopened`
      );
    case 'merged':
      return row(
        <Icon name="code-branch" size={12} color={theme.colors.primary} strokeWidth={2} />,
        <>
          <Strong>{actor?.login ?? 'Someone'}</Strong> merged this
        </>,
        `${testIDPrefix}-event-merged`
      );
    case 'labeled':
    case 'unlabeled':
      return row(
        <Text style={styles.glyphText}>🏷</Text>,
        <>
          <Strong>{actor?.login ?? 'Someone'}</Strong>{' '}
          {event.event === 'labeled' ? 'added' : 'removed'} the{' '}
          <ViewerLabelPill name={event.label?.name ?? ''} color={event.label?.color} /> label
        </>,
        `${testIDPrefix}-event-${event.event}`
      );
    case 'assigned':
    case 'unassigned':
      return row(
        <Icon name="user" size={12} color={muted} strokeWidth={2} />,
        event.event === 'assigned' ? (
          <>
            <Strong>{actor?.login ?? 'Someone'}</Strong> assigned{' '}
            <Strong>{event.assignee?.login ?? 'someone'}</Strong>
          </>
        ) : (
          <>
            <Strong>{actor?.login ?? 'Someone'}</Strong> unassigned from{' '}
            <Strong>{event.assignee?.login ?? 'someone'}</Strong>
          </>
        )
      );
    case 'milestoned':
    case 'demilestoned':
      return row(
        <Text style={styles.glyphText}>⚑</Text>,
        <>
          <Strong>{actor?.login ?? 'Someone'}</Strong>{' '}
          {event.event === 'milestoned' ? 'added this to' : 'removed this from'} the{' '}
          <Strong>{event.milestone?.title ?? ''}</Strong> milestone
        </>
      );
    case 'renamed':
      return row(
        <Text style={styles.glyphText}>✎</Text>,
        <>
          <Strong>{actor?.login ?? 'Someone'}</Strong> changed the title from{' '}
          <Text style={{ textDecorationLine: 'line-through', color: theme.colors.textTertiary }}>
            {event.rename?.from ?? ''}
          </Text>{' '}
          to <Strong>{event.rename?.to ?? ''}</Strong>
        </>
      );
    case 'referenced': {
      if (!event.commit_id) return null;
      const sha = event.commit_id.slice(0, 7);
      return row(
        <Icon name="code-branch" size={12} color={muted} strokeWidth={2} />,
        <>
          <Strong>{actor?.login ?? 'Someone'}</Strong> referenced this in commit{' '}
          <Text
            testID={`${testIDPrefix}-commit-${sha}`}
            onPress={event.commit_url ? () => openExternal(event.commit_url as string) : undefined}
            style={[
              styles.commitSha,
              { backgroundColor: theme.colors.surface, color: theme.colors.text },
            ]}
          >
            {sha}
          </Text>
        </>
      );
    }
    case 'committed': {
      const sha = (event.sha ?? event.commit_id ?? '').slice(0, 7);
      const name = event.author?.name ?? event.committer?.name ?? actor?.login ?? 'Unknown';
      const firstLine = (event.message ?? '').split('\n')[0];
      const message = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
      return (
        <View style={styles.eventRow}>
          <View style={styles.eventGlyph}>
            <Icon name="code-branch" size={12} color={muted} strokeWidth={2} />
          </View>
          <View style={styles.shrink}>
            <Text style={[styles.eventText, { color: muted }]}>
              <Strong>{name}</Strong> committed{' '}
              <Text
                style={[
                  styles.commitSha,
                  { backgroundColor: theme.colors.surface, color: theme.colors.text },
                ]}
              >
                {sha}
              </Text>{' '}
              {event.author?.date ? formatRelativeTime(event.author.date) : time}
            </Text>
            {message ? (
              <Text style={[styles.commitMessage, { color: theme.colors.textTertiary }]}>
                {message}
              </Text>
            ) : null}
          </View>
        </View>
      );
    }
    case 'review_requested':
      return row(
        <Icon name="comments" size={12} color={muted} strokeWidth={2} />,
        <>
          <Strong>{event.review_requester?.login ?? actor?.login ?? 'Someone'}</Strong> requested a
          review from <Strong>{event.requested_reviewer?.login ?? 'someone'}</Strong>
        </>
      );
    case 'cross-referenced': {
      const source = event.source?.issue;
      if (!source?.number) return null;
      const isPr = !!source.pull_request;
      const fullName = source.repository?.full_name ?? `${owner}/${repo}`;
      const [srcOwner, srcRepo] = fullName.split('/');
      const status = source.merged_at ? 'merged' : (source.state ?? 'open');
      const statusColor = status === 'closed' ? theme.colors.danger : theme.colors.success;
      return row(
        isPr ? (
          <Icon name="code-branch" size={12} color={theme.colors.primary} strokeWidth={2} />
        ) : (
          <Text style={styles.glyphText}>🔗</Text>
        ),
        <>
          <Strong>{actor?.login ?? 'Someone'}</Strong> mentioned this in{' '}
          <Text
            testID={`${testIDPrefix}-xref-${source.number}`}
            onPress={
              srcOwner && srcRepo
                ? () =>
                    onOpenTarget({
                      kind: isPr ? 'pull' : 'issue',
                      owner: srcOwner,
                      repo: srcRepo,
                      number: source.number as number,
                    })
                : undefined
            }
            style={{
              color: theme.colors.primary,
              fontWeight: '500',
              textDecorationLine: 'underline',
            }}
          >
            {isPr ? 'PR' : 'issue'} #{source.number}
          </Text>{' '}
          <Text style={{ fontStyle: 'italic', color: theme.colors.textTertiary }}>
            "{source.title ?? ''}"
          </Text>{' '}
          <Text style={{ color: statusColor, fontWeight: '500', fontSize: 11 }}>({status})</Text>
        </>
      );
    }
    default:
      return row(
        dot(theme.colors.textTertiary, '•'),
        <>
          {actor ? <Strong>{actor.login}</Strong> : null} {event.event ?? ''}
        </>
      );
  }
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
  },
  headerTitleRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { fontSize: 14, fontWeight: '500' },
  headerDot: { fontSize: 14 },
  headerRepo: { fontSize: 14 },
  closeButton: { padding: 4 },
  shrink: { flexShrink: 1 },

  stateBadge: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 16,
    overflow: 'hidden',
    textTransform: 'capitalize',
  },
  labelPill: {
    fontSize: 11,
    fontWeight: '500',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 16,
    overflow: 'hidden',
  },

  card: { borderWidth: 1, borderRadius: 6, padding: 12, marginBottom: 12 },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingBottom: 12,
    borderBottomWidth: 1,
    marginBottom: 12,
  },
  cardAuthor: { fontSize: 13, fontWeight: '500' },
  cardTime: { fontSize: 11, flexShrink: 1 },

  timelineEmpty: { textAlign: 'center', fontSize: 13, paddingVertical: 16 },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 8,
    marginBottom: 4,
  },
  eventGlyph: { width: 16, alignItems: 'center', marginTop: 2 },
  glyphText: { fontSize: 11 },
  eventText: { flex: 1, fontSize: 13, lineHeight: 19 },
  commitSha: {
    fontFamily: 'monospace',
    fontSize: 12,
    paddingHorizontal: 4,
    borderRadius: 3,
    overflow: 'hidden',
    textDecorationLine: 'underline',
  },
  commitMessage: { fontSize: 12, marginTop: 2 },
});
