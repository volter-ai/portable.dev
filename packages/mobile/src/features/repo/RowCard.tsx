/**
 * RowCard — the shared list-item card chrome for the RepoPage tab lists
 * (Issues, PRs, Actions, Workflows, Generations, Branches), matching
 * the repos-list `RepoCard` look: `surface` background (→ `surfaceHover` while
 * pressed), radius 8, 10/12 padding, 8px gap between cards.
 */

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useAppTheme } from '../../theme';

export interface RowCardProps {
  testID?: string;
  /** When present the card is pressable (with the `surfaceHover` feedback). */
  onPress?: () => void;
  /** Extra layout styles for the card content (e.g. a horizontal row). */
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

export function RowCard({ testID, onPress, style, children }: RowCardProps) {
  const { theme } = useAppTheme();

  if (!onPress) {
    return (
      <View testID={testID} style={[styles.card, { backgroundColor: theme.colors.surface }, style]}>
        {children}
      </View>
    );
  }

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: pressed ? theme.colors.surfaceHover : theme.colors.surface },
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The repos-list `RepoCard` chrome: radius 8, padding 10/12, 8px between cards.
  card: {
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
});
