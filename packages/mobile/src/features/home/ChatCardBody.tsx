/**
 * ChatCardBody — the shared inner content of a chat card: the title (first-message
 * preview / summary / title), the last-message preview, and the meta row (repo tag
 * with owner avatar, running indicator, and relative timestamp).
 *
 * Rendered as a Fragment so the PARENT container owns the layout + vertical gap —
 * used by both the home "Continue chats" preview ({@link HomeChatsSection}, a single
 * pressable card) and the full chat directory list (`ChatDirectoryScreen`, a row with
 * a pressable body + an actions column). This is the single source of the chat-card
 * body; the two screens only supply their own container chrome around it.
 */

import { stripAutopilotCompletionInstruction } from '@vgit2/shared/utils/autopilotHelpers';
import { Image, StyleSheet, Text, View } from 'react-native';

import { stripTaskNotifications } from '../chat/taskNotification';

import type { ChatListItem } from '@vgit2/shared/types';

import type { LinkedIssue } from '../chat/chrome/chatChromeStore';
import {
  getRelativeTime,
  getRepoBasename,
  getRepoFromPath,
  pruneAutopilotStopWord,
} from './homeHelpers';
import { LinkedIssueBadge } from './LinkedIssueBadge';
import { RunningOnPcBadge } from '../chat/RunningOnPcBadge';
import { useChatUnseen } from '../chat/useChatUnseen';
import { Icon, useAppTheme } from '../../theme';

export interface ChatCardBodyProps {
  chat: ChatListItem;
  /**
   * Tap handler for the linked-issue badge. When provided the badge
   * opens the issue's detail; without it the badge is display-only (the home
   * "Continue chats" preview, where pressing the card continues the chat).
   */
  onOpenLinkedIssue?: (linked: LinkedIssue) => void;
}

export function ChatCardBody({ chat, onOpenLinkedIssue }: ChatCardBodyProps) {
  const { theme } = useAppTheme();
  // A chat that CHANGED but hasn't been opened on this device since gets an orange
  // "unseen" dot (paired with the row's orange glow) — a clear, always-visible cue
  // that survives the swipeable row's clip where the glow's shadow can't.
  const unseen = useChatUnseen(chat);

  // Strip the injected autopilot instruction from the first-message preview before
  // using it as the card title. The backend normally returns the clean
  // `customDisplay.displayText`, but defend against any path that persisted the raw
  // augmented content — and stay consistent with the `lastMessagePreview` strip below.
  // An instruction-only preview strips to '' and falls through to summary/title.
  const cleanFirstPreview = chat.firstMessagePreview
    ? stripTaskNotifications(stripAutopilotCompletionInstruction(chat.firstMessagePreview))
    : '';
  const titleText = cleanFirstPreview || chat.summary || chat.title || 'Untitled chat';
  const lastMessage = chat.lastMessagePreview
    ? stripTaskNotifications(pruneAutopilotStopWord(chat.lastMessagePreview))
    : '';
  // Prefer the backend-resolved GitHub full name (owner/repo, from the git remote): the
  // flat-clone `repo_path` is a raw disk path that can't be parsed for owner/repo, so
  // without this the card fell back to a generic "Workspace" label. Then the legacy
  // claude-workspace path parse, then the disk-path basename (repo name only, no owner).
  const fullName = chat.repoFullName || getRepoFromPath(chat.repo_path) || undefined;
  const repoName = fullName ? fullName.split('/').pop() : getRepoBasename(chat.repo_path);
  const repoOwner = fullName ? fullName.split('/')[0] : null;
  // Local repos have no GitHub remote — show the name, suppress the avatar.
  const showOwnerAvatar = !!repoOwner && repoOwner !== 'local';
  const isRunning = chat.status === 'running';

  return (
    <>
      <View style={styles.titleRow}>
        {unseen ? (
          <View
            testID={`chat-unseen-${chat.id}`}
            accessibilityLabel="Unopened changes"
            style={[styles.unseenDot, { backgroundColor: theme.colors.primary }]}
          />
        ) : null}
        {chat.pinned ? <Icon name="pin" size={12} color={theme.colors.primary} /> : null}
        <Text
          style={[
            styles.title,
            // Pinned chats are highlighted: a pin glyph + the stronger `text` color.
            { color: chat.pinned ? theme.colors.text : theme.colors.textSecondary },
          ]}
          numberOfLines={1}
        >
          {titleText}
        </Text>
      </View>

      {lastMessage ? (
        <Text style={[styles.preview, { color: theme.colors.textTertiary }]} numberOfLines={1}>
          {lastMessage}
        </Text>
      ) : null}

      {chat.linkedIssue ? (
        <LinkedIssueBadge linkedIssue={chat.linkedIssue} onPress={onOpenLinkedIssue} />
      ) : null}

      {/* rev12 cross-surface presence: this chat's session is live in a
          terminal on the PC (renders nothing otherwise). */}
      <RunningOnPcBadge chatId={chat.id} />

      <View style={styles.metaRow}>
        <View style={styles.repoTag}>
          {repoName ? (
            <>
              {showOwnerAvatar ? (
                <Image
                  source={{ uri: `https://github.com/${repoOwner}.png?size=24` }}
                  style={styles.ownerAvatar}
                />
              ) : null}
              <Text
                style={[styles.repoText, { color: theme.colors.textTertiary }]}
                numberOfLines={1}
              >
                {repoName}
              </Text>
            </>
          ) : (
            <>
              <Icon name="folder" size={12} color={theme.colors.textTertiary} />
              <Text style={[styles.repoText, { color: theme.colors.textTertiary }]}>Workspace</Text>
            </>
          )}
        </View>

        <View style={styles.rightMeta}>
          {isRunning ? (
            <View style={styles.runningDots}>
              {[0, 1, 2].map((i) => (
                <View
                  key={i}
                  style={[styles.runningDot, { backgroundColor: theme.colors.textTertiary }]}
                />
              ))}
            </View>
          ) : null}
          {chat.lastUpdated ? (
            <Text style={[styles.time, { color: theme.colors.textTertiary }]}>
              {getRelativeTime(chat.lastUpdated)}
            </Text>
          ) : null}
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 5, minWidth: 0 },
  unseenDot: { width: 8, height: 8, borderRadius: 4 },
  title: { fontSize: 14, fontWeight: '500', flexShrink: 1 },
  preview: { fontSize: 13 },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  repoTag: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 },
  ownerAvatar: { width: 16, height: 16, borderRadius: 8 },
  repoText: { fontSize: 12, flexShrink: 1 },
  rightMeta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  runningDots: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  runningDot: { width: 4, height: 4, borderRadius: 2 },
  time: { fontSize: 12 },
});
