/**
 * RuntimeIndicator — a compact chip reflecting this chat's runtime
 * state: the count of active tunnels + running processes for the repo (sourced
 * from the socket-fed `runtimeStore`). Renders nothing when idle. Lives in the
 * GitStatusBanner's trailing slot, alongside the container-status indicator.
 */

import { StyleSheet, Text, View } from 'react-native';

import { useAppTheme, withAlpha } from '../../../theme';

export interface RuntimeIndicatorProps {
  tunnelCount: number;
  processCount: number;
}

export function RuntimeIndicator({ tunnelCount, processCount }: RuntimeIndicatorProps) {
  const { theme } = useAppTheme();
  if (tunnelCount === 0 && processCount === 0) return null;
  return (
    <View
      style={[
        styles.chip,
        {
          backgroundColor: withAlpha(theme.colors.success, '22'),
          borderColor: withAlpha(theme.colors.success, '40'),
        },
      ]}
      testID="runtime-indicator"
    >
      <View style={[styles.dot, { backgroundColor: theme.colors.success }]} />
      {tunnelCount > 0 && (
        <Text style={[styles.label, { color: theme.colors.success }]} testID="runtime-tunnels">
          🔗 {tunnelCount}
        </Text>
      )}
      {processCount > 0 && (
        <Text style={[styles.label, { color: theme.colors.success }]} testID="runtime-processes">
          ⚙ {processCount}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: { fontSize: 11, fontWeight: '600' },
});
