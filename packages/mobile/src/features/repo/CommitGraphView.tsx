/**
 * CommitGraphView — the headline multi-lane commit graph (portable.dev#17).
 *
 * Renders the source-control Graph segment: a colored multi-lane DAG drawn with
 * `react-native-svg` in a fixed-width left gutter, with ref badges + subject +
 * author + relative date + 7-char short SHA to the right. Each row is a >=44pt
 * touch target that pushes the commit-detail screen.
 *
 * Thin view over {@link useCommitGraph}: the lane layout ({@link computeCommitLanes})
 * is recomputed as pages load, and the list is virtualized (a `FlatList`), so a
 * deep history stays smooth.
 *
 * Lane overflow: the gutter caps at {@link MAX_VISIBLE_LANES} lanes and columns
 * beyond the cap clamp to the last visible position — the message text is in a
 * separate flex column and is NEVER squeezed by extra lanes.
 */

import { useMemo } from 'react';
import { router } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import type { CommitGraphNode, CommitRef } from '@vgit2/shared/types';

import { useAppTheme, withAlpha } from '../../theme';
import { laneColor, type LaneRow } from './commitLanes';
import { usePullToRefresh } from './sourceControlRefresh';
import { useCommitGraph } from './useCommitGraph';

/** Lane gutter geometry. */
export const LANE_WIDTH = 16;
const ROW_HEIGHT = 60;
const DOT_RADIUS = 4.5;
/** Cap visible lanes (the AC's ~8) — extra lanes clamp to the last column. */
export const MAX_VISIBLE_LANES = 8;

export interface CommitGraphViewProps {
  owner: string;
  repo: string;
  /** Gate the underlying graph read (the tab passes `segment === 'graph'`). */
  enabled?: boolean;
  /** Navigation seam (default: push the commit-detail route). Injectable for tests. */
  onSelectCommit?: (node: CommitGraphNode) => void;
}

/** Lane center x for a column, clamped to the visible gutter. */
function laneX(column: number): number {
  const clamped = Math.min(column, MAX_VISIBLE_LANES - 1);
  return LANE_WIDTH / 2 + clamped * LANE_WIDTH;
}

/** A short, human relative date from an ISO string. */
export function relativeCommitDate(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

export function CommitGraphView({
  owner,
  repo,
  enabled = true,
  onSelectCommit,
}: CommitGraphViewProps) {
  const { theme } = useAppTheme();
  const vm = useCommitGraph(owner, repo, { enabled });
  const pull = usePullToRefresh(vm.refetch);

  // One RefreshControl serves every non-loading branch — the PC commits
  // out-of-band, so even an empty/errored graph must be pullable.
  const refreshControl = (
    <RefreshControl
      testID="commit-graph-refresh"
      refreshing={pull.refreshing}
      onRefresh={pull.onRefresh}
      tintColor={theme.colors.primary}
      colors={[theme.colors.primary]}
    />
  );

  const select =
    onSelectCommit ??
    ((node: CommitGraphNode) =>
      router.push({
        pathname: '/repos/[owner]/[repo]/commit',
        params: { owner, repo, sha: node.sha },
      }));

  const gutterWidth = useMemo(() => {
    let max = 0;
    for (const row of vm.lanes) {
      if (row.column > max) max = row.column;
      for (const e of row.edges) max = Math.max(max, e.fromCol, e.toCol);
    }
    return Math.min(max + 1, MAX_VISIBLE_LANES) * LANE_WIDTH;
  }, [vm.lanes]);

  if (vm.isLoading) {
    return (
      <View style={styles.center} testID="commit-graph-loading">
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }
  if (vm.isError) {
    return (
      <ScrollView
        style={styles.fill}
        contentContainerStyle={styles.centerGrow}
        refreshControl={refreshControl}
        testID="commit-graph-error"
      >
        <Text style={[styles.muted, { color: theme.colors.error }]}>Couldn’t load commits</Text>
      </ScrollView>
    );
  }
  if (vm.isEmpty) {
    return (
      <ScrollView
        style={styles.fill}
        contentContainerStyle={styles.centerGrow}
        refreshControl={refreshControl}
        testID="commit-graph-empty"
      >
        <Text style={[styles.muted, { color: theme.colors.textSecondary }]}>
          {vm.degraded ? 'History too large to render.' : 'No commits yet.'}
        </Text>
      </ScrollView>
    );
  }

  return (
    <View style={styles.fill} testID="commit-graph">
      {/* Hidden, virtualization-proof commit count for tests. */}
      <Text style={styles.hidden} testID="commit-graph-count">
        {vm.nodes.length}
      </Text>
      <FlatList
        data={vm.nodes}
        keyExtractor={(node) => node.sha}
        refreshControl={refreshControl}
        onEndReached={() => vm.loadMore()}
        onEndReachedThreshold={0.6}
        renderItem={({ item, index }) => (
          <CommitRowItem
            node={item}
            row={vm.lanes[index]}
            prevRow={index > 0 ? vm.lanes[index - 1] : undefined}
            gutterWidth={gutterWidth}
            onPress={() => select(item)}
          />
        )}
        ListFooterComponent={
          vm.isFetchingMore ? (
            <View style={styles.footer} testID="commit-graph-loading-more">
              <ActivityIndicator color={theme.colors.primary} size="small" />
            </View>
          ) : null
        }
      />
    </View>
  );
}

function CommitRowItem({
  node,
  row,
  prevRow,
  gutterWidth,
  onPress,
}: {
  node: CommitGraphNode;
  row: LaneRow;
  prevRow?: LaneRow;
  gutterWidth: number;
  onPress: () => void;
}) {
  const { theme } = useAppTheme();
  const mid = ROW_HEIGHT / 2;
  const dotX = laneX(row.column);

  return (
    <Pressable
      style={styles.row}
      onPress={onPress}
      testID={`commit-row-${node.sha}`}
      accessibilityLabel={`Commit ${node.sha.slice(0, 7)}: ${node.subject}`}
    >
      <Svg width={gutterWidth} height={ROW_HEIGHT} testID={`commit-graph-cell-${node.sha}`}>
        {/* Incoming connectors (gap above): each lane arrives at its toCol. */}
        {prevRow?.edges.map((e, i) => (
          <Path
            key={`in-${i}`}
            d={`M ${laneX(e.toCol)} 0 L ${laneX(e.toCol)} ${mid}`}
            stroke={e.color}
            strokeWidth={2}
            fill="none"
          />
        ))}
        {/* Outgoing segments (gap below): bezier from this row's mid to the bottom. */}
        {row.edges.map((e, i) => {
          const x1 = laneX(e.fromCol);
          const x2 = laneX(e.toCol);
          const cy = mid + (ROW_HEIGHT - mid) * 0.5;
          return (
            <Path
              key={`out-${i}`}
              d={`M ${x1} ${mid} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${ROW_HEIGHT}`}
              stroke={e.color}
              strokeWidth={2}
              fill="none"
            />
          );
        })}
        {/* The commit dot. */}
        <Circle
          cx={dotX}
          cy={mid}
          r={DOT_RADIUS}
          fill={laneColor(row.column)}
          stroke={theme.colors.background}
          strokeWidth={1.5}
        />
      </Svg>

      <View style={styles.content}>
        {node.refs.length > 0 ? (
          <View style={styles.refs} testID={`commit-refs-${node.sha}`}>
            {node.refs.map((ref) => (
              <RefBadge key={`${ref.type}:${ref.name}`} commitRef={ref} />
            ))}
          </View>
        ) : null}
        <Text style={[styles.subject, { color: theme.colors.text }]} numberOfLines={1}>
          {node.subject}
        </Text>
        <View style={styles.meta}>
          <Text style={[styles.metaText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
            {node.author}
          </Text>
          <Text style={[styles.metaDot, { color: theme.colors.textTertiary }]}>·</Text>
          <Text style={[styles.metaText, { color: theme.colors.textTertiary }]}>
            {relativeCommitDate(node.date)}
          </Text>
          <Text style={[styles.metaDot, { color: theme.colors.textTertiary }]}>·</Text>
          <Text style={[styles.sha, { color: theme.colors.textTertiary }]}>
            {node.sha.slice(0, 7)}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

/** Ref decoration badge — distinct style per type (HEAD/branch/remote/tag). */
function RefBadge({ commitRef }: { commitRef: CommitRef }) {
  const { theme } = useAppTheme();
  const colorByType: Record<CommitRef['type'], string> = {
    head: theme.colors.primary,
    branch: theme.colors.success,
    remote: theme.colors.info,
    tag: theme.colors.warning,
  };
  const color = colorByType[commitRef.type];
  const label = commitRef.type === 'head' ? 'HEAD' : commitRef.name;

  return (
    <View
      style={[styles.badge, { backgroundColor: withAlpha(color, '29'), borderColor: color }]}
      testID={`commit-ref-${commitRef.type}-${commitRef.name}`}
    >
      <Text style={[styles.badgeText, { color }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 40 },
  // Empty/error states live in a ScrollView (pull-to-refresh needs a scroller).
  centerGrow: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 40,
  },
  muted: { fontSize: 13, textAlign: 'center' },
  hidden: { width: 0, height: 0, opacity: 0 },
  footer: { paddingVertical: 16, alignItems: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ROW_HEIGHT,
    paddingRight: 14,
  },
  content: { flex: 1, justifyContent: 'center', paddingLeft: 4, gap: 2 },
  refs: { flexDirection: 'row', gap: 4, marginBottom: 1 },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 140,
  },
  badgeText: { fontSize: 10, fontWeight: '700' },
  subject: { fontSize: 14, fontWeight: '500' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metaText: { fontSize: 11, flexShrink: 1 },
  metaDot: { fontSize: 11 },
  sha: { fontSize: 11, fontFamily: 'monospace' },
});
