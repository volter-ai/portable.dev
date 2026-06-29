/**
 * GenerationsTab — the RepoPage Generations tab.
 *
 * Lists the repo's AI media generations (from `.volter/generations.json`) with
 * name/version, type, model, and timestamp. Thin view over {@link useRepoGenerations}.
 */

import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Generation } from '@vgit2/shared/types';

import { useAppTheme } from '../../theme';
import { RowCard } from './RowCard';
import { useRepoGenerations } from './useRepoGenerations';

export interface GenerationsTabProps {
  owner: string;
  repo: string;
}

export function GenerationsTab({ owner, repo }: GenerationsTabProps) {
  const { theme } = useAppTheme();
  const vm = useRepoGenerations(owner, repo);

  if (vm.isLoading) {
    return (
      <ActivityIndicator
        testID="repo-generations-loading"
        style={styles.center}
        color={theme.colors.primary}
      />
    );
  }
  if (vm.isError) {
    return (
      <View style={styles.center} testID="repo-generations-error">
        <Text style={[styles.errorText, { color: theme.colors.error }]}>
          Couldn’t load generations
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      {/* Virtualization-proof list length. */}
      <Text style={styles.hidden} testID="repo-generations-count">
        {vm.generations.length}
      </Text>

      <FlatList
        testID="repo-generations-list"
        data={vm.generations}
        keyExtractor={(g) => g.id}
        renderItem={({ item }) => <GenerationRow generation={item} />}
        ListEmptyComponent={
          <Text
            style={[styles.emptyText, { color: theme.colors.textSecondary }]}
            testID="repo-generations-empty"
          >
            No generations yet
          </Text>
        }
        ListFooterComponent={
          vm.hasMore ? (
            <Pressable
              testID="repo-generations-load-more"
              style={styles.loadMore}
              onPress={vm.loadMore}
              disabled={vm.isFetchingMore}
            >
              <Text style={[styles.loadMoreText, { color: theme.colors.link }]}>
                {vm.isFetchingMore ? 'Loading…' : 'Load more'}
              </Text>
            </Pressable>
          ) : null
        }
      />
    </View>
  );
}

function GenerationRow({ generation }: { generation: Generation }) {
  const { theme } = useAppTheme();
  return (
    <RowCard testID={`repo-generation-${generation.id}`}>
      <View style={styles.rowMain}>
        <Text style={[styles.rowTitle, { color: theme.colors.text }]} numberOfLines={1}>
          {generation.name}
          {generation.version ? ` · ${generation.version}` : ''}
        </Text>
        <Text style={[styles.rowMeta, { color: theme.colors.textSecondary }]} numberOfLines={1}>
          {generation.type === 'video' ? '🎬' : '🖼'} {generation.model}
          {generation.timestamp ? ` · ${formatDate(generation.timestamp)}` : ''}
        </Text>
      </View>
    </RowCard>
  );
}

/** Format an ISO date to a short, locale-stable label. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hidden: { height: 0, opacity: 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 24 },
  errorText: { fontSize: 15, fontWeight: '600' },
  emptyText: { paddingVertical: 24, textAlign: 'center' },
  rowMain: { gap: 2 },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowMeta: { fontSize: 12 },
  loadMore: { padding: 16, alignItems: 'center' },
  loadMoreText: { fontWeight: '600' },
});
