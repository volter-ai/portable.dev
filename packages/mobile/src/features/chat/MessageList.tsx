/**
 * MessageList — streaming chat transcript.
 *
 * Renders the message history + live `claude:stream` blocks in a `FlatList`,
 * grouping a message's blocks by `parent_tool_use_id` so each sub-agent (Task)
 * run shows under a collapsible header with an agent avatar. Sub-agent groups
 * default to COLLAPSED and expand on tap. The list:
 *  - auto-scrolls to the bottom whenever the content GROWS (a new message / streamed
 *    block), ALWAYS — even after the user scrolled up, and when the "AI is responding"
 *    placeholder appears. Only a collapse (content SHRINKS) never scrolls. There is no
 *    near-bottom gate (it stranded the stream off the bottom / scrolled to the top);
 *  - auto-marks-as-read via `onViewableItemsChanged` — the highest visible numeric
 *    message id is acked;
 *  - shows a typing/processing indicator while the run is `running`
 *    (`claude:processing` / `claude:status`), and terminal interrupted / error
 *    states (`claude:interrupted` / `claude:error`);
 *  - hosts the interactive ask-user prompt as its `footer` (issue #10): the prompt's
 *    content is unbounded (N questions + inputs + a shared Submit), so it must live
 *    inside the one real scroller — and `scrollFooterInputIntoView` (the `ref`
 *    handle) nudges a focused footer input into the visible window once the
 *    keyboard has shrunk the list (measured, not guessed).
 *
 * Block CONTENT rendering here is intentionally minimal — the full block-renderer
 * set lives in `blocks/`. This file owns the list mechanics + grouping + indicators.
 */

import type { AgentSetup, ChatStatus, MessageAction } from '@vgit2/shared/types';
import { LinearGradient } from 'expo-linear-gradient';
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewToken,
} from 'react-native';

import { getAgentInfo, DEFAULT_AGENT_COLOR } from './agentInfo';
import { renderMessageBlocks } from './blocks';
import type { MobileChatMessage } from './chatMessagesStore';
import { groupBlocksByAgent, type BlockGroup } from './groupBlocksByAgent';
import { isOnlyTaskNotification, stripTaskNotifications } from './taskNotification';
import { TypingIndicator } from './TypingIndicator';
import { copyToClipboard } from '../file-viewer/clipboard';
import { lh, useAppTheme } from '../../theme';
import { Icon } from '../../theme/icons/Icon';

/** The subset of a native node the scroll-into-view measurement needs. */
export interface MeasurableNode {
  measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void;
}

/** Absolute window rect, as reported by `measureInWindow`. */
export interface MeasuredRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Measurement seam: resolve a node's absolute window rect. `role` says which side
 * of the comparison the node is (`viewport` = the list's visible container,
 * `target` = the focused footer input) so tests can stub each independently.
 * `measureInWindow` is a device no-op under Jest, hence the injectable default.
 */
export type MeasureNode = (
  node: MeasurableNode | null,
  role: 'viewport' | 'target'
) => Promise<MeasuredRect | null>;

const defaultMeasureNode: MeasureNode = (node) =>
  new Promise((resolve) => {
    if (!node || typeof node.measureInWindow !== 'function') {
      resolve(null);
      return;
    }
    node.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
  });

/** Clearance kept between a scrolled-into-view input and the viewport edges. */
const SCROLL_INTO_VIEW_MARGIN = 12;

/**
 * How far the list must scroll so `target` sits inside `viewport` with a margin:
 * positive = scroll down (content moves up), negative = scroll up, 0 = already
 * visible. Both rects are absolute (window) coordinates. The KeyboardAvoidingView
 * shrinks the list when the keyboard opens, so the list's OWN bounds already
 * exclude the keyboard — no keyboard-height math needed.
 */
export function computeScrollIntoViewDelta(
  target: { top: number; bottom: number },
  viewport: { top: number; bottom: number },
  margin: number = SCROLL_INTO_VIEW_MARGIN
): number {
  const overBottom = target.bottom - (viewport.bottom - margin);
  if (overBottom > 0) return overBottom;
  const overTop = viewport.top + margin - target.top;
  if (overTop > 0) return -overTop;
  return 0;
}

/** Imperative surface exposed through the `ref` prop. */
export interface MessageListHandle {
  /**
   * Scroll a focused `footer` input into the list's visible window: measures
   * immediately (covers an already-open keyboard) and again on `keyboardDidShow`
   * (only then has the KeyboardAvoidingView shrunk the list to its final size).
   */
  scrollFooterInputIntoView(input: MeasurableNode | null): void;
}

export interface MessageListProps {
  messages: MobileChatMessage[];
  status?: ChatStatus;
  error?: string;
  isWorking?: boolean;
  /** Imperative handle ({@link MessageListHandle}) — React 19 ref-as-prop. */
  ref?: Ref<MessageListHandle>;
  /**
   * Interactive content rendered at the END of the list (after the indicators and
   * error row) — the ask-user prompt (issue #10). Inside the scroller so the one
   * FlatList owns scrolling questions + Submit, and content growth auto-scroll
   * reveals the prompt when it appears.
   */
  footer?: ReactNode;
  /**
   * True while an INTERACTIVE prompt is pending in the footer (an ask-user form).
   * The run is paused waiting for the answer, so nothing streams — which means
   * every content growth while it's set is footer-INTERNAL (an "Other" input
   * mounting, the validation error row). The always-snap-on-growth policy would
   * yank the just-revealed input off-screen on each such edit, so it is suppressed
   * here: the prompt is still revealed once when it FIRST appears (the false→true
   * edge), and thereafter a focused input positions itself via
   * {@link MessageListHandle.scrollFooterInputIntoView} instead (issue #10).
   */
  footerActive?: boolean;
  /** Measurement seam for {@link MessageListHandle.scrollFooterInputIntoView}. */
  measureNode?: MeasureNode;
  /**
   * rev12 presence: a terminal turn is in flight on the PC. Nothing streams to
   * the app during it (the transcript hydrates only when the turn completes),
   * so the footer shows the working dots with a "Working locally..." line.
   * The local run's indicator (`isWorking`) always takes precedence.
   */
  workingOnPc?: boolean;
  /** Agent setup id for the main-agent group label (per-chat setting). */
  agentSetupId?: string;
  /** Display name of the active agent ("Best Practice") for the working line. */
  agentName?: string;
  /** Accent color of the active agent for the typing dots / badge. */
  agentColor?: string;
  /**
   * Full agent-setup list for resolving each SUB-AGENT group's own color
   * (web `getAgentColor(group.agentType, agentSetups)` parity — the group rail,
   * avatar and typing dots all take the active agent's color).
   */
  agentSetups?: AgentSetup[];
  /** Called with the highest visible numeric message id (auto-mark-as-read). */
  onMarkRead?: (messageId: number) => void;
  /**
   * Tap handler for an AI follow-up `actions` block's chips — threaded
   * down to each block via `renderMessageBlocks`. Absent ⇒ chips are inert.
   */
  onActionClick?: (action: MessageAction) => void;
  /** True when the backend has older messages to reveal (shows "Load earlier"). */
  hasMore?: boolean;
  /** True while a load-earlier re-join is in flight (shows the header spinner). */
  isLoadingMore?: boolean;
  /** Load an earlier page of history (re-join with a bigger count). */
  onLoadMore?: () => void;
  /**
   * Scroll scheduler seam — when/how the snap-to-bottom runs. Defaults to deferring one
   * frame via `requestAnimationFrame` (see {@link defaultScheduleScroll}); tests inject a
   * synchronous runner so `scrollToEnd` is asserted in the same tick.
   */
  scheduleScroll?: (cb: () => void) => void;
}

/** One-time guard so the id-less-message warning (keyExtractor) doesn't spam. */
let warnedMissingMessageId = false;

/** True when content height grew by more than sub-pixel jitter (a real new block). */
const CONTENT_GROWTH_EPSILON = 1;

/**
 * Default scroll scheduler: run the snap-to-bottom on the NEXT frame (after the layout
 * commit) rather than synchronously. On RN 0.85 New Architecture `onContentSizeChange`
 * can fire BEFORE the scroll view's content offset has settled, so a synchronous
 * `scrollToEnd` measures against a stale offset and lands at the TOP of the just-grown
 * block (the "new message scrolls to the start of the block" bug). Deferring one frame
 * lets the new content commit first, so `scrollToEnd` reaches the true bottom. Tests
 * inject a synchronous runner via the `scheduleScroll` prop. `requestAnimationFrame`
 * may be absent in a non-RN context → fall back to an immediate run.
 */
const defaultScheduleScroll = (cb: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb);
  else cb();
};

/**
 * A sub-agent group: a colored-rail card with an avatar header + count,
 * collapsible body of its blocks (web parity: the agent block group renders with
 * an avatar + agent name pill and a colored left rail down its content).
 */
function AgentGroup({
  group,
  label,
  agentColor,
  working,
  status,
  onActionClick,
}: {
  group: BlockGroup;
  /** Resolved sub-agent designation ("GitHub Specialist") for the header + working line. */
  label: string;
  /** The group agent's accent color (web `getAgentColor` parity). */
  agentColor: string;
  /** True while this group is the ACTIVE (last) group of a running turn. */
  working?: boolean;
  status?: ChatStatus;
  onActionClick?: (action: MessageAction) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { theme } = useAppTheme();
  const id = group.parentToolUseId as string;
  const initials = label
    .split(' ')
    .map((w) => w.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <View
      style={[
        styles.agentGroup,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
      testID={`agent-group-${id}`}
    >
      <Pressable
        style={styles.agentHeader}
        onPress={() => setExpanded((v) => !v)}
        testID={`agent-toggle-${id}`}
        accessibilityRole="button"
      >
        <View
          style={[styles.agentAvatar, { backgroundColor: agentColor }]}
          testID={`agent-avatar-${id}`}
        >
          <Text style={styles.agentAvatarText}>{initials}</Text>
        </View>
        {/* Designation + the spawning Task's description, so two sub-agents of the
            SAME type stay distinguishable ("Explore · Find the auth middleware"). */}
        <View style={styles.agentTitle}>
          <Text
            style={[styles.agentName, { color: theme.colors.text }]}
            numberOfLines={1}
            testID={`agent-name-${id}`}
          >
            {label}
          </Text>
          {group.taskDescription ? (
            <Text
              style={[styles.agentTask, { color: theme.colors.textSecondary }]}
              numberOfLines={1}
              testID={`agent-task-${id}`}
            >
              {group.taskDescription}
            </Text>
          ) : null}
        </View>
        {/* Collapsed + working: the dots animate in the header next to the count
            (web parity — the collapsed count chip carries hideText dots). */}
        {working && !expanded && (
          <TypingIndicator inline hideText status={status} agentColor={agentColor} />
        )}
        <Text style={[styles.agentCount, { color: theme.colors.textSecondary }]}>
          {expanded ? '▾' : '▸'} {group.blocks.length}
        </Text>
      </Pressable>
      {expanded && (
        <View
          testID={`agent-body-${id}`}
          style={[styles.agentBody, { borderLeftColor: agentColor }]}
        >
          {renderMessageBlocks(group.blocks, id, onActionClick)}
          {/* Expanded + working: full inline indicator with the SUB-AGENT's name +
              color (web "Typing indicator for active sub-agent" parity). */}
          {working && (
            <TypingIndicator inline status={status} agentName={label} agentColor={agentColor} />
          )}
        </View>
      )}
    </View>
  );
}

/**
 * Copy-to-clipboard button for a user message — the native parity of the web
 * `Message.tsx` header copy icon (top-right of the bubble). Flips to a check for
 * 1.5s after a successful copy (the file-viewer `Breadcrumb` pattern). `onCopy`
 * is injectable so tests never load the native clipboard module.
 */
function MessageCopyButton({
  text,
  index,
  onCopy = copyToClipboard,
}: {
  text: string;
  index: number;
  onCopy?: (text: string) => void | Promise<void>;
}) {
  const { theme } = useAppTheme();
  const [copied, setCopied] = useState(false);

  // Reset the "copied" checkmark after 1.5s, cleaned up on unmount.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function handleCopy() {
    if (!text) return;
    await onCopy(text);
    setCopied(true);
  }

  return (
    <Pressable
      testID={`message-copy-${index}`}
      onPress={handleCopy}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={copied ? 'Copied' : 'Copy message'}
      style={styles.copyButton}
    >
      <Icon
        name={copied ? 'check' : 'copy'}
        size={14}
        color={copied ? theme.colors.accent : theme.colors.textSecondary}
      />
    </Pressable>
  );
}

interface MessageItemProps {
  message: MobileChatMessage;
  index: number;
  allMessages: MobileChatMessage[];
  agentSetupId?: string;
  /** True on the LAST assistant message while the run is active (web parity). */
  showInlineWorking?: boolean;
  status?: ChatStatus;
  agentName?: string;
  agentColor?: string;
  agentSetups?: AgentSetup[];
  onActionClick?: (action: MessageAction) => void;
}

/**
 * Re-render a row only when something it actually renders changed. `allMessages` is
 * DELIBERATELY excluded: the store hands a NEW array on every streamed chunk, so
 * comparing it would defeat memoization and re-render every visible row (the
 * "VirtualizedList slow to update" warning). A row depends on `allMessages` only to
 * resolve a sub-agent's display name when the spawning `Task` tool lives in an EARLIER
 * message (`groupBlocksByAgent`) — a rare, cosmetic lookup that is stable once history
 * has loaded, so dropping it from the comparison is safe.
 */
function messageItemPropsAreEqual(prev: MessageItemProps, next: MessageItemProps): boolean {
  return (
    prev.message === next.message &&
    prev.index === next.index &&
    prev.agentSetupId === next.agentSetupId &&
    prev.showInlineWorking === next.showInlineWorking &&
    prev.status === next.status &&
    prev.agentName === next.agentName &&
    prev.agentColor === next.agentColor &&
    prev.agentSetups === next.agentSetups &&
    prev.onActionClick === next.onActionClick
  );
}

const MessageItem = memo(function MessageItem({
  message,
  index,
  allMessages,
  agentSetupId,
  showInlineWorking,
  status,
  agentName,
  agentColor,
  agentSetups,
  onActionClick,
}: MessageItemProps) {
  const isUser = message.role === 'user';
  const { theme, boldMode, boldGradient, getBoldTextColor } = useAppTheme();

  const groups = useMemo(
    () => groupBlocksByAgent(message.blocks ?? [], allMessages, index, undefined, agentSetupId),
    [message.blocks, allMessages, index, agentSetupId]
  );

  // Resolve each sub-agent group's designation + color from the agent setups (web
  // parity: name/color come from `getAgentInfo(group.agentType, agentSetups)` — the
  // configured sub-agent's `name`/`colorTheme`, else the humanized slug). When the
  // group carries no type (Task lacked a subagent_type), fall back to the humanized
  // `agentName` and the default gray.
  const infoForGroup = useCallback(
    (group: BlockGroup): { name: string; color: string } => {
      if (group.agentType) return getAgentInfo(group.agentType, agentSetups ?? []);
      return { name: group.agentName ?? 'Subagent', color: DEFAULT_AGENT_COLOR };
    },
    [agentSetups]
  );

  // When the run's ACTIVE group is a sub-agent, the working animation lives
  // INSIDE that group (in its color); only a main-agent tail keeps the indicator
  // after the groups (web MessageBlocks parity).
  const lastGroupIsSubAgent = groups.length > 0 && !!groups[groups.length - 1].parentToolUseId;

  // Strip any background-task notification the agent runtime injected (a `killed`/`done`
  // status blob) so it never leaks into a user bubble; a message that is ONLY a
  // notification is already filtered out upstream (MessageList `visibleMessages`).
  const content = stripTaskNotifications(
    typeof message.content === 'string' ? message.content : ''
  );

  // Bold-mode user bubble: accent-gradient fill (web Message.tsx:204 parity). The
  // copy-message button sits above the bubble, right-aligned (web header parity).
  if (isUser && boldMode) {
    return (
      <View style={styles.userWrapper}>
        <MessageCopyButton text={content} index={index} />
        <LinearGradient
          colors={boldGradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.message, styles.userMessage]}
          testID={`message-${index}`}
        >
          <Text
            testID="message-user-content"
            style={[styles.userText, { color: getBoldTextColor(), lineHeight: lh(13, 1.5) }]}
          >
            {content}
          </Text>
        </LinearGradient>
      </View>
    );
  }

  // Regular user bubble: accent-soft fill, with the copy-message button above it
  // (top-right of the box).
  // Image attachments render as thumbnails above the text bubble.
  if (isUser) {
    return (
      <View style={styles.userWrapper}>
        <MessageCopyButton text={content} index={index} />
        {message.localFileUris && message.localFileUris.length > 0 ? (
          <View style={styles.userAttachments}>
            {message.localFileUris.map((uri, i) => (
              <Image
                key={i}
                source={{ uri }}
                style={styles.userAttachmentThumb}
                testID={`user-attachment-${index}-${i}`}
              />
            ))}
          </View>
        ) : null}
        <View
          style={[styles.message, styles.userMessage, { backgroundColor: theme.colors.accentSoft }]}
          testID={`message-${index}`}
        >
          <Text
            testID="message-user-content"
            style={[styles.userText, { color: theme.colors.text, lineHeight: lh(13, 1.5) }]}
          >
            {content}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.message, styles.assistantMessage]} testID={`message-${index}`}>
      {groups.map((group, gi) =>
        group.parentToolUseId ? (
          // `groupBlocksByAgent` now folds each parentToolUseId into ONE group, so
          // the id is unique within a message — but key by position too, harmlessly,
          // to stay stable if a future grouping ever re-splits it.
          <AgentGroup
            key={`${index}-${gi}-${group.parentToolUseId}`}
            group={group}
            label={infoForGroup(group).name}
            agentColor={infoForGroup(group).color}
            working={!!showInlineWorking && gi === groups.length - 1}
            status={status}
            onActionClick={onActionClick}
          />
        ) : (
          <View key={`${index}-main-${gi}`}>
            {renderMessageBlocks(group.blocks, `${index}-${gi}`, onActionClick)}
          </View>
        )
      )}
      {/* The inline working indicator stays under the streaming blocks for
          the whole run: the web hides it once blocks arrive because its
          tool blocks carry their own shimmer animation — mobile has no
          shine, so the dots are the only "still alive" signal here. While a
          SUB-AGENT is the active (last) group, its AgentGroup renders the
          indicator instead — in that agent's color. */}
      {showInlineWorking && !lastGroupIsSubAgent && (
        <TypingIndicator inline status={status} agentName={agentName} agentColor={agentColor} />
      )}
    </View>
  );
}, messageItemPropsAreEqual);

export function MessageList({
  messages,
  status,
  error,
  isWorking,
  workingOnPc,
  agentSetupId,
  agentName,
  agentColor,
  agentSetups,
  onMarkRead,
  onActionClick,
  hasMore,
  isLoadingMore,
  onLoadMore,
  scheduleScroll = defaultScheduleScroll,
  ref,
  footer,
  footerActive,
  measureNode = defaultMeasureNode,
}: MessageListProps) {
  const listRef = useRef<FlatList<MobileChatMessage>>(null);
  const { theme } = useAppTheme();

  // ── Footer-input keyboard scroll (issue #10) ──────────────────────────────
  // The container View's bounds ARE the visible list window (the root
  // KeyboardAvoidingView shrinks it when the keyboard opens), so scrolling a
  // focused footer input into view is a pure measure-and-nudge — no keyboard
  // height involved. The latest content offset is tracked via `onScroll` because
  // FlatList exposes no synchronous read.
  const containerRef = useRef<View>(null);
  const scrollOffsetRef = useRef(0);
  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffsetRef.current = e.nativeEvent.contentOffset.y;
  }, []);

  // One-shot keyboardDidShow subscription: replaced on every focus, removed on
  // unmount — never leaks past the component (the #1435 setTimeout-cleanup lesson).
  const keyboardScrollSubRef = useRef<{ remove: () => void } | null>(null);
  useEffect(() => () => keyboardScrollSubRef.current?.remove(), []);

  const scrollFooterInputIntoView = useCallback(
    (input: MeasurableNode | null) => {
      if (!input) return;
      const run = async () => {
        const [viewport, target] = await Promise.all([
          measureNode(containerRef.current, 'viewport'),
          measureNode(input, 'target'),
        ]);
        if (!viewport || !target) return;
        const delta = computeScrollIntoViewDelta(
          { top: target.y, bottom: target.y + target.height },
          { top: viewport.y, bottom: viewport.y + viewport.height }
        );
        if (delta === 0) return;
        listRef.current?.scrollToOffset({
          offset: Math.max(0, scrollOffsetRef.current + delta),
          animated: true,
        });
      };
      // Now (keyboard may already be up) + once the keyboard finishes opening
      // (the KeyboardAvoidingView has shrunk the list only then).
      void run();
      keyboardScrollSubRef.current?.remove();
      const sub = Keyboard.addListener('keyboardDidShow', () => {
        sub.remove();
        if (keyboardScrollSubRef.current === sub) keyboardScrollSubRef.current = null;
        void run();
      });
      keyboardScrollSubRef.current = sub;
    },
    [measureNode]
  );

  useImperativeHandle(ref, () => ({ scrollFooterInputIntoView }), [scrollFooterInputIntoView]);

  // Drop messages that are ENTIRELY a background-task notification (a runtime status blob
  // the agent injected — see `taskNotification`): machine context, never a user bubble. A
  // message with a notification MIXED into real content is kept and its blob stripped at
  // render (MessageItem). Everything downstream (data, indicators, count, new-message
  // scroll) keys off this filtered list.
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (m) => !isOnlyTaskNotification(typeof m.content === 'string' ? m.content : '')
      ),
    [messages]
  );

  // onViewableItemsChanged must be a STABLE ref (RN errors if it changes).
  const onMarkReadRef = useRef(onMarkRead);
  onMarkReadRef.current = onMarkRead;
  // Mark-read must be MONOTONIC: a prepend (load-earlier) or a viewability
  // re-measure can transiently surface a LOWER max id; acking it would move the
  // server read marker BACKWARD. Only ever ack a strictly higher id.
  const lastMarkedReadIdRef = useRef(-Infinity);
  const handleViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    let maxId = -Infinity;
    for (const token of viewableItems) {
      const id = Number((token.item as MobileChatMessage)?.id);
      if (Number.isFinite(id) && id > maxId) maxId = id;
    }
    if (Number.isFinite(maxId) && maxId > lastMarkedReadIdRef.current) {
      lastMarkedReadIdRef.current = maxId;
      onMarkReadRef.current?.(maxId);
    }
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;

  // Suppress the follow-the-stream auto-scroll for the ONE content-size change that
  // a load-earlier prepend triggers — otherwise growing the list height yanks the
  // viewport to the bottom, defeating "load earlier". Set on the load-more press,
  // cleared by the next onContentSizeChange (one-shot), with a timeout failsafe so
  // the flag can never leak and permanently kill auto-scroll.
  const suppressScrollRef = useRef(false);

  // Auto-scroll = ALWAYS snap to the bottom when the content GROWS (a new message or a
  // streamed block) — there is deliberately NO near-bottom / "follow only while at the
  // tail" gate. A new message must always return the view to the bottom, even after the
  // user scrolled up. The ONLY condition is the height DELTA:
  //  - `contentHeightRef` — the previous content height. New content GROWS it → scroll to
  //    the bottom. A collapse SHRINKS it → never scroll (the one behaviour kept:
  //    collapsing a section must not yank the viewport). Reference-free, so an in-place
  //    store update that doesn't change height can never latch a stray scroll.
  // (A section EXPAND also grows the content, so on a real device it too snaps to the
  // bottom — an accepted trade-off of "always return to the bottom".)
  const contentHeightRef = useRef(0);

  // When an interactive prompt FIRST appears (footerActive false→true), allow exactly
  // ONE growth-snap so the freshly-mounted prompt (and its shared Submit) is revealed;
  // every later footer-internal growth is then suppressed (see `footerActive`). Tracked
  // with a render-time ref compare (not an effect) so the flag is already set before the
  // async `onContentSizeChange` reads it — an effect can race the native layout callback.
  const prevFooterActiveRef = useRef(false);
  const pendingFooterRevealRef = useRef(false);
  if (footerActive && !prevFooterActiveRef.current) pendingFooterRevealRef.current = true;
  prevFooterActiveRef.current = !!footerActive;

  // Snap to the true bottom, deferred one frame past the layout commit (see
  // `defaultScheduleScroll`) — NON-animated on purpose: opening a chat with history
  // virtualizes (see `initialNumToRender`), so the content height is measured
  // INCREMENTALLY (`onContentSizeChange` fires several times as rows render). An instant
  // jump lands at the true bottom each growth, so the list keeps pinning until it settles
  // (an animated scroll would lag the incremental measurement and strand the list partway
  // — i.e. open at the TOP).
  const scrollToBottom = useCallback(() => {
    scheduleScroll(() => listRef.current?.scrollToEnd({ animated: false }));
  }, [scheduleScroll]);

  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      const grew = height > contentHeightRef.current + CONTENT_GROWTH_EPSILON;
      contentHeightRef.current = height;
      // Load-earlier prepend grows the height too, but must NOT snap to the bottom (one-shot).
      if (suppressScrollRef.current) {
        suppressScrollRef.current = false;
        return;
      }
      if (!grew) return;
      // A pending interactive footer (ask-user form) grows on in-form edits (an "Other"
      // input mounting, the error row) with no stream to follow — snapping to the bottom
      // would yank the just-revealed input off-screen. Allow only the ONE reveal snap when
      // the prompt first appears; a focused input then positions itself (issue #10).
      if (footerActive && !pendingFooterRevealRef.current) return;
      pendingFooterRevealRef.current = false;
      scrollToBottom();
    },
    [scrollToBottom, footerActive]
  );

  // Snap to the bottom the moment a run starts — i.e. the "AI is responding" placeholder
  // (the typing indicator) appears. That indicator lives in the list FOOTER / inline tail,
  // and a state-only change (`isWorking` → true) doesn't always grow the MEASURED content
  // enough to fire `onContentSizeChange`, so without this the placeholder can render just
  // below the fold and the user never sees that the AI started.
  useEffect(() => {
    if (isWorking) scrollToBottom();
  }, [isWorking, scrollToBottom]);

  // Snap to the bottom whenever a NEW message lands at the TAIL — the direct "scroll on a
  // new message" signal, independent of the content-size measurement (which can lag on the
  // New Arch). Keyed on the LAST message's id: a load-earlier PREPEND grows `messages` but
  // does NOT change the tail id, so it never yanks a scrolled-up reader down; a user send,
  // a new assistant turn, or an optimistic→persisted id swap does change it.
  const tailMessageId = visibleMessages[visibleMessages.length - 1]?.id;
  const prevTailIdRef = useRef(tailMessageId);
  useEffect(() => {
    if (tailMessageId !== prevTailIdRef.current) {
      prevTailIdRef.current = tailMessageId;
      scrollToBottom();
    }
  }, [tailMessageId, scrollToBottom]);

  const handleLoadMore = useCallback(() => {
    if (isLoadingMore || !hasMore) return;
    suppressScrollRef.current = true;
    // Failsafe: if no content-size change follows (e.g. the ack revealed nothing),
    // re-enable auto-scroll so a later stream block still sticks to the bottom.
    setTimeout(() => {
      suppressScrollRef.current = false;
    }, 600);
    onLoadMore?.();
  }, [isLoadingMore, hasMore, onLoadMore]);

  // Auto-load earlier history when the user scrolls to the TOP — replacing the old
  // "Load earlier messages" tap (it now triggers automatically). Gated on a REAL
  // user drag (`onScrollBeginDrag`, never fired by the programmatic `scrollToEnd` on
  // open) so opening a chat — which momentarily sits at the top before scrolling to
  // the bottom — never auto-loads a page before the user has scrolled up.
  const userInteractedRef = useRef(false);
  const handleScrollBeginDrag = useCallback(() => {
    userInteractedRef.current = true;
  }, []);
  const handleStartReached = useCallback(() => {
    if (!userInteractedRef.current) return;
    handleLoadMore();
  }, [handleLoadMore]);

  const keyExtractor = useCallback((item: MobileChatMessage, index: number) => {
    if (item.id) return item.id;
    // A stable id keeps a row identity-stable across a load-earlier PREPEND (index
    // shifts otherwise). Buffered/echoed messages always carry an id; only a still-
    // streaming assistant turn is briefly id-less — warn so a regression is visible.
    if (__DEV__ && !warnedMissingMessageId) {
      warnedMissingMessageId = true;
      console.warn('[MessageList] message without a stable id — falling back to index key');
    }
    return `msg-${index}`;
  }, []);

  const lastMessage = visibleMessages[visibleMessages.length - 1];
  // Web `MessageList` parity: the STANDALONE indicator (avatar + badge + dots)
  // shows while the run is active and the agent hasn't started an assistant
  // message yet; once one exists, the inline variant inside it takes over.
  const showStandaloneIndicator = !!isWorking && (!lastMessage || lastMessage.role === 'user');
  // rev12 presence: a terminal turn streams nothing here, so it shows regardless
  // of the last message's role; the local run's indicator always wins.
  const showPcIndicator = !!workingOnPc && !isWorking;

  const renderItem = useCallback(
    ({ item, index }: { item: MobileChatMessage; index: number }) => (
      <MessageItem
        message={item}
        index={index}
        allMessages={visibleMessages}
        agentSetupId={agentSetupId}
        showInlineWorking={
          !!isWorking && index === visibleMessages.length - 1 && item.role === 'assistant'
        }
        status={status}
        agentName={agentName}
        agentColor={agentColor}
        agentSetups={agentSetups}
        onActionClick={onActionClick}
      />
    ),
    [
      visibleMessages,
      agentSetupId,
      isWorking,
      status,
      agentName,
      agentColor,
      agentSetups,
      onActionClick,
    ]
  );

  // Earlier history loads AUTOMATICALLY as the user scrolls to the top (see
  // `handleStartReached` / the FlatList `onStartReached`) — the web `onLoadMore`
  // re-join with a bigger count, but with no tap affordance. The header is therefore
  // just a loading spinner while a load-earlier re-join is in flight.
  const header = isLoadingMore ? (
    <View style={styles.loadEarlierRow}>
      <ActivityIndicator testID="chat-load-earlier-loading" color={theme.colors.primary} />
    </View>
  ) : null;

  const listFooter = (
    <View>
      {showStandaloneIndicator && (
        <TypingIndicator status={status} agentName={agentName} agentColor={agentColor} />
      )}
      {showPcIndicator && (
        <TypingIndicator
          inline
          text="Working locally..."
          agentColor={theme.colors.primary}
          testID="working-on-pc-indicator"
        />
      )}
      {status === 'completed' && !isWorking && (
        <View testID="chat-interrupted-marker" style={styles.hidden} />
      )}
      {error && (
        <View style={styles.footerRow} testID="chat-error">
          <Text style={[styles.errorText, { color: theme.colors.error }]}>{error}</Text>
        </View>
      )}
      {/* Interactive prompt surface (ask-user) — LAST, inside the scroller, so the
          shared Submit is always reachable by scrolling and the prompt's growth
          rides the content-growth auto-scroll (issue #10). */}
      {footer}
    </View>
  );

  return (
    <View ref={containerRef} style={styles.container}>
      {/* Hidden counts: RN FlatList virtualizes (~10 rows under Jest), so list-
          level assertions read these rather than rendered rows. */}
      <Text testID="chat-message-count" style={styles.hidden}>
        {visibleMessages.length}
      </Text>
      <FlatList
        ref={listRef}
        testID="message-list"
        data={visibleMessages}
        // The transcript sits BEHIND the bottom-docked composer's slash-command picker
        // (which opens UP as an overlay). With the default "never", any touch while the
        // keyboard is up makes the list grab it to dismiss the keyboard — preempting the
        // picker panel, so the first tap on an option is eaten (you had to tap twice).
        // "handled" lets a tap the picker captures through; only un-captured taps dismiss.
        keyboardShouldPersistTaps="handled"
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        onScrollBeginDrag={handleScrollBeginDrag}
        // Tracks the live content offset for `scrollFooterInputIntoView` (FlatList
        // has no synchronous offset read).
        onScroll={handleScroll}
        scrollEventThrottle={16}
        onContentSizeChange={handleContentSizeChange}
        onViewableItemsChanged={handleViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        // Auto-load earlier history as the user nears the top (no tap). Guarded by a
        // real user drag (see `handleStartReached`) so a fresh open never auto-loads.
        onStartReached={handleStartReached}
        onStartReachedThreshold={0.5}
        ListHeaderComponent={header}
        ListFooterComponent={listFooter}
        contentContainerStyle={styles.listContent}
        // Virtualization tuning to keep a streamed update cheap (the "VirtualizedList
        // slow to update" warning): render a screenful first, then small per-batch +
        // window so a chunk re-renders few rows. Pairs with the memoized MessageItem,
        // which skips every row whose own message didn't change.
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={11}
        updateCellsBatchingPeriod={50}
        // NB: `maintainVisibleContentPosition` is deliberately NOT set. On RN 0.85 New
        // Arch it anchors the viewport to the RESIZING last message while it streams (and
        // on a new message) and FIGHTS `scrollToEnd`, landing the list at the TOP of the
        // new content instead of its bottom — the "new messages scroll to the top, never
        // reach the end" bug. Without it `scrollToEnd` lands at the true bottom. Load-
        // earlier still does NOT jump to the bottom (the `suppressScrollRef` one-shot); a
        // prepend may shift the viewport — if that needs holding, capture the first-visible
        // index pre-load and `scrollToIndex` to the shifted index, NOT re-add this prop.
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Extra bottom padding so the newest content (and the typing indicator) clears the
  // docked composer instead of sitting flush against it after a snap-to-bottom.
  listContent: { padding: 12, paddingBottom: 24, gap: 8 },
  message: { borderRadius: 12, gap: 6 },
  // Right-aligned column holding the copy button above the user bubble.
  userWrapper: { alignItems: 'flex-end', gap: 4 },
  userAttachments: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end' },
  userAttachmentThumb: { width: 80, height: 80, borderRadius: 8 },
  copyButton: { paddingHorizontal: 4, paddingVertical: 2 },
  // User = accent-soft bubble (web `Message.tsx` parity); assistant = no bubble.
  userMessage: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  assistantMessage: { alignSelf: 'stretch' },
  userText: { fontSize: 13 },
  agentGroup: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 8,
    gap: 6,
  },
  agentHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  agentAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  agentAvatarText: { fontSize: 11, fontWeight: '700' },
  // The middle column takes the row's free width so the name/description truncate
  // (the working dots + count stay pinned right).
  agentTitle: { flex: 1 },
  agentName: { fontWeight: '600' },
  agentTask: { fontSize: 11, marginTop: 1 },
  agentCount: { fontSize: 12 },
  // Web parity: the sub-agent block group's content sits behind a colored left rail.
  agentBody: { borderLeftWidth: 2, paddingLeft: 8, marginLeft: 4, gap: 6 },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  errorText: { fontSize: 13 },
  loadEarlierRow: { alignItems: 'center', paddingVertical: 8 },
  hidden: { height: 0, width: 0, opacity: 0 },
});
