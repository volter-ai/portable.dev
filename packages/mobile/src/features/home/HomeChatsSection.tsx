/**
 * HomeChatsSection — the home "Continue chats" preview. A small uppercase header
 * with a "See more" link, then the
 * recent chats as compact cards (the shared {@link ChatCardBody}: title/first-message,
 * last-message preview, repo tag + relative timestamp).
 *
 * The card list lives in a SELF-CONTAINED, internally-scrolling area (a bounded-height
 * `ScrollView`, `nestedScrollEnabled`): scrolling the chats scrolls only this area, NOT
 * the home page. Top/bottom gradient fades appear at the scroll boundaries (the standard
 * "there's more above/below" affordance), driven by the live scroll offset. When the
 * chats fit within the bound the area sizes to content and the fades stay hidden.
 *
 * Renders nothing when there are no chats.
 */

import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  type RefreshControlProps,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import type { ChatListItem } from '@vgit2/shared/types';

import { ChatCardBody } from './ChatCardBody';
import { unseenGlowStyle, useChatUnseen } from '../chat/useChatUnseen';
import { useAppTheme, withAlpha } from '../../theme';

export interface HomeChatsSectionProps {
  chats: ChatListItem[];
  onChatPress: (chatId: string) => void;
  /**
   * Long-press a chat card → the shared Pin/Save/Archive/Delete action sheet (the
   * SAME menu as the `/chats` directory). Wire it to `useChatActionSheet().open` so
   * every chat-preview list shares the behavior; omit it to disable long-press.
   */
  onChatLongPress?: (chat: ChatListItem) => void;
  onSeeMore: () => void;
  /**
   * FILL mode (the anchored home page): the section flexes to fill the remaining
   * vertical space and its card list scrolls internally — instead of the bounded
   * max-height used when it's just one item in a larger scroll. In fill mode the
   * scroll frame renders even with no chats so {@link refreshControl} stays usable.
   */
  fill?: boolean;
  /** Pull-to-refresh control attached to the contained scroll area (fill mode). */
  refreshControl?: React.ReactElement<RefreshControlProps>;
  /**
   * True while the chats query is still loading its FIRST page (no chats yet) →
   * show a centred spinner instead of a blank area (mirrors {@link HomeReposGrid}'s
   * `loading`). Ignored once there are chats to render.
   */
  loading?: boolean;
}

/** Upper bound for the contained scroll area (~3 cards visible; the rest scroll). */
const SCROLL_MAX_HEIGHT = 300;
/** Floor so the area is never uselessly short on small screens. */
const SCROLL_MIN_HEIGHT = 200;
/** Fraction of the window height the contained area may occupy (responsive cap). */
const SCROLL_HEIGHT_FRACTION = 0.42;
/** Height of the top/bottom edge fade overlays (kept subtle). */
const FADE_HEIGHT = 20;
/** Slack (px) so a fully-scrolled edge doesn't flicker its fade on/off. */
const EDGE_SLACK = 4;

export function HomeChatsSection({
  chats,
  onChatPress,
  onChatLongPress,
  onSeeMore,
  fill = false,
  refreshControl,
  loading = false,
}: HomeChatsSectionProps) {
  const { theme } = useAppTheme();
  const { height: windowHeight } = useWindowDimensions();
  // Live scroll metrics drive the boundary fades.
  const [scrollY, setScrollY] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [contentH, setContentH] = useState(0);

  const hasChats = chats.length > 0;

  // First-load: no chats yet but the query is in flight → a centred spinner instead
  // of a blank area (the HomeReposGrid `loading` pattern). Takes precedence over both
  // the bounded "render nothing" contract and the fill-mode empty scroll frame.
  if (loading && !hasChats) {
    return (
      <View style={[styles.wrap, fill && styles.wrapFill]} testID="home-recent-chats">
        <View style={[styles.loading, fill && styles.wrapFill]} testID="home-chats-loading">
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  // Bounded (non-fill) mode keeps the original contract: render nothing with no chats.
  // Fill mode still renders the (empty) scroll frame so pull-to-refresh stays usable.
  if (!fill && !hasChats) return null;

  // Responsive cap: a fraction of the screen, clamped to [MIN, MAX]. The ScrollView
  // sizes to its content up to this — so a few chats render short (no scroll), and a
  // full list caps here and scrolls internally.
  const maxHeight = Math.max(
    SCROLL_MIN_HEIGHT,
    Math.min(SCROLL_MAX_HEIGHT, Math.round(windowHeight * SCROLL_HEIGHT_FRACTION))
  );

  const scrollable = contentH > viewportH + EDGE_SLACK;
  const showTopFade = scrollable && scrollY > EDGE_SLACK;
  // Subtle "more below" fade at the bottom edge (which, in fill mode, sits right at
  // the tab bar). It auto-clears once fully scrolled, so the last card stays readable.
  const showBottomFade = scrollable && contentH - viewportH - scrollY > EDGE_SLACK;

  // Opaque page bg → transparent: fades the cards out at the boundary.
  const bg = theme.colors.background;
  const transparentBg = withAlpha(bg, '00');

  return (
    <View style={[styles.wrap, fill && styles.wrapFill]} testID="home-recent-chats">
      {hasChats ? (
        <View style={styles.header}>
          <Text style={[styles.headerLabel, { color: theme.colors.textSecondary }]}>
            Continue chats
          </Text>
          <Pressable testID="chat-home-directory" onPress={onSeeMore} hitSlop={8}>
            <Text style={[styles.seeMore, { color: theme.colors.primary }]}>See more</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={[styles.scrollFrame, fill && styles.scrollFrameFill]}>
        <ScrollView
          testID="home-chats-scroll"
          style={fill ? styles.scrollFill : { maxHeight }}
          refreshControl={refreshControl}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
          // No rubber-band when the chats fit; real internal scroll when they don't.
          alwaysBounceVertical={false}
          scrollEventThrottle={16}
          onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) =>
            setScrollY(e.nativeEvent.contentOffset.y)
          }
          onLayout={(e: LayoutChangeEvent) => setViewportH(e.nativeEvent.layout.height)}
          onContentSizeChange={(_w, h) => setContentH(h)}
          contentContainerStyle={[styles.list, fill && styles.listFill]}
        >
          {chats.map((chat) => (
            <HomeChatItem
              key={chat.id}
              chat={chat}
              onPress={() => onChatPress(chat.id)}
              onLongPress={onChatLongPress ? () => onChatLongPress(chat) : undefined}
            />
          ))}
        </ScrollView>

        {showTopFade ? (
          <LinearGradient
            testID="home-chats-fade-top"
            pointerEvents="none"
            colors={[bg, transparentBg]}
            style={[styles.fade, styles.fadeTop]}
          />
        ) : null}
        {showBottomFade ? (
          <LinearGradient
            testID="home-chats-fade-bottom"
            pointerEvents="none"
            colors={[transparentBg, bg]}
            style={[styles.fade, styles.fadeBottom]}
          />
        ) : null}
      </View>
    </View>
  );
}

function HomeChatItem({
  chat,
  onPress,
  onLongPress,
}: {
  chat: ChatListItem;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const { theme } = useAppTheme();
  const unseen = useChatUnseen(chat);

  return (
    <Pressable
      testID={`home-chat-${chat.id}`}
      accessibilityRole="button"
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={300}
      style={({ pressed }) => [
        styles.item,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          opacity: pressed ? 0.85 : 1,
        },
        // Orange glow for a changed-but-not-yet-opened chat (the un-clipped home/repo
        // card shows the full colored-shadow halo).
        unseen ? unseenGlowStyle(theme) : null,
      ]}
    >
      <ChatCardBody chat={chat} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', gap: 12 },
  // Fill mode: take the remaining vertical space so the card list scrolls internally
  // and the page above it stays anchored.
  wrapFill: { flex: 1 },
  scrollFrameFill: { flex: 1 },
  scrollFill: { flex: 1 },
  // Breathing room so the last card sits clear of the page bottom (fill mode).
  listFill: { paddingBottom: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  seeMore: { fontSize: 12, fontWeight: '500', paddingHorizontal: 8, paddingVertical: 4 },
  // Centred first-load spinner (mirrors HomeReposGrid.loading).
  loading: { minHeight: 120, alignItems: 'center', justifyContent: 'center' },
  scrollFrame: { position: 'relative' },
  list: { gap: 8 },
  item: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 4,
  },
  fade: { position: 'absolute', left: 0, right: 0, height: FADE_HEIGHT },
  fadeTop: { top: 0 },
  fadeBottom: { bottom: 0 },
});
