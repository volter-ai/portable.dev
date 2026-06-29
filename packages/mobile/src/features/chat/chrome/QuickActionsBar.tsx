/**
 * QuickActionsBar — a horizontally-scrolling carousel of contextual action pills derived from the
 * repo's package scripts (`useQuickActions`). Renders loading placeholders while
 * fetching; nothing when there are no actions and not loading.
 */

import type { QuickAction } from '@vgit2/shared/types';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../../theme';

export interface QuickActionsBarProps {
  quickActions: QuickAction[];
  loading: boolean;
  onActionPress: (action: QuickAction) => void;
}

export function QuickActionsBar({ quickActions, loading, onActionPress }: QuickActionsBarProps) {
  const { theme } = useAppTheme();
  if (!loading && quickActions.length === 0) return null;

  const dotColors: Record<string, string> = {
    green: theme.colors.success,
    yellow: theme.colors.warning,
    grey: theme.colors.textTertiary,
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.content}
      style={styles.bar}
      testID="quick-actions-bar"
    >
      {loading
        ? [0, 1, 2].map((i) => (
            <View
              key={i}
              style={[
                styles.placeholder,
                {
                  backgroundColor: theme.colors.surfaceHover,
                  borderColor: theme.colors.borderLight,
                },
              ]}
              testID={`quick-action-placeholder-${i}`}
            />
          ))
        : quickActions.map((action) => (
            <Pressable
              key={action.id}
              onPress={() => onActionPress(action)}
              style={[
                styles.pill,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surfaceHover,
                },
              ]}
              testID={`quick-action-${action.id}`}
            >
              {action.hasStatusDot && (
                <View
                  style={[
                    styles.dot,
                    { backgroundColor: dotColors[action.statusDotColor ?? 'green'] },
                  ]}
                />
              )}
              {!!action.label && (
                <Text style={[styles.label, { color: theme.colors.textSecondary }]}>
                  {action.label}
                </Text>
              )}
              {!!action.labelBold && (
                <Text style={[styles.labelBold, { color: theme.colors.text }]}>
                  {action.labelBold}
                </Text>
              )}
            </Pressable>
          ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bar: { flexGrow: 0 },
  content: { gap: 6, paddingVertical: 6, paddingHorizontal: 12 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: { fontSize: 12 },
  labelBold: { fontSize: 12, fontWeight: '600' },
  placeholder: {
    width: 80,
    height: 24,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
