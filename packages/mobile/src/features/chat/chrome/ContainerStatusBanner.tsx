/**
 * ContainerStatusBanner — shows Docker workspace setup progress: a spinner for
 * `creating` / `health_check`, a static check for `ready`, with a colored
 * bottom border per status. Driven by the `container:status` socket event
 * (`chatChromeStore`).
 */

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useAppTheme, type Theme } from '../../../theme';

import type { ContainerStatus } from './chatChromeStore';

export interface ContainerStatusBannerProps {
  status: ContainerStatus;
}

function statusColor(status: string, theme: Theme): string {
  switch (status) {
    case 'creating':
      return theme.colors.info;
    case 'health_check':
      return theme.colors.warning;
    case 'ready':
      return theme.colors.success;
    default:
      return theme.colors.textTertiary;
  }
}

export function ContainerStatusBanner({ status }: ContainerStatusBannerProps) {
  const { theme } = useAppTheme();
  const showSpinner = status.status === 'creating' || status.status === 'health_check';
  const color = statusColor(status.status, theme);
  return (
    <View testID="container-status-banner" style={[styles.banner, { borderBottomColor: color }]}>
      {showSpinner ? (
        <ActivityIndicator size="small" color={color} testID="container-status-spinner" />
      ) : (
        <Text style={[styles.check, { color }]} testID="container-status-check">
          ✓
        </Text>
      )}
      <Text style={[styles.message, { color }]} testID="container-status-message">
        {status.message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomWidth: 2,
  },
  check: { fontSize: 14, fontWeight: '700' },
  message: { flex: 1, fontSize: 13, fontWeight: '500' },
});
