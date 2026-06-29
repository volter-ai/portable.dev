/**
 * ProcessDetailScreen — `/runtime/process/:id` (web `RuntimeProcessDetailInstance`).
 * Shows the command + status and the ANSI-colored terminal output, polling the
 * output file while the process runs. No external/embedded web content → fully
 * App-Store-safe (local output only).
 */

import { useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '../../theme';
import { Icon } from '../../theme/icons/Icon';
import { useOptionalSocket } from '../socket';
import { ProcessTerminal } from './ProcessTerminal';
import { RuntimeHeader } from './RuntimeHeader';
import { processStatusColor, processStatusLabel } from './runtimeHelpers';
import { useProcessOutput } from './useProcessOutput';
import { useRuntime } from './useRuntime';

export function ProcessDetailScreen({ id }: { id?: string }) {
  const params = useLocalSearchParams<{ id?: string }>();
  const processId = id ?? params.id ?? '';
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { processes } = useRuntime(useOptionalSocket());
  const process = processes.find((p) => p.id === processId);
  const { output, isFetching, refetch, hasSource } = useProcessOutput(process);

  if (!process) {
    return (
      <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
        <RuntimeHeader type="Process" title={processId} backTestID="process-detail-back" />
        <View style={styles.center}>
          <Text
            style={[styles.notFound, { color: theme.colors.textSecondary }]}
            testID="process-detail-not-found"
          >
            This process is no longer tracked.
          </Text>
        </View>
      </View>
    );
  }

  const running = process.status === 'running';
  const statusColor = processStatusColor(process.status, theme.colors);

  return (
    <View
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      testID="process-detail"
    >
      <RuntimeHeader
        type="Process"
        title={process.description || process.command}
        backTestID="process-detail-back"
        right={
          <Pressable
            testID="process-refresh"
            accessibilityLabel="Refresh output"
            hitSlop={8}
            onPress={refetch}
          >
            <Icon name="refresh" size={18} color={theme.colors.textSecondary} />
          </Pressable>
        }
      />

      <View style={[styles.body, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.statusRow}>
          <Text style={[styles.status, { color: statusColor }]} testID="process-detail-status">
            {processStatusLabel(process.status)}
          </Text>
          {running ? (
            <Text
              style={[styles.live, { color: theme.colors.success }]}
              testID="process-detail-live"
            >
              ● Live output
            </Text>
          ) : null}
          {isFetching ? (
            <Text style={[styles.fetching, { color: theme.colors.textTertiary }]}>updating…</Text>
          ) : null}
        </View>

        <Text
          style={[styles.command, { color: theme.colors.text }]}
          testID="process-detail-command"
        >
          <Text style={{ color: theme.colors.success }}>$ </Text>
          {process.command}
        </Text>

        {output ? (
          <ProcessTerminal output={output} />
        ) : (
          <View
            style={[
              styles.emptyBox,
              { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
            ]}
          >
            <Text
              style={[styles.empty, { color: theme.colors.textSecondary }]}
              testID="process-output-empty"
            >
              {hasSource
                ? running
                  ? 'Waiting for output…'
                  : 'No output available'
                : 'No output file (the process may be too old)'}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1, padding: 12, gap: 10 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  notFound: { fontSize: 14, textAlign: 'center' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  status: { fontSize: 13, fontWeight: '700' },
  live: { fontSize: 12, fontWeight: '600' },
  fetching: { fontSize: 12 },
  command: { fontSize: 13, fontFamily: 'Menlo' },
  emptyBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    padding: 16,
    alignItems: 'center',
  },
  empty: { fontSize: 13 },
});
