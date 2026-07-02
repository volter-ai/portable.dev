/**
 * ActiveChatScreen — a single chat view, restyled for 1:1 visual parity with the
 * web `ChatInstance` (US "chat design"):
 *
 *   - a themed chat HEADER bar (back chevron + the repo indicator / "Chat" title),
 *     replacing the old debug `id`-as-title + raw-settings-text block;
 *   - the chrome banner stack ({@link ChatChrome}: git status / container status /
 *     quick actions), then the streaming {@link MessageList} transcript;
 *   - the full composer card ({@link FollowUpComposer}) docked at the bottom —
 *     the SAME input body as the home {@link ChatComposer} (attachment / mic↔send /
 *     model / permissions / agent), but wired to send a FOLLOW-UP into
 *     this chat (offline-queue aware) and to drive the PER-CHAT settings
 *     (`useChatSettings`), plus a Stop button while the run is active.
 *
 * The per-chat settings + the raw chat id stay available to the test contract via
 * a hidden mirror (the established `height:0` testID-mirror pattern), so the visible
 * UI is the new design while `setting-*` / `active-chat-id` assertions keep passing.
 *
 * The socket is read via the NON-throwing {@link useOptionalSocket}, so the screen
 * renders before the app-shell mounts the `SocketProvider` (history-less until then).
 */

import type { MessageAction, QuickAction } from '@vgit2/shared/types';
import { getRepoFromPath } from '@vgit2/shared/utils/pathHelpers';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { KeyboardAvoidingView } from './KeyboardAvoidingViewCompat';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAgentSetups } from '../api/hooks';
import { getRelayUrl } from '../api/relayUrlStore';
import { useOfflineMessageQueue } from '../socket/useOfflineMessageQueue';
import { useOptionalSocket } from '../socket/SocketProvider';
import { useSocketStore } from '../socket/socketStore';
import type { NativeSocket } from '../socket/useNativeSocket';
import { LinkedIssueBadge } from '../home/LinkedIssueBadge';
import { isImage, type UploadedAttachment } from './attachments';
import { getAgentInfo } from './agentInfo';
import { useChatMessagesStore } from './chatMessagesStore';
import { useChatSeenStore } from './chatSeenStore';
import { ChatChrome } from './chrome/ChatChrome';
import { useChatLinkedIssue } from './chrome/useChatLinkedIssue';
import { useChatRepoPath } from './chrome/useChatRepoPath';
import { projectKeyFromRepoPath } from './projectKey';
import { FollowUpComposer, type FollowUpComposerHandle } from './FollowUpComposer';
import { dispatchMessageAction } from './messageActions';
import { useLinkedIssueViewer } from './LinkedIssueViewerHost';
import { ActiveChatInteractions, ChatInteractionProvider } from './interactions';
import { MessageList } from './MessageList';
import { RunningOnPcBadge } from './RunningOnPcBadge';
import { RunningOnPcBanner } from './RunningOnPcBanner';
import { useRunningOnPc } from './useRunningOnPc';
import { ChatRuntimeBubble } from './runtime/ChatRuntimeBubble';
import { useChatRuntimePreview } from './runtime/useChatRuntimePreview';
import { DEFAULT_AGENT_SETUP } from './useChatComposer';
import { useChatSettings } from './useChatSettings';
import { useChatStream } from './useChatStream';
import { Icon, useAppTheme } from '../../theme';

/** No-op socket fallback for a pre-SocketProvider mount (emitters never reached). */
const NO_SOCKET: Pick<NativeSocket, 'emitters'> = {
  emitters: {} as NativeSocket['emitters'],
};

/** Process-unique client message ids for optimistic ↔ echo reconciliation. */
let outgoingSeq = 0;
const makeMessageId = () => `m-${Date.now()}-${outgoingSeq++}`;

export function ActiveChatScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { theme } = useAppTheme();
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  const id = typeof chatId === 'string' ? chatId : '';

  // Fork-on-first-write redirect: when the PC forks THIS chat (a Claude Code chat
  // we just sent the first message to) into a new Portable chat, navigate to it.
  // `replace` so the now-claimed old id leaves the back stack. Guarded by the
  // event's monotonic `seq` so it fires exactly once per fork.
  const lastForkedChat = useSocketStore((s) => s.lastForkedChat);
  const handledForkSeqRef = useRef(0);
  useEffect(() => {
    if (!lastForkedChat || lastForkedChat.seq === handledForkSeqRef.current) return;
    if (lastForkedChat.oldChatId !== id) return;
    handledForkSeqRef.current = lastForkedChat.seq;
    router.replace(`/chat/${lastForkedChat.newChatId}`);
  }, [lastForkedChat, id, router]);

  // Opening a chat clears its "unseen change" highlight in the chat lists — mark it
  // seen on mount, and again on leave so activity that streamed in while it was open
  // doesn't re-glow the row the moment the user backs out. `Date.now()` is a safe
  // upper bound: a chat's `lastUpdated` reflects PAST activity, so it never exceeds now.
  const markChatSeen = useChatSeenStore((s) => s.markSeen);
  useEffect(() => {
    if (!id) return;
    markChatSeen(id, Date.now());
    return () => markChatSeen(id, Date.now());
  }, [id, markChatSeen]);

  const repoPath = useChatRepoPath(id);
  // Per-project sticky settings ("last mode selected there"): key the chat's
  // settings to its project so changing the agent here is remembered for the
  // next chat in this project (and a brand-new chat inherits it).
  const projectKey = projectKeyFromRepoPath(repoPath);
  const { settings, loading, update } = useChatSettings(id, projectKey);

  // Imperative handle to the composer so a `prefill_input` follow-up action can
  // populate the input for editing.
  const composerRef = useRef<FollowUpComposerHandle>(null);

  const socket = useOptionalSocket();
  const { messages, status, error, isWorking, markRead, hasMore, isLoadingMore, loadMore } =
    useChatStream(socket, id);

  // Header repo indicator: owner avatar + repo
  // name, falling back to a generic "Chat" title. Local repos have no GitHub owner.
  const repoFullName = getRepoFromPath(repoPath);
  const [repoOwner, repoName] = repoFullName ? repoFullName.split('/') : [null, null];
  const showOwnerAvatar = !!repoOwner && repoOwner !== 'local';

  // Linked GitHub issue: the number + title below the chat name, tappable
  // to open the issue detail. Resolved from the live socket sink (a mid-session
  // link) or the cached chat-directory list; `undefined` ⇒ the badge renders nothing.
  const linkedIssue = useChatLinkedIssue(id);
  const linkedIssueViewer = useLinkedIssueViewer();

  // rev12 cross-surface presence: is this chat's session live in a terminal on
  // the PC? `onPc` drives the header badge + Stop-on-PC banner; `runningOnPc`
  // (a turn in flight there) drives the transcript's "Working locally..." line.
  const { onPc, runningOnPc } = useRunningOnPc(id);

  // The chat's running-project preview: when this chat has a live
  // dev-server tunnel, a draggable bubble floats over the transcript — iOS opens
  // the system browser, Android embeds a navigable WebView.
  const previewTunnel = useChatRuntimePreview(socket, id, repoPath);

  // The active agent's display name + color drive the typing indicator.
  // Same query the composer's agent sheet uses (deduped).
  // The full setup list also rides into the MessageList so each SUB-AGENT group
  // resolves its own color for the rail / avatar / typing dots.
  const agentSetupsQuery = useAgentSetups();
  const agentSetups = useMemo(() => {
    const fromServer = agentSetupsQuery.data?.agentSetups ?? [];
    return fromServer.some((s) => s.id === DEFAULT_AGENT_SETUP.id)
      ? fromServer
      : [DEFAULT_AGENT_SETUP, ...fromServer];
  }, [agentSetupsQuery.data]);
  const agentInfo = useMemo(
    () => getAgentInfo(settings.agentSetupId, agentSetups),
    [agentSetups, settings.agentSetupId]
  );

  // Offline-tolerant follow-up send: delivers live when connected,
  // else queues to MMKV and auto-flushes on the next reconnect (kill-recovery).
  const queue = useOfflineMessageQueue({ socket: socket ?? NO_SOCKET });
  const handleSend = useCallback(
    (content: string, attachments?: UploadedAttachment[]) => {
      if (!id) return;
      const files = attachments?.map((a) => a.response);
      // Device-local URIs for image thumbnails — resolved immediately (no async
      // getRelayUrl needed). Preserved through echo reconciliation.
      const localFileUris = attachments?.filter((a) => isImage(a.file)).map((a) => a.file.uri);
      // Optimistic append: the message shows immediately; the
      // server's `user_message` echo replaces it in place by `messageId`.
      const messageId = makeMessageId();
      useChatMessagesStore.getState().appendUserMessage(id, {
        id: messageId,
        role: 'user',
        content,
        timestamp: Date.now(),
        optimistic: true,
        uploadedFiles: files,
        localFileUris: localFileUris?.length ? localFileUris : undefined,
      });
      void queue.send(id, content, messageId, files);
    },
    [id, queue]
  );

  // Quick-action pills (Start / Restart server, run tests, …) send their prompt
  // as a chat message. Reuses the
  // offline-tolerant `handleSend` so the action shows optimistically and survives
  // a reconnect. Only `message`-type actions exist in the mobile bar today.
  const handleQuickAction = useCallback(
    (action: QuickAction) => {
      if (action.type === 'message') handleSend(action.prompt);
    },
    [handleSend]
  );

  // AI follow-up action chips:
  // archive / send_message → send the prompt; prefill_input → populate the composer
  // for editing; no actionType → ignored (the pure dispatcher logs it). `handleSend`
  // is the offline-tolerant path so the action shows optimistically + survives a
  // reconnect, exactly like the quick-action pills.
  const handleActionClick = useCallback(
    (action: MessageAction) => {
      dispatchMessageAction(action, {
        send: handleSend,
        prefill: (text) => composerRef.current?.insertText(text),
      });
    },
    [handleSend]
  );

  // Stop the running chat (Stop button → `claude:interrupt`).
  const handleStop = useCallback(() => {
    if (!socket) return;
    void socket.emitters.interruptClaude({ chatId: id }).catch(() => {});
  }, [socket, id]);

  // Open the in-app browser to the sandbox connection surface. The full OAuth
  // round-trip + provider list lands later; this initiates the flow.
  const startConnection = useCallback((service: string) => {
    void (async () => {
      const base = await getRelayUrl();
      if (!base) return;
      const url = `${base}/connections?service=${encodeURIComponent(service)}`;
      const WebBrowser = await import('expo-web-browser');
      await WebBrowser.openBrowserAsync(url);
    })();
  }, []);

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      behavior="padding"
      testID="active-chat"
    >
      {/* Themed chat header: back + repo indicator / title, with the linked-issue
          badge on a second line below the chat name. */}
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 6, borderBottomColor: theme.colors.borderLight },
        ]}
      >
        <View style={styles.headerRow}>
          <Pressable
            testID="active-chat-back"
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={8}
            style={styles.backButton}
            onPress={() => router.back()}
          >
            <Icon name="chevron-left" size={18} color={theme.colors.text} />
          </Pressable>

          <View style={styles.headerCenter}>
            {showOwnerAvatar ? (
              <Image
                source={{ uri: `https://github.com/${repoOwner}.png?size=48` }}
                style={styles.headerAvatar}
              />
            ) : null}
            <Text style={[styles.headerTitle, { color: theme.colors.text }]} numberOfLines={1}>
              {repoName ?? 'Chat'}
            </Text>
          </View>
        </View>

        {linkedIssue ? (
          <View style={styles.headerLinkedIssue}>
            <LinkedIssueBadge linkedIssue={linkedIssue} onPress={linkedIssueViewer.open} />
          </View>
        ) : null}

        {/* rev12 cross-surface presence: session live in a terminal on the PC
            (gated on the hook so no empty padded row renders otherwise). */}
        {onPc ? (
          <View style={styles.headerLinkedIssue}>
            <RunningOnPcBadge chatId={id} />
          </View>
        ) : null}
      </View>

      {/* Hidden test-contract mirror: the raw chat id + resolved per-chat settings
          (the visible UI now surfaces these via the header + composer selectors). */}
      <View style={styles.hidden} testID="active-chat-settings" pointerEvents="none">
        <Text testID="active-chat-id">{id}</Text>
        {loading ? <ActivityIndicator testID="active-chat-loading" /> : null}
        <Text testID="setting-model">model: {settings.model}</Text>
        <Text testID="setting-permissions">permissions: {settings.permissions}</Text>
        <Text testID="setting-agent">agent: {settings.agentSetupId}</Text>
      </View>

      <ChatChrome chatId={id} repoPath={repoPath} onQuickAction={handleQuickAction} />

      <ChatInteractionProvider chatId={id} socket={socket} onStartConnection={startConnection}>
        <MessageList
          messages={messages}
          status={status}
          error={error}
          isWorking={isWorking}
          workingOnPc={runningOnPc}
          agentSetupId={settings.agentSetupId}
          agentName={agentInfo.name}
          agentColor={agentInfo.color}
          agentSetups={agentSetups}
          onMarkRead={markRead}
          onActionClick={handleActionClick}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          onLoadMore={loadMore}
        />
        <ActiveChatInteractions chatId={id} />
      </ChatInteractionProvider>

      <View style={{ paddingBottom: insets.bottom }}>
        {/* rev12: Stop-on-PC affordance — only mounts when a terminal session is
            live on the PC (distinct from the composer's local run Stop). */}
        <RunningOnPcBanner chatId={id} />
        <FollowUpComposer
          ref={composerRef}
          chatId={id}
          settings={settings}
          onUpdateSettings={update}
          onSend={handleSend}
          status={status}
          onStop={socket ? handleStop : undefined}
        />
      </View>

      {/* Floating, draggable runtime preview — only mounts when a live tunnel exists. */}
      <ChatRuntimeBubble tunnel={previewTunnel} />

      {/* In-app linked-issue detail — mounts only after the badge is tapped. */}
      {linkedIssueViewer.element}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 8,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // Indent the linked-issue line under the title (back button 28 + 6 gap).
  headerLinkedIssue: { paddingLeft: 34, paddingTop: 4 },
  backButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  },
  headerCenter: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  headerAvatar: { width: 20, height: 20, borderRadius: 10 },
  headerTitle: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  hidden: { height: 0, width: 0, opacity: 0, overflow: 'hidden' },
});
