/**
 * WorktreeChatComposer — start a chat FROM a worktree (portable.dev#17).
 *
 * A docked composer shown on the worktree-scoped Changes surfaces (the
 * Worktrees tab's {@link WorktreeChangesScreen} and the Source Control tab
 * with a non-main worktree selected). It renders the SAME chat widget as the
 * repo Overview ({@link RepoChatInput} — the shared ShortFormComposer card
 * with mic/send + the slash-command picker, opening UP over the change list).
 * Submitting runs the SAME repo chat hand-off as the Overview "Work on
 * {repo}…" input ({@link startRepoChatFlow}) with the worktree path riding
 * the `chat:create` payload — the backend validates it against the repo's
 * real worktree set and the chat then RUNS inside the worktree (its cwd), so
 * the AI works on that branch's checkout.
 *
 * Wiring mirrors `useRepoOverview.startWork`: gate on the socket PROVIDER only
 * (a not-yet-connected socket still attempts the emit; a failed ack REJECTS so
 * RepoChatInput restores the cleared input), per-project sticky new-chat
 * settings, one in-flight hand-off at a time, and the created chat's own
 * settings snapshot seeded (issue #4).
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RepoChatInput } from './RepoChatInput';
// Direct FILE imports (the sanctioned cross-feature pattern — never the chat barrel).
import { projectKeyForOwnerRepo } from '../chat/projectKey';
import { startRepoChatFlow } from '../chat/startRepoChat';
import { useOptionalSocket } from '../socket';
import { resolveNewChatSettings, useChatStore } from '../state';

export interface WorktreeChatComposerProps {
  owner: string;
  repo: string;
  /** The worktree's absolute path — becomes the chat's cwd. */
  worktree: string;
  /** The worktree's branch (or folder) name — names the placeholder. */
  branchLabel: string;
  /** Navigation seam (default: the imperative `router.push`). */
  navigate?: (path: string) => void;
  /** chatId factory forwarded to {@link startRepoChatFlow} (tests). */
  makeChatId?: () => string;
}

export function WorktreeChatComposer({
  owner,
  repo,
  worktree,
  branchLabel,
  navigate,
  makeChatId,
}: WorktreeChatComposerProps) {
  const insets = useSafeAreaInsets();
  const socket = useOptionalSocket();
  const [sending, setSending] = useState(false);
  const startingRef = useRef(false);

  // Per-project sticky new-chat settings (same resolution as the Overview input).
  const projectKey = projectKeyForOwnerRepo(owner, repo);
  const global = useChatStore((s) => s.newChatSettings);
  const projectEntry = useChatStore((s) => s.settingsByProject[projectKey]);
  const settings = useMemo(
    () =>
      resolveNewChatSettings(
        global,
        projectEntry ? { [projectKey]: projectEntry } : {},
        projectKey
      ),
    [global, projectEntry, projectKey]
  );

  // A failure PROPAGATES (no swallow) so RepoChatInput restores the input.
  const submit = useCallback(
    async (text: string) => {
      if (!socket || startingRef.current) throw new Error('Chat hand-off unavailable');
      startingRef.current = true;
      setSending(true);
      try {
        const chatId = await startRepoChatFlow({
          owner,
          repo,
          settings,
          message: text,
          worktree,
          emitCreateChat: socket.emitters.createChat,
          emitSendMessage: socket.emitters.sendMessage,
          navigate: navigate ?? ((id: string) => router.push(`/chat/${id}`)),
          makeChatId,
        });
        // Issue #4: the chat keeps the settings it was created with.
        useChatStore.getState().updateChatSettings(chatId, settings);
      } finally {
        startingRef.current = false;
        setSending(false);
      }
    },
    [socket, owner, repo, settings, worktree, navigate, makeChatId]
  );

  return (
    // The repo page is a Stack screen (no bottom tab bar), so the docked footer
    // absorbs the bottom safe-area inset itself.
    <View
      style={[styles.container, { paddingBottom: Math.max(insets.bottom, 8) }]}
      testID="worktree-chat-composer"
    >
      <RepoChatInput
        owner={owner}
        repo={repo}
        placeholder={`Start a chat in ${branchLabel}…`}
        canSend={!!socket && !sending}
        onSubmit={submit}
        direction="up"
        inputTestID="worktree-chat-input"
        sendTestID="worktree-chat-send"
        voiceTestID="worktree-chat-voice"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingTop: 8 },
});
