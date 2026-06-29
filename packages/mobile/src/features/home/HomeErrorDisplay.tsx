/**
 * HomeErrorDisplay — the repos-fetch error card shown in place of the repos grid.
 * Maps an error code to a semantic color + title; renders a
 * centered icon, title, message, the raw code, and an optional ACTION button
 * (the home screen wires "Connect GitHub" here so a user who skipped the
 * permission gate isn't dead-ended on "Error: fetch repositories").
 */

import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName, useAppTheme } from '../../theme';

export interface HomeErrorInfo {
  code?: string;
  message?: string;
}

/** Optional call-to-action rendered under the error details. */
export interface HomeErrorAction {
  label: string;
  onPress: () => void;
  testID?: string;
}

export interface HomeErrorDisplayProps {
  error: HomeErrorInfo;
  context?: string;
  action?: HomeErrorAction;
}

function describe(
  code: string | undefined,
  context: string | undefined,
  colors: { warning: string; error: string; info: string }
): { color: string; icon: IconName; title: string } {
  switch (code) {
    case 'NO_GITHUB_CONNECTION':
      return { color: colors.info, icon: 'code-branch', title: 'GitHub Connection Required' };
    case 'RATE_LIMIT_EXCEEDED':
      return { color: colors.warning, icon: 'warning', title: 'Rate Limit Exceeded' };
    case 'INSUFFICIENT_PERMISSIONS':
      return { color: colors.warning, icon: 'warning', title: 'Insufficient Permissions' };
    case 'GITHUB_AUTH_FAILED':
      return { color: colors.error, icon: 'warning', title: 'Authentication Failed' };
    default:
      return {
        color: colors.error,
        icon: 'warning',
        title: context ? `Error: ${context}` : 'Error',
      };
  }
}

export function HomeErrorDisplay({ error, context, action }: HomeErrorDisplayProps) {
  const { theme } = useAppTheme();
  const { color, icon, title } = describe(error.code, context, theme.colors);

  return (
    <View
      testID="home-repos-error"
      style={[
        styles.card,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
        theme.shadows.md,
      ]}
    >
      <Icon name={icon} size={48} color={color} />
      <Text style={[styles.title, { color: theme.colors.text }]}>{title}</Text>
      <Text style={[styles.message, { color: theme.colors.textSecondary }]}>
        {error.message || 'An error occurred. Please try again.'}
      </Text>
      {error.code ? (
        <Text style={[styles.code, { color: theme.colors.textTertiary }]}>
          Error Code: {error.code}
        </Text>
      ) : null}
      {action ? (
        <Pressable
          testID={action.testID ?? 'home-error-action'}
          accessibilityRole="button"
          onPress={action.onPress}
          style={[styles.actionButton, { backgroundColor: theme.colors.primary }]}
        >
          <Text style={[styles.actionLabel, { color: theme.colors.textInverse }]}>
            {action.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    maxWidth: 600,
    alignSelf: 'center',
    padding: 24,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: 'center',
    gap: 8,
  },
  title: { fontSize: 18, fontWeight: '600', textAlign: 'center' },
  message: { fontSize: 14, textAlign: 'center' },
  code: {
    fontSize: 12,
    marginTop: 4,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  actionButton: {
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
  },
  actionLabel: { fontSize: 14, fontWeight: '600' },
});
