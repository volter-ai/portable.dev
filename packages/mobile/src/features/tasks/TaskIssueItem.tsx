/**
 * TaskIssueItem — one issue/PR row of the Tasks page (`showDetails=false`,
 * `showRepo=true`). A `surfaceHover` card with:
 *
 *   - title row (+ CLOSED badge for closed items),
 *   - the repo line: 14px owner avatar (`github.com/{owner}.png`), short repo
 *     name, a PR glyph when the item is a PR, the bold `#number`, `• timeAgo`,
 *     and `• 💬 n` when commented,
 *   - GitHub-colored label pills (luminance-based black/white text),
 *   - an optional related-PR chip (In Review rows for linked issues),
 *   - an optional right avatar column (PR author / issue assignee / dotted
 *     "unassigned" circle) when `showAssignee`.
 *
 * Closed styling is layered: alpha'd card bg + 0.7 card opacity +
 * tertiary text + alpha'd label colors. Deliberate v1 gaps (documented
 * in packages/mobile/CLAUDE.md): no swipe-to-close gesture and no
 * assignee/reviewer picker popover — rows open the GitHub page instead of an
 * in-app viewer modal (the established `GitHubCard` pattern).
 */

import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, useAppTheme, withAlpha } from '../../theme';

import { formatTimeAgo, getContrastColor, repoFullNameOf, type RelatedPrChip } from './taskHelpers';
import type { TaskIssue } from './types';

export interface TaskIssueItemProps {
  item: TaskIssue;
  /** Show the right avatar column (false on the `my` tab groups). */
  showAssignee: boolean;
  relatedPR?: RelatedPrChip;
  onPress: () => void;
  onRelatedPRPress?: () => void;
  testID?: string;
}

export function TaskIssueItem({
  item,
  showAssignee,
  relatedPR,
  onPress,
  onRelatedPRPress,
  testID,
}: TaskIssueItemProps) {
  const { theme } = useAppTheme();
  const closed = item.state === 'closed';
  const isPr = !!item.pull_request;
  const repoFull = repoFullNameOf(item);
  const repoShort = item.repository?.name ?? repoFull?.split('/')[1] ?? repoFull;
  const ownerLogin = item.repository?.owner?.login;
  const mutedText = closed ? withAlpha(theme.colors.textTertiary, '99') : theme.colors.textTertiary;

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={[
        styles.card,
        {
          backgroundColor: closed
            ? withAlpha(theme.colors.surfaceHover, '88')
            : theme.colors.surfaceHover,
        },
        closed && styles.cardClosed,
      ]}
    >
      <View style={styles.row}>
        <View style={styles.content}>
          <View style={styles.titleRow}>
            <Text
              numberOfLines={1}
              style={[
                styles.title,
                { color: closed ? theme.colors.textTertiary : theme.colors.text },
              ]}
            >
              {item.title}
            </Text>
            {closed ? (
              <Text
                testID={testID ? `${testID}-closed` : undefined}
                style={[styles.closedBadge, { backgroundColor: theme.colors.danger }]}
              >
                CLOSED
              </Text>
            ) : null}
          </View>

          {repoShort ? (
            <View style={styles.repoLine}>
              {ownerLogin ? (
                <Image
                  source={{ uri: `https://github.com/${ownerLogin}.png` }}
                  style={[styles.ownerAvatar, { borderColor: theme.colors.border }]}
                />
              ) : null}
              <Text style={[styles.repoText, { color: mutedText }]} numberOfLines={1}>
                {repoShort}
              </Text>
              {isPr ? (
                <Icon name="code-branch" size={10} color={theme.colors.success} strokeWidth={2} />
              ) : null}
              <Text
                style={[
                  styles.number,
                  { color: closed ? theme.colors.textTertiary : theme.colors.text },
                ]}
              >
                #{item.number}
              </Text>
              <Text style={[styles.repoText, { color: mutedText }]}>•</Text>
              <Text style={[styles.repoText, { color: mutedText }]}>
                {formatTimeAgo(item.updated_at)}
              </Text>
              {(item.comments ?? 0) > 0 ? (
                <>
                  <Text style={[styles.repoText, { color: mutedText }]}>•</Text>
                  <Text style={[styles.repoText, { color: mutedText }]}>💬 {item.comments}</Text>
                </>
              ) : null}
            </View>
          ) : null}

          {(item.labels ?? []).length > 0 ? (
            <View style={styles.labels}>
              {(item.labels ?? []).map((label) => {
                const textColor = getContrastColor(label.color);
                return (
                  <Text
                    key={label.name}
                    style={[
                      styles.labelPill,
                      {
                        backgroundColor: label.color
                          ? `#${label.color}${closed ? '66' : ''}`
                          : theme.colors.hover,
                        color: closed ? `${textColor}CC` : textColor,
                      },
                    ]}
                  >
                    {label.name}
                  </Text>
                );
              })}
            </View>
          ) : null}

          {relatedPR ? (
            <Pressable
              testID={testID ? `${testID}-related-pr` : undefined}
              onPress={onRelatedPRPress}
              style={[styles.relatedPr, { borderTopColor: theme.colors.border }]}
            >
              <Icon name="code-branch" size={10} color={theme.colors.success} strokeWidth={2} />
              <Text
                numberOfLines={1}
                style={[styles.relatedPrText, { color: theme.colors.textSecondary }]}
              >
                #{relatedPR.number}: {relatedPR.title}
              </Text>
              {relatedPR.isDraft ? (
                <Text
                  style={[
                    styles.draftBadge,
                    { backgroundColor: theme.colors.hover, color: theme.colors.textSecondary },
                  ]}
                >
                  Draft
                </Text>
              ) : null}
            </Pressable>
          ) : null}
        </View>

        {showAssignee ? <AvatarColumn item={item} isPr={isPr} testID={testID} /> : null}
      </View>
    </Pressable>
  );
}

/**
 * The right 20px avatar column: PR → author avatar; issue → first assignee
 * avatar; neither → a dotted "unassigned" placeholder circle. (A
 * tap-to-assign CollaboratorPicker is not implemented.)
 */
function AvatarColumn({ item, isPr, testID }: { item: TaskIssue; isPr: boolean; testID?: string }) {
  const { theme } = useAppTheme();
  const avatarUrl = isPr ? item.user?.avatar_url : (item.assignees ?? [])[0]?.avatar_url;
  if (avatarUrl) {
    return (
      <Image
        testID={testID ? `${testID}-avatar` : undefined}
        source={{ uri: avatarUrl }}
        style={[styles.avatar, { borderColor: theme.colors.border }]}
      />
    );
  }
  return (
    <View
      testID={testID ? `${testID}-avatar-empty` : undefined}
      style={[styles.avatarEmpty, { borderColor: theme.colors.textTertiary }]}
    />
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, marginBottom: 4 },
  cardClosed: { opacity: 0.7 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  content: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  title: { flex: 1, fontSize: 13, fontWeight: '500' },
  closedBadge: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  repoLine: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 },
  ownerAvatar: { width: 14, height: 14, borderRadius: 7, borderWidth: 1 },
  repoText: { fontSize: 11, flexShrink: 1 },
  number: { fontSize: 11, fontWeight: '700', marginLeft: 2 },
  labels: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  labelPill: {
    fontSize: 11,
    fontWeight: '500',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  relatedPr: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderTopWidth: 1,
    marginTop: 6,
    paddingTop: 6,
  },
  relatedPrText: { flex: 1, fontSize: 11 },
  draftBadge: {
    fontSize: 10,
    paddingHorizontal: 4,
    borderRadius: 4,
    overflow: 'hidden',
  },
  avatar: { width: 20, height: 20, borderRadius: 10, borderWidth: 1 },
  avatarEmpty: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderStyle: 'dotted',
    opacity: 0.4,
  },
});
