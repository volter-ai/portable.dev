/**
 * RuntimeHeader — themed back-header for the runtime detail/list screens (the
 * Stack runs `headerShown:false`, so each screen owns its chrome — same pattern as
 * the chat ActiveChatScreen + settings sections). Back chevron + type + name +
 * optional right slot.
 */

import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '../../theme';
import { Icon } from '../../theme/icons/Icon';

export interface RuntimeHeaderProps {
  /** Small muted type label, e.g. "Tunnel" / "Process". */
  type?: string;
  /** Bold resource name / screen title. */
  title: string;
  /** testID for the back button. */
  backTestID?: string;
  /** Override the back action (default: `router.back()`). */
  onBack?: () => void;
  /** Optional trailing controls. */
  right?: ReactNode;
}

export function RuntimeHeader({ type, title, backTestID, onBack, right }: RuntimeHeaderProps) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.header,
        {
          paddingTop: insets.top + 8,
          backgroundColor: theme.colors.surface,
          borderBottomColor: theme.colors.border,
        },
      ]}
    >
      <Pressable
        testID={backTestID ?? 'runtime-header-back'}
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={10}
        onPress={() => (onBack ? onBack() : router.back())}
        style={styles.back}
      >
        <Icon name="chevron-left" size={22} color={theme.colors.textSecondary} />
      </Pressable>
      <View style={styles.titles}>
        {type ? (
          <Text style={[styles.type, { color: theme.colors.textTertiary }]}>{type}</Text>
        ) : null}
        <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={1}>
          {title}
        </Text>
      </View>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { padding: 4 },
  titles: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  type: { fontSize: 13, fontWeight: '500' },
  title: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
