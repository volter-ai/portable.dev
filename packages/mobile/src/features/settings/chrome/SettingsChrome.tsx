/**
 * Shared chrome for the settings section screens — the sub-page shell (header
 * with back arrow + centered title + scrollable 1rem-padded content) and its
 * recurring control patterns (section labels, surface cards, option buttons,
 * checkbox/toggle rows, loading/error states). Every `/settings/<key>` screen
 * composes these so the ten pages stay visually identical to each other.
 */

import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { useAppTheme, withAlpha, Icon } from '../../../theme';

// ---------------------------------------------------------------------------
// Screen shell
// ---------------------------------------------------------------------------

export interface SettingsSectionScreenProps {
  /** Centered header title (0.875rem / 500). */
  title: string;
  /** Root testID; the back button is `${testID}-back`. */
  testID: string;
  children: ReactNode;
  /** Wrap children in a ScrollView (default true). Lists that own their own scrolling pass false. */
  scrollable?: boolean;
  /** Back action (default: `router.back()`); injectable for tests. */
  onBack?: () => void;
  /** Optional right-side header accessory (e.g. an "Add" button). */
  headerRight?: ReactNode;
}

/** Full-screen settings sub-page shell: header (back + centered title) + content. */
export function SettingsSectionScreen({
  title,
  testID,
  children,
  scrollable = true,
  onBack,
  headerRight,
}: SettingsSectionScreenProps) {
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();

  const goBack = onBack ?? (() => router.back());

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]} testID={testID}>
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, borderBottomColor: theme.colors.border },
        ]}
      >
        <Pressable
          testID={`${testID}-back`}
          accessibilityRole="button"
          onPress={goBack}
          style={styles.headerButton}
          hitSlop={8}
        >
          <Icon name="chevron-left" size={20} color={theme.colors.textSecondary} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.headerButton}>{headerRight ?? null}</View>
      </View>
      {scrollable ? (
        <ScrollView
          style={styles.body}
          contentContainerStyle={[styles.bodyContent, { paddingBottom: insets.bottom + 32 }]}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.body, styles.bodyContent]}>{children}</View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Recurring controls
// ---------------------------------------------------------------------------

/** Uppercase micro section label (0.6875rem / 600 / textTertiary). */
export function SectionLabel({ children }: { children: ReactNode }) {
  const { theme } = useAppTheme();
  return (
    <Text style={[styles.sectionLabel, { color: theme.colors.textTertiary }]}>{children}</Text>
  );
}

/** Surface card container (surface bg, 0.5rem radius). */
export function SettingsCard({
  children,
  testID,
  padded = true,
}: {
  children: ReactNode;
  testID?: string;
  padded?: boolean;
}) {
  const { theme } = useAppTheme();
  return (
    <View
      testID={testID}
      style={[styles.card, { backgroundColor: theme.colors.surface }, padded && styles.cardPadded]}
    >
      {children}
    </View>
  );
}

export interface OptionButtonProps {
  label: string;
  description?: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
  disabled?: boolean;
}

/**
 * Option button: selected = `primary + '20'` bg, primary text/border;
 * unselected = surfaceHover bg, default text, plain border. Used by Theme
 * brightness, AI styles, notification cadence, permission modes, etc.
 */
export function OptionButton({
  label,
  description,
  selected,
  onPress,
  testID,
  disabled,
}: OptionButtonProps) {
  const { theme } = useAppTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.option,
        {
          backgroundColor: selected
            ? withAlpha(theme.colors.primary, '20')
            : theme.colors.surfaceHover,
          borderColor: selected ? theme.colors.primary : theme.colors.border,
        },
        disabled && styles.disabled,
      ]}
    >
      <Text
        style={[styles.optionLabel, { color: selected ? theme.colors.primary : theme.colors.text }]}
      >
        {label}
      </Text>
      {!!description && (
        <Text style={[styles.optionDescription, { color: theme.colors.textTertiary }]}>
          {description}
        </Text>
      )}
    </Pressable>
  );
}

export interface ToggleRowProps {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  testID: string;
  disabled?: boolean;
}

/** Checkbox/toggle row (label+checkbox cards → RN Switch). */
export function ToggleRow({
  label,
  description,
  value,
  onValueChange,
  testID,
  disabled,
}: ToggleRowProps) {
  const { theme } = useAppTheme();
  return (
    <View style={[styles.toggleRow, { backgroundColor: theme.colors.surfaceHover }]}>
      <View style={styles.toggleText}>
        <Text style={[styles.toggleLabel, { color: theme.colors.text }]}>{label}</Text>
        {!!description && (
          <Text style={[styles.toggleDescription, { color: theme.colors.textTertiary }]}>
            {description}
          </Text>
        )}
      </View>
      <Switch
        testID={testID}
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ true: theme.colors.primary }}
      />
    </View>
  );
}

/** Centered loading state (spinner + caption). */
export function SectionLoading({ testID, caption }: { testID: string; caption?: string }) {
  const { theme } = useAppTheme();
  return (
    <View style={styles.centered} testID={testID}>
      <ActivityIndicator color={theme.colors.primary} />
      {!!caption && (
        <Text style={[styles.centeredCaption, { color: theme.colors.textTertiary }]}>
          {caption}
        </Text>
      )}
    </View>
  );
}

/** Centered error state with optional retry. */
export function SectionError({
  testID,
  message,
  onRetry,
  retryTestID,
}: {
  testID: string;
  message: string;
  onRetry?: () => void;
  retryTestID?: string;
}) {
  const { theme } = useAppTheme();
  return (
    <View style={styles.centered} testID={testID}>
      <Text style={[styles.centeredCaption, { color: theme.colors.error }]}>{message}</Text>
      {onRetry && (
        <Pressable
          testID={retryTestID ?? `${testID}-retry`}
          accessibilityRole="button"
          onPress={onRetry}
          style={[styles.retryButton, { backgroundColor: theme.colors.primary }]}
        >
          <Text style={[styles.retryText, { color: theme.colors.textInverse }]}>Retry</Text>
        </Pressable>
      )}
    </View>
  );
}

/** Centered empty state (textTertiary 0.8125rem). */
export function SectionEmpty({ testID, message }: { testID: string; message: string }) {
  const { theme } = useAppTheme();
  return (
    <View style={styles.centered} testID={testID}>
      <Text style={[styles.centeredCaption, { color: theme.colors.textTertiary }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  headerButton: {
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '500',
  },
  body: { flex: 1 },
  bodyContent: { padding: 16, gap: 16 },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  card: { borderRadius: 8, overflow: 'hidden' },
  cardPadded: { padding: 12 },
  option: {
    borderRadius: 6,
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  optionLabel: { fontSize: 13, fontWeight: '500' },
  optionDescription: { fontSize: 11, marginTop: 2 },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  toggleText: { flex: 1 },
  toggleLabel: { fontSize: 13, fontWeight: '500' },
  toggleDescription: { fontSize: 11, marginTop: 2 },
  centered: { alignItems: 'center', justifyContent: 'center', paddingVertical: 32, gap: 10 },
  centeredCaption: { fontSize: 13, textAlign: 'center', paddingHorizontal: 16 },
  retryButton: { paddingVertical: 8, paddingHorizontal: 18, borderRadius: 8 },
  retryText: { fontWeight: '600', fontSize: 13 },
  disabled: { opacity: 0.5 },
});
