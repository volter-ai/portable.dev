/**
 * HomeReposGrid — the home "recent repos" strip.
 *
 * A SINGLE-ROW, horizontally-scrolling rail of {@link RepoCard}s. The synthetic
 * {@link NewProjectCard} "＋ New" tile is PINNED to the first (left) position and
 * stays superimposed there as the repos scroll past underneath it (an opaque
 * page-bg backing makes the cards vanish cleanly behind it). Edge fades signal
 * that there's more off-screen — a subtle one just right of "New" as cards slide
 * under it, and the main one on the right so the last card is half-visible and
 * fades out, making the horizontal-scroll affordance obvious. A "Portable Projects"
 * header (label + "See more", aligned identically to the HomeChatsSection header)
 * sits above it.
 *
 * The single-row height (vs. the old 4×2 paged grid that could occupy two grid
 * rows) frees vertical space for the "Continue chats" area below.
 *
 * Renders a spinner while loading, and nothing only when there are no repos AND no
 * new-project tile.
 */

import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { RepositoryWithLocal } from '@vgit2/shared/types';

import { NewProjectCard } from './NewProjectCard';
import { RepoCard } from './RepoCard';
import { useAppTheme, withAlpha } from '../../theme';

export interface HomeReposGridProps {
  repos: RepositoryWithLocal[];
  loading?: boolean;
  /** Section header label. */
  label?: string;
  onRepoPress: (owner: string, repo: string) => void;
  /** "See more" → the full Repos tab. Omitted ⇒ no See-more link. */
  onSeeMore?: () => void;
  /** Create a new Portable project. When provided, the pinned "＋ New" tile is
   * shown at the FRONT of the rail (and the section renders even with no repos). */
  onNewProject?: () => void;
}

/** Width of a single repo / new-project slot (RepoCard centres a 60px tile). */
const ITEM_WIDTH = 64;
/** Gap between rail items. */
const GAP = 16;
/** Single-row rail height: tile (60) + card gap + a 2-line name. */
const ROW_HEIGHT = 104;
/** Width of the right-edge fade overlay. */
const FADE_WIDTH = 40;
/** Slack (px) so a fully-scrolled edge doesn't flicker its fade on/off. */
const EDGE_SLACK = 4;

export function HomeReposGrid({
  repos,
  loading = false,
  label = 'Portable Projects',
  onRepoPress,
  onSeeMore,
  onNewProject,
}: HomeReposGridProps) {
  const { theme } = useAppTheme();
  // Live scroll metrics drive the edge fades (the "more off-screen" affordance).
  const [scrollX, setScrollX] = useState(0);
  const [viewportW, setViewportW] = useState(0);
  const [contentW, setContentW] = useState(0);

  if (loading) {
    return (
      <View style={styles.loading} testID="home-repos-loading">
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }
  // Nothing to show unless there's at least one repo OR the new-project tile.
  if (repos.length === 0 && !onNewProject) return null;

  // The pinned "New" tile reserves the leftmost slot (one item width + the inter-item
  // gap); the first repo keeps its original position to "New"'s right and scrolls
  // under it. Keeping the lead tight preserves the right-edge peek of the next card.
  const leadInset = onNewProject ? ITEM_WIDTH + GAP : 0;

  const scrollable = contentW > viewportW + EDGE_SLACK;
  // Cards sliding left under the pinned "New" tile dissolve into the page (matching
  // the chats-section fade aesthetic). The gradient lives in the lead gap, so it
  // never washes a RESTING tile, and "New" (opaque) is drawn ON TOP of it.
  const showLeftFade = !!onNewProject && scrollable && scrollX > EDGE_SLACK;
  // More cards to the right — the rightmost one half-fades to make scrolling obvious.
  const showRightFade = scrollable && contentW - viewportW - scrollX > EDGE_SLACK;

  const bg = theme.colors.background;
  const transparentBg = withAlpha(bg, '00');

  return (
    <View
      style={styles.wrap}
      onLayout={(e: LayoutChangeEvent) => setViewportW(e.nativeEvent.layout.width)}
      testID="home-recent-repos"
    >
      {/* Header — mirrors the HomeChatsSection "Continue chats" header exactly. */}
      <View style={styles.header}>
        <Text style={[styles.headerLabel, { color: theme.colors.textSecondary }]}>{label}</Text>
        {onSeeMore ? (
          <Pressable testID="home-repos-see-more" onPress={onSeeMore} hitSlop={8}>
            <Text style={[styles.seeMore, { color: theme.colors.primary }]}>See more</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.rail}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          // Also hide the VERTICAL indicator: a 2-line repo name can exceed ROW_HEIGHT,
          // and a horizontal ScrollView otherwise shows a stray vertical scrollbar.
          showsVerticalScrollIndicator={false}
          alwaysBounceHorizontal={false}
          scrollEventThrottle={16}
          onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) =>
            setScrollX(e.nativeEvent.contentOffset.x)
          }
          onContentSizeChange={(w) => setContentW(w)}
          contentContainerStyle={[
            styles.railContent,
            // Clear the pinned "New" slot so the first repo starts to its right,
            // and leave room on the right so the last card can scroll past the fade.
            { paddingLeft: leadInset, paddingRight: FADE_WIDTH },
          ]}
        >
          {repos.map((repo) => (
            <View key={repo.full_name} style={styles.cell}>
              <RepoCard repo={repo} onPress={onRepoPress} />
            </View>
          ))}
        </ScrollView>

        {/* Right-edge fade — the primary "scrolls horizontally" cue. */}
        {showRightFade ? (
          <LinearGradient
            testID="home-repos-fade-right"
            pointerEvents="none"
            colors={[transparentBg, bg]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={[styles.fade, styles.fadeRight]}
          />
        ) : null}

        {/* Left fade — cards dissolve into the page as they slide under "New". A
            narrow gradient in the lead gap, tucking ~8px under "New" (drawn over it)
            and ending exactly at the first repo, so it never touches a resting tile. */}
        {showLeftFade ? (
          <LinearGradient
            testID="home-repos-fade-left"
            pointerEvents="none"
            colors={[bg, transparentBg]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={[styles.fade, { left: ITEM_WIDTH - 8, width: GAP + 8 }]}
          />
        ) : null}

        {/* The pinned "＋ New" tile — superimposed at the front (over the left fade),
            opaque page-bg backing so repos vanish cleanly behind it as they scroll. */}
        {onNewProject ? (
          <View style={[styles.pinned, { backgroundColor: bg }]}>
            <NewProjectCard onPress={onNewProject} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', gap: 12 },
  // Header styles are COPIED from HomeChatsSection so the two section headers
  // ("Portable Projects" / "Continue chats") align identically.
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  seeMore: { fontSize: 12, fontWeight: '500', paddingHorizontal: 8, paddingVertical: 4 },
  loading: { minHeight: 120, alignItems: 'center', justifyContent: 'center' },
  // Single-row rail (replaces the old two-row paged grid).
  rail: { height: ROW_HEIGHT, position: 'relative' },
  railContent: { gap: GAP, alignItems: 'flex-start' },
  cell: { width: ITEM_WIDTH },
  fade: { position: 'absolute', top: 0, bottom: 0, width: FADE_WIDTH },
  fadeRight: { right: 0 },
  // The pinned "New" tile column, anchored to the left edge over the scroll rail.
  pinned: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: ITEM_WIDTH,
    justifyContent: 'flex-start',
  },
});
