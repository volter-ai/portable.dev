/**
 * ChatDirectoryScreen — the paginated chat list, restyled for visual
 * parity with the native home "Continue chats" cards.
 *
 * Project / Active / Saved / Archived tabs: an underline tab strip. **"Project" is the
 * DEFAULT** (the project-grouped view — the most useful) and "Active" is the same
 * `active`-category data as a flat recency list; "Saved" and "Archived" are the two
 * parallel hide-from-active buckets. Each tab keys its own `useChatDirectory({ category })`
 * query (Project + Active share `'active'`; separate cache keys → instant switch after
 * first load). Rows are **swipeable** ({@link SwipeableChatRow}, reanimated): swipe LEFT to
 * reveal an Archive/Unarchive button + a Delete button. **Long-press** a row opens the
 * {@link ChatActionSheet} (Pin / Save / Archive / Delete). Delete is a REAL backend delete
 * (irreversible) behind a confirmation modal. Pinned chats are highlighted + floated to the
 * top. The `archived` prop seeds the INITIAL tab as Archived (back-compat: the
 * chats tab + tests pass it). Web-parity gaps kept (NOT bugs — see
 * packages/mobile/CLAUDE.md): no Routines tab + no search, and routines do not exist
 * on mobile.
 *
 * The "Project" tab is an outer `FlatList` of project blocks
 * ({@link groupChatsByProject}, most-recently-touched project first). Each block
 * ({@link ProjectGroup}) is a header (owner avatar + repo name + count) over the
 * project's chats in their OWN bounded, internally-scrolling area (~3 visible,
 * recency-sorted, with top/bottom edge fades — the home "Continue chats" preview
 * pattern), so a project's older chats stay tucked behind the fade instead of
 * cluttering one long list. Infinite scroll across projects is preserved —
 * `onEndReached` (and the same "Load more" footer) loads the next page, which folds
 * into the existing groups.
 *
 * The linked-issue badge ({@link ChatCardBody} → {@link LinkedIssueBadge}) is
 * DISPLAY-ONLY here (no `onOpenLinkedIssue`): in the list the only goal is to ENTER
 * the chat, so the whole row press opens the chat — tapping the badge does NOT divert
 * to the issue viewer. (The badge stays tappable in the active-chat header.)
 */

import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ChatCategory, ChatListItem } from '@vgit2/shared/types';

import { ChatCardBody } from '../home/ChatCardBody';
import { Icon, mixColors, useAppTheme, withAlpha } from '../../theme';

import { ChatActionSheet, ChatDeleteConfirmModal } from './ChatActionSheet';
import { groupChatsByProject, type ChatProjectSection } from './groupChatsByProject';
import { SwipeableChatRow } from './SwipeableChatRow';
import { useChatDirectory } from './useChatDirectory';
import { unseenGlowStyle, useChatUnseen } from './useChatUnseen';

export interface ChatDirectoryScreenProps {
  /** Seed the initial tab with the archived list instead of the active list. */
  archived?: boolean;
}

type DirectoryTab = 'project' | 'active' | 'saved' | 'archived';

/** Tab strip labels (the "Project" tab is the project-grouped default view). */
const TAB_LABELS: Record<DirectoryTab, string> = {
  project: 'Project',
  active: 'Active',
  saved: 'Saved',
  archived: 'Archived',
};

/** Tab → the chat category its query filters on (Project + Active share `active`). */
const TAB_CATEGORY: Record<DirectoryTab, ChatCategory> = {
  project: 'active',
  active: 'active',
  saved: 'saved',
  archived: 'archived',
};

/** Width of a single swipe-revealed action button. */
const ACTION_WIDTH = 76;
/** Two actions (archive/unarchive + delete) → total revealed width. */
const ACTIONS_WIDTH = ACTION_WIDTH * 2;

/** Bounded height of a project's internal chat scroll (~3 cards visible). */
const PROJECT_SCROLL_MAX_HEIGHT = 280;
/** Height of the top/bottom edge fades inside a project group. */
const GROUP_FADE_HEIGHT = 18;
/** Slack (px) so a fully-scrolled edge doesn't flicker its fade on/off. */
const GROUP_EDGE_SLACK = 4;

export function ChatDirectoryScreen({ archived = false }: ChatDirectoryScreenProps) {
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();
  // Tabs: "Project" (the project-grouped view of the active chats — the DEFAULT,
  // most-useful view), "Active" (flat recency list), "Archived" (flat). `Project`
  // and `Active` are the same non-archived data, just grouped vs. flat.
  const [tab, setTab] = useState<DirectoryTab>(archived ? 'archived' : 'project');
  const isArchived = tab === 'archived';
  const grouped = tab === 'project';
  const category = TAB_CATEGORY[tab];
  const dir = useChatDirectory({ category });

  // Reload the active list whenever the Chats tab regains focus — chats are
  // created/updated on the PC as well, so a list could be stale (`useChatDirectory`
  // already disables caching with `staleTime: 0`; this covers re-opening the tab while
  // the screen stays mounted). Skip the first focus: the initial mount already fetches.
  const dirRef = useRef(dir);
  dirRef.current = dir;
  const firstFocusRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocusRef.current) {
        firstFocusRef.current = false;
        return;
      }
      dirRef.current.refetch();
    }, [])
  );

  const sections = useMemo(
    () => (grouped ? groupChatsByProject(dir.chats) : []),
    [grouped, dir.chats]
  );

  // The chat queued for deletion — drives the confirmation modal (null = closed).
  const [pendingDelete, setPendingDelete] = useState<ChatListItem | null>(null);
  // The chat whose long-press action sheet is open (null = closed).
  const [actionChat, setActionChat] = useState<ChatListItem | null>(null);

  const confirmDelete = () => {
    if (pendingDelete) dir.remove(pendingDelete.id);
    setPendingDelete(null);
  };

  const renderRow = (item: ChatListItem) => (
    <ChatRow
      item={item}
      archived={isArchived}
      dir={dir}
      onRequestDelete={setPendingDelete}
      onLongPress={setActionChat}
    />
  );

  // Shared list chrome (reused by both the flat FlatList and the grouped SectionList).
  const listFooter = dir.hasMore ? (
    <Pressable
      testID="chat-directory-load-more"
      style={styles.loadMore}
      onPress={dir.loadMore}
      disabled={dir.isFetchingMore}
    >
      <Text style={[styles.loadMoreText, { color: theme.colors.textSecondary }]}>
        {dir.isFetchingMore ? 'Loading…' : 'Load more'}
      </Text>
    </Pressable>
  ) : null;

  const listEmpty = (
    <View style={styles.center}>
      <Text style={[styles.empty, { color: theme.colors.textSecondary }]}>
        {tab === 'archived'
          ? 'No archived chats'
          : tab === 'saved'
            ? 'No saved chats'
            : 'No chats yet'}
      </Text>
      {tab === 'saved' ? (
        <Text style={[styles.emptyHint, { color: theme.colors.textTertiary }]}>
          Long-press a chat and choose Save to keep it here for later.
        </Text>
      ) : tab !== 'archived' ? (
        <Text style={[styles.emptyHint, { color: theme.colors.textTertiary }]}>
          Start a new conversation!
        </Text>
      ) : null}
    </View>
  );

  // Pull-to-refresh — shared by both FlatLists (mirrors the Home page pattern).
  const refreshControl = (
    <RefreshControl
      refreshing={dir.isRefetching}
      onRefresh={dir.refetch}
      tintColor={theme.colors.primary}
    />
  );

  return (
    <View
      style={[
        styles.container,
        { paddingTop: insets.top + 8, backgroundColor: theme.colors.background },
      ]}
      testID="chat-directory"
    >
      <View style={styles.headerRow}>
        <Text style={[styles.heading, { color: theme.colors.text }]}>Chats</Text>
      </View>

      <View style={[styles.tabBar, { borderBottomColor: theme.colors.border }]}>
        {(['project', 'active', 'saved', 'archived'] as const).map((t) => {
          const active = tab === t;
          return (
            <Pressable
              key={t}
              testID={`chat-tab-${t}`}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => setTab(t)}
              style={[
                styles.tab,
                { borderBottomColor: active ? theme.colors.primary : 'transparent' },
              ]}
            >
              <Text
                style={[
                  styles.tabText,
                  active
                    ? { color: theme.colors.text, fontWeight: '600' }
                    : { color: theme.colors.textTertiary },
                ]}
              >
                {TAB_LABELS[t]}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.count} testID="chat-directory-count">
        {dir.chats.length}
      </Text>

      {dir.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.primary} testID="chat-directory-loading" />
          <Text style={[styles.muted, { color: theme.colors.textSecondary }]}>Loading chats…</Text>
        </View>
      ) : grouped ? (
        // "By project": each group is its OWN self-contained, internally-scrolling
        // area (~3 chats visible, recency-sorted, with edge fades) — like the home
        // "Continue chats" preview — so a project's older chats stay tucked away
        // instead of cluttering one long flat list.
        <FlatList
          testID="chat-directory-list"
          data={sections}
          keyExtractor={(s) => s.key}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.groupedContent, { paddingBottom: insets.bottom + 16 }]}
          renderItem={({ item }) => <ProjectGroup section={item} renderRow={renderRow} />}
          onEndReached={dir.loadMore}
          onEndReachedThreshold={0.5}
          refreshControl={refreshControl}
          ListEmptyComponent={listEmpty}
          ListFooterComponent={listFooter}
        />
      ) : (
        <FlatList
          testID="chat-directory-list"
          data={dir.chats}
          keyExtractor={(c) => c.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 16 }]}
          renderItem={({ item }) => renderRow(item)}
          refreshControl={refreshControl}
          ListEmptyComponent={listEmpty}
          ListFooterComponent={listFooter}
        />
      )}

      <ChatDeleteConfirmModal
        chat={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />

      <ChatActionSheet
        chat={actionChat}
        onClose={() => setActionChat(null)}
        onPin={(id, pinned) => {
          dir.setPinned(id, pinned);
          setActionChat(null);
        }}
        onSave={(id, save) => {
          if (save) dir.save(id);
          else dir.unsave(id);
          setActionChat(null);
        }}
        onArchive={(id, archive) => {
          if (archive) dir.archive(id);
          else dir.unarchive(id);
          setActionChat(null);
        }}
        onDelete={(chat) => {
          setActionChat(null);
          setPendingDelete(chat);
        }}
      />
    </View>
  );
}

function ChatRow({
  item,
  archived,
  dir,
  onRequestDelete,
  onLongPress,
}: {
  item: ChatListItem;
  archived: boolean;
  dir: ReturnType<typeof useChatDirectory>;
  onRequestDelete: (chat: ChatListItem) => void;
  onLongPress: (chat: ChatListItem) => void;
}) {
  const { theme } = useAppTheme();
  const unseen = useChatUnseen(item);

  return (
    <SwipeableChatRow
      testID={`chat-row-${item.id}`}
      swipeTestID={`chat-swipe-${item.id}`}
      actionsWidth={ACTIONS_WIDTH}
      borderRadius={8}
      actions={
        <>
          {archived ? (
            <Pressable
              testID={`chat-unarchive-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel="Unarchive chat"
              style={[
                styles.swipeAction,
                { width: ACTION_WIDTH, backgroundColor: theme.colors.info },
              ]}
              onPress={() => dir.unarchive(item.id)}
            >
              <Icon name="refresh" size={18} color="#fff" />
              <Text style={styles.swipeActionLabel}>Unarchive</Text>
            </Pressable>
          ) : (
            <Pressable
              testID={`chat-archive-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel="Archive chat"
              style={[
                styles.swipeAction,
                { width: ACTION_WIDTH, backgroundColor: theme.colors.primary },
              ]}
              onPress={() => dir.archive(item.id)}
            >
              <Icon name="archive" size={18} color="#fff" />
              <Text style={styles.swipeActionLabel}>Archive</Text>
            </Pressable>
          )}
          <Pressable
            testID={`chat-delete-${item.id}`}
            accessibilityRole="button"
            accessibilityLabel="Delete chat"
            style={[
              styles.swipeAction,
              { width: ACTION_WIDTH, backgroundColor: theme.colors.danger },
            ]}
            onPress={() => onRequestDelete(item)}
          >
            <Icon name="trash" size={18} color="#fff" />
            <Text style={styles.swipeActionLabel}>Delete</Text>
          </Pressable>
        </>
      }
    >
      <Pressable
        style={[
          styles.card,
          {
            // Pinned chats are highlighted: a primary-tinted border + faint primary
            // wash (+ the pin glyph + stronger title color from ChatCardBody). The
            // wash is an OPAQUE blend — translucent and the swipe actions behind
            // the card bleed through its right edge.
            backgroundColor: item.pinned
              ? mixColors(theme.colors.surface, theme.colors.primary, 0.08)
              : theme.colors.surface,
            borderColor: item.pinned ? theme.colors.primary : theme.colors.border,
          },
          // A changed-but-not-yet-opened chat gets the orange glow, layered over the
          // base/pinned style (border + wash carry it where the swipe row clips).
          unseen ? unseenGlowStyle(theme) : null,
        ]}
        testID={`chat-open-${item.id}`}
        accessibilityRole="button"
        onPress={() => dir.openChat(item.id)}
        onLongPress={() => onLongPress(item)}
        delayLongPress={300}
      >
        <View style={styles.cardMain}>
          <ChatCardBody chat={item} />
        </View>
      </Pressable>
    </SwipeableChatRow>
  );
}

/**
 * A self-contained project group (the "By project" view): the header above the
 * project's chats in their OWN bounded, internally-scrolling area (recency-sorted,
 * ~3 visible) with top/bottom edge fades — the home "Continue chats" preview
 * pattern. Keeps a project's older chats tucked behind the fade instead of flooding
 * one long flat list. `groupChatsByProject` already orders the chats newest-first.
 */
function ProjectGroup({
  section,
  renderRow,
}: {
  section: ChatProjectSection;
  renderRow: (item: ChatListItem) => React.ReactElement;
}) {
  const { theme } = useAppTheme();
  // Live scroll metrics drive the boundary fades (the "more above/below" cue).
  const [scrollY, setScrollY] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [contentH, setContentH] = useState(0);

  const scrollable = contentH > viewportH + GROUP_EDGE_SLACK;
  const showTopFade = scrollable && scrollY > GROUP_EDGE_SLACK;
  const showBottomFade = scrollable && contentH - viewportH - scrollY > GROUP_EDGE_SLACK;

  const bg = theme.colors.background;
  const transparentBg = withAlpha(bg, '00');

  return (
    <View style={styles.group}>
      <ProjectHeader section={section} />

      <View style={styles.groupScrollFrame}>
        <ScrollView
          testID={`chat-project-scroll-${section.key}`}
          style={{ maxHeight: PROJECT_SCROLL_MAX_HEIGHT }}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
          // No rubber-band when a project's chats fit; real internal scroll when not.
          alwaysBounceVertical={false}
          scrollEventThrottle={16}
          onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) =>
            setScrollY(e.nativeEvent.contentOffset.y)
          }
          onLayout={(e: LayoutChangeEvent) => setViewportH(e.nativeEvent.layout.height)}
          onContentSizeChange={(_w, h) => setContentH(h)}
          contentContainerStyle={styles.groupList}
        >
          {section.chats.map((chat) => (
            <View key={chat.id}>{renderRow(chat)}</View>
          ))}
        </ScrollView>

        {showTopFade ? (
          <LinearGradient
            pointerEvents="none"
            colors={[bg, transparentBg]}
            style={[styles.groupFade, styles.groupFadeTop]}
          />
        ) : null}
        {showBottomFade ? (
          <LinearGradient
            pointerEvents="none"
            colors={[transparentBg, bg]}
            style={[styles.groupFade, styles.groupFadeBottom]}
          />
        ) : null}
      </View>
    </View>
  );
}

/** A project group header (the "By project" view): the HR divider + repo label. */
function ProjectHeader({ section }: { section: ChatProjectSection }) {
  const { theme } = useAppTheme();
  return (
    <View
      testID={`chat-project-header-${section.key}`}
      style={[
        styles.sectionHeader,
        { backgroundColor: theme.colors.background, borderTopColor: theme.colors.border },
      ]}
    >
      {section.owner ? (
        <Image
          source={{ uri: `https://github.com/${section.owner}.png?size=32` }}
          style={styles.sectionAvatar}
        />
      ) : (
        <Icon name="folder" size={14} color={theme.colors.textTertiary} />
      )}
      <Text style={[styles.sectionLabel, { color: theme.colors.text }]} numberOfLines={1}>
        {section.label}
      </Text>
      <Text style={[styles.sectionCount, { color: theme.colors.textTertiary }]}>
        {section.chats.length}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 8,
  },
  heading: { fontSize: 24, fontWeight: '700' },
  // "By project" view: each group is a block (header + its own bounded scroll).
  groupedContent: { paddingTop: 8 },
  group: { marginBottom: 12 },
  groupScrollFrame: { position: 'relative', marginTop: 4 },
  groupList: { gap: 8, paddingVertical: 2 },
  groupFade: { position: 'absolute', left: 0, right: 0, height: GROUP_FADE_HEIGHT },
  groupFadeTop: { top: 0 },
  groupFadeBottom: { bottom: 0 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 12,
    paddingBottom: 6,
    paddingHorizontal: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sectionAvatar: { width: 18, height: 18, borderRadius: 9 },
  sectionLabel: { fontSize: 14, fontWeight: '700', flex: 1, minWidth: 0 },
  sectionCount: { fontSize: 12, fontWeight: '600' },
  tabBar: { flexDirection: 'row', borderBottomWidth: 1, marginBottom: 4 },
  tab: { paddingVertical: 10, marginRight: 24, borderBottomWidth: 2 },
  tabText: { fontSize: 15 },
  count: { fontSize: 12, opacity: 0, height: 0 },
  center: { paddingVertical: 32, alignItems: 'center', gap: 6 },
  muted: { fontSize: 14 },
  empty: { fontSize: 15, textAlign: 'center' },
  emptyHint: { fontSize: 13, textAlign: 'center' },
  hidden: { height: 0, width: 0, opacity: 0 },
  listContent: { gap: 8, paddingTop: 8 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 8,
  },
  cardMain: { flex: 1, gap: 4, minWidth: 0 },
  swipeAction: { alignItems: 'center', justifyContent: 'center', gap: 4 },
  swipeActionLabel: { color: '#fff', fontSize: 11, fontWeight: '600' },
  loadMore: { padding: 16, alignItems: 'center' },
  loadMoreText: { fontSize: 13, fontWeight: '500' },
});
