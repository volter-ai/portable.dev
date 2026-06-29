/**
 * ProcessesListScreen — `/runtime/processes` (web `RuntimeProcessesListInstance`).
 * Lists background processes; a card opens the process detail terminal.
 */

import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '../../theme';
import { useOptionalSocket } from '../socket';
import { ProcessCard } from './cards';
import { RuntimeHeader } from './RuntimeHeader';
import { runtimeRoutes, type RuntimeNavigate } from './runtimeRoutes';
import { useRuntime } from './useRuntime';

export function ProcessesListScreen({ navigate }: { navigate?: RuntimeNavigate }) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { processes } = useRuntime(useOptionalSocket());
  const go = navigate ?? ((p: string) => router.push(p));

  return (
    <View
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      testID="processes-list"
    >
      <RuntimeHeader title="Background tasks" backTestID="processes-list-back" />
      <Text style={styles.hidden} testID="processes-list-count">
        {processes.length}
      </Text>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        {processes.length === 0 ? (
          <Text
            style={[styles.empty, { color: theme.colors.textSecondary }]}
            testID="processes-list-empty"
          >
            No background tasks
          </Text>
        ) : (
          processes.map((p) => (
            <ProcessCard
              key={p.id}
              process={p}
              testID={`process-open-${p.id}`}
              onPress={() => go(runtimeRoutes.process(p.id))}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 12, gap: 10 },
  empty: { fontSize: 14, padding: 16, textAlign: 'center' },
  hidden: { width: 0, height: 0, opacity: 0 },
});
