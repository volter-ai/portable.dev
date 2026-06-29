/**
 * LinkedIssueBadge — a single-line badge showing the GitHub issue linked
 * to a chat: an issue glyph + bold `#number` + the fetched issue title (and the
 * assignee avatar when present). Shown below the chat name in the chat
 * card body ({@link ChatCardBody} — the chat directory + the home "Continue
 * chats" preview) and in the active-chat header.
 *
 * When `onPress` is provided the badge is a `Pressable` that opens the linked
 * issue's detail (the caller builds the viewer target); without it the badge is
 * a plain, display-only `View` (the home preview, where pressing the card
 * continues the chat). It falls back to a bare `#number` while the title loads
 * or if the fetch fails — never a spinner/skeleton in a list row.
 */

import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useLinkedIssueDetails } from '../api/hooks';
import type { LinkedIssue } from '../chat/chrome/chatChromeStore';
import { Icon, useAppTheme } from '../../theme';

export interface LinkedIssueBadgeProps {
  linkedIssue: LinkedIssue;
  /** When provided the badge is tappable → opens the linked issue's detail. */
  onPress?: (linked: LinkedIssue) => void;
  style?: StyleProp<ViewStyle>;
}

export function LinkedIssueBadge({ linkedIssue, onPress, style }: LinkedIssueBadgeProps) {
  const { theme } = useAppTheme();
  // `retry: false` + a stale title source — a deleted/forbidden issue just shows
  // the bare `#number` (the `data` stays undefined), never a loading loop.
  const { data } = useLinkedIssueDetails(linkedIssue);

  const content = (
    <>
      <Icon name="circle-dot" size={12} color={theme.colors.textTertiary} />
      <Text
        testID="linked-issue-badge-number"
        style={[styles.number, { color: theme.colors.text }]}
      >
        #{linkedIssue.number}
      </Text>
      {data?.title ? (
        <Text
          testID="linked-issue-badge-title"
          style={[styles.title, { color: theme.colors.textSecondary }]}
          numberOfLines={1}
        >
          {data.title}
        </Text>
      ) : null}
      {data?.assignee ? (
        <Image source={{ uri: `${data.assignee.avatar_url}&s=32` }} style={styles.assignee} />
      ) : null}
    </>
  );

  if (onPress) {
    return (
      <Pressable
        testID="linked-issue-badge"
        accessibilityRole="button"
        accessibilityLabel={`Open linked issue #${linkedIssue.number}`}
        hitSlop={6}
        onPress={() => onPress(linkedIssue)}
        style={[styles.row, style]}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View testID="linked-issue-badge" style={[styles.row, style]}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 5, minWidth: 0 },
  number: { fontSize: 12, fontWeight: '700' },
  title: { fontSize: 12, flexShrink: 1 },
  assignee: { width: 14, height: 14, borderRadius: 7, marginLeft: 2 },
});
