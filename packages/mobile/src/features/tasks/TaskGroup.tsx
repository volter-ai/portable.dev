/**
 * TaskGroup — a collapsible status section of the Tasks page: a transparent
 * full-width header with a
 * ▾/▸ chevron, an UPPERCASE title, and a muted `({count})`, over a thin
 * bottom border; the body mounts only while expanded.
 */

import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../theme';

export interface TaskGroupProps {
  testID: string;
  title: string;
  count: number;
  defaultExpanded?: boolean;
  children: ReactNode;
}

export function TaskGroup({
  testID,
  title,
  count,
  defaultExpanded = true,
  children,
}: TaskGroupProps) {
  const { theme } = useAppTheme();
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <View style={styles.group} testID={testID}>
      <Pressable
        testID={`${testID}-toggle`}
        onPress={() => setExpanded((e) => !e)}
        style={[styles.header, { borderBottomColor: theme.colors.border }]}
      >
        <Text style={[styles.chevron, { color: theme.colors.textSecondary }]}>
          {expanded ? '▾' : '▸'}
        </Text>
        <Text style={[styles.title, { color: theme.colors.textSecondary }]}>{title}</Text>
        <Text style={[styles.count, { color: theme.colors.textSecondary }]}>({count})</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.body} testID={`${testID}-body`}>
          {children}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { marginBottom: 8 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
  },
  chevron: { fontSize: 10 },
  title: { fontSize: 12, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.5 },
  count: { fontSize: 11, opacity: 0.7 },
  body: { paddingVertical: 4 },
});
