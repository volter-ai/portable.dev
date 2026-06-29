/**
 * RepoCard — a single repo tile in the home "recent repos" grid. A 60px rounded
 * icon tile (site favicon → owner
 * avatar → gradient monogram fallback), overlaid status badges (not-cloned cloud,
 * ahead/behind arrows), and the repo name beneath, shrinking with its length.
 * Press → the repo detail route.
 */

import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import type { RepositoryWithLocal } from '@vgit2/shared/types';

import { repoNameFontSize } from './homeHelpers';
import { faviconUrl } from '../chat/frameworks';
import { Icon, useAppTheme } from '../../theme';

export interface RepoCardProps {
  repo: RepositoryWithLocal;
  onPress: (owner: string, repo: string) => void;
}

const AHEAD_COLOR = '#FF9500';
const BEHIND_COLOR = '#FF3B30';

/** Resolve the ordered image sources: favicon (if a homepage), then owner avatar. */
function imageSources(repo: RepositoryWithLocal): string[] {
  const sources: string[] = [];
  if (repo.homepage) sources.push(faviconUrl(repo.homepage));
  if (repo.owner?.avatar_url) sources.push(repo.owner.avatar_url);
  return sources;
}

export function RepoCard({ repo, onPress }: RepoCardProps) {
  const { theme } = useAppTheme();
  const [sourceIndex, setSourceIndex] = useState(0);

  const sources = imageSources(repo);
  const uri = sources[sourceIndex];
  const showMonogram = !uri; // exhausted all sources → gradient monogram

  const [owner, repoName] = repo.full_name.split('/');
  const ahead = repo.gitStatus?.ahead ?? 0;
  const behind = repo.gitStatus?.behind ?? 0;
  const nameSize = repoNameFontSize((repo.name || '').length);

  return (
    <Pressable
      testID={`home-repo-${repo.full_name}`}
      accessibilityRole="button"
      onPress={() => owner && repoName && onPress(owner, repoName)}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.iconFrame}>
        <View style={[styles.tile, { backgroundColor: theme.colors.surface }, theme.shadows.sm]}>
          {showMonogram ? (
            <LinearGradient
              colors={[theme.colors.primary, theme.colors.primaryDark]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.monogram}
            >
              <Text style={styles.monogramText}>{(repo.name || '?').charAt(0).toUpperCase()}</Text>
            </LinearGradient>
          ) : (
            <Image
              source={{ uri }}
              onError={() => setSourceIndex((i) => i + 1)}
              style={styles.tileImage}
              resizeMode="cover"
            />
          )}

          {repo.isLocal === false ? (
            <View style={styles.cloudBadge}>
              <Icon name="download" size={11} color="#FFFFFF" strokeWidth={2.4} />
            </View>
          ) : null}
        </View>

        {repo.hasUnpushedChanges && ahead > 0 ? (
          <View style={[styles.countBadge, styles.aheadBadge, { backgroundColor: AHEAD_COLOR }]}>
            <Icon name="arrow-up" size={7} color="#FFFFFF" strokeWidth={3} />
            <Text style={styles.countText}>{ahead > 99 ? '99+' : ahead}</Text>
          </View>
        ) : null}
        {repo.hasUnpulledChanges && behind > 0 ? (
          <View style={[styles.countBadge, styles.behindBadge, { backgroundColor: BEHIND_COLOR }]}>
            <Icon name="arrow-down" size={7} color="#FFFFFF" strokeWidth={3} />
            <Text style={styles.countText}>{behind > 99 ? '99+' : behind}</Text>
          </View>
        ) : null}
      </View>

      <Text
        numberOfLines={2}
        style={[
          styles.name,
          {
            color: theme.colors.text,
            fontSize: nameSize,
            lineHeight: Math.round(nameSize * 1.15),
            minHeight: Math.round(nameSize * 1.8),
          },
        ]}
      >
        {repo.name}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { alignItems: 'center', gap: 6, paddingVertical: 2 },
  // Press feedback is scale-only (no opacity dim).
  cardPressed: { transform: [{ scale: 0.95 }] },
  // The square is enforced on the TILE, not the frame: Yoga resolves `aspectRatio`
  // from the pre-clamp `width: '100%'`, so combining it with `maxWidth` on the same
  // node renders a rectangle once the cell is wider than the clamp. The
  // frame only clamps the width; the child tile derives its height from the
  // clamped result — always 1:1.
  iconFrame: {
    width: '100%',
    maxWidth: 60,
  },
  tile: { width: '100%', aspectRatio: 1, borderRadius: 12, overflow: 'hidden' },
  tileImage: { width: '100%', height: '100%' },
  monogram: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  monogramText: { color: '#FFFFFF', fontSize: 24, fontWeight: '600' },
  // Drop-shadow keeps the white download glyph legible over a light favicon.
  cloudBadge: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
    elevation: 2,
  },
  countBadge: {
    position: 'absolute',
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    paddingHorizontal: 3,
    zIndex: 2,
    // Badges lift off the tile: boxShadow 0 2px 4px rgba(0,0,0,0.2).
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 2,
  },
  aheadBadge: { top: -6, right: -6 },
  behindBadge: { top: -6, left: -6 },
  countText: { color: '#FFFFFF', fontSize: 9.6, fontWeight: '600', lineHeight: 11 },
  name: {
    textAlign: 'center',
    fontWeight: '700',
    letterSpacing: -0.1,
    paddingHorizontal: 2,
  },
});
