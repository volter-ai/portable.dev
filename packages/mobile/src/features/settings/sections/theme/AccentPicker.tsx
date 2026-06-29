/**
 * AccentPicker — the accent-color trigger + modal: a trigger row showing
 * the CURRENT accent (135deg-equivalent gradient swatch + the accent's display
 * label from `accentMetadata`) that opens a Modal listing the 12 accents +
 * 'Custom'. Each swatch is a full-width gradient row whose label
 * color is chosen by `getLuminance(gradientStart)` and whose border highlights
 * the selected entry with `theme.colors.text`.
 *
 * The Modal is rendered only when `visible` (the repo's deterministic
 * `queryByTestId` pattern). CSS `linear-gradient(135deg, A, B)` ≡ RN
 * `<LinearGradient start={{x:0,y:0}} end={{x:1,y:1}}>` (top-left → bottom-right
 * — the documented theme-system rule; do NOT "correct" the endpoint).
 */

import { LinearGradient } from 'expo-linear-gradient';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Accent } from '@vgit2/shared/types';

import { accentMetadata, getLuminance, useAppTheme } from '../../../../theme';

export interface AccentPickerProps {
  accent: Accent;
  /** Custom gradient pair (committed store values or the defaults). */
  customStart: string;
  customEnd: string;
  visible: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSelect: (accent: Accent) => void;
}

/** Readable overlay text color over a gradient swatch (getLuminance rule). */
function swatchTextColor(gradientStart: string): string {
  return getLuminance(gradientStart) > 0.5 ? '#000000' : '#FFFFFF';
}

export function AccentPicker({
  accent,
  customStart,
  customEnd,
  visible,
  onOpen,
  onClose,
  onSelect,
}: AccentPickerProps) {
  const { theme } = useAppTheme();

  const current = accentMetadata.find((meta) => meta.value === accent);
  const isCustom = accent === 'custom';
  const triggerStart = isCustom ? customStart : (current?.gradientStart ?? customStart);
  const triggerEnd = isCustom ? customEnd : (current?.gradientEnd ?? customEnd);
  const triggerLabel = isCustom ? 'Custom' : (current?.label ?? accent);

  return (
    <>
      <Pressable
        testID="settings-theme-accent-trigger"
        accessibilityRole="button"
        onPress={onOpen}
        style={[
          styles.trigger,
          { backgroundColor: theme.colors.surfaceHover, borderColor: theme.colors.border },
        ]}
      >
        <LinearGradient
          colors={[triggerStart, triggerEnd] as const}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.triggerSwatch}
        />
        <Text
          testID="settings-theme-accent-label"
          style={[styles.triggerLabel, { color: theme.colors.text }]}
          numberOfLines={1}
        >
          {triggerLabel}
        </Text>
        <Text style={[styles.triggerChevron, { color: theme.colors.textTertiary }]}>›</Text>
      </Pressable>

      {visible && (
        <Modal transparent animationType="slide" onRequestClose={onClose}>
          <View style={styles.backdrop}>
            <View
              testID="settings-theme-accent-modal"
              style={[styles.card, { backgroundColor: theme.colors.backgroundElevated }]}
            >
              <View style={styles.cardHeader}>
                <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Accent Color</Text>
                <Pressable
                  testID="settings-theme-accent-close"
                  accessibilityRole="button"
                  onPress={onClose}
                  hitSlop={8}
                >
                  <Text style={[styles.closeGlyph, { color: theme.colors.textSecondary }]}>✕</Text>
                </Pressable>
              </View>
              <ScrollView contentContainerStyle={styles.list}>
                {accentMetadata.map((option) => {
                  const selected = accent === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      testID={`settings-theme-accent-option-${option.value}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      onPress={() => onSelect(option.value)}
                    >
                      <LinearGradient
                        colors={[option.gradientStart, option.gradientEnd] as const}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={[
                          styles.swatchRow,
                          { borderColor: selected ? theme.colors.text : 'transparent' },
                        ]}
                      >
                        <Text
                          style={[
                            styles.swatchLabel,
                            { color: swatchTextColor(option.gradientStart) },
                          ]}
                        >
                          {selected ? '✓ ' : ''}
                          {option.label}
                        </Text>
                      </LinearGradient>
                    </Pressable>
                  );
                })}
                <Pressable
                  testID="settings-theme-accent-option-custom"
                  accessibilityRole="button"
                  accessibilityState={{ selected: isCustom }}
                  onPress={() => onSelect('custom')}
                >
                  <LinearGradient
                    colors={[customStart, customEnd] as const}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={[
                      styles.swatchRow,
                      { borderColor: isCustom ? theme.colors.text : 'transparent' },
                    ]}
                  >
                    <Text style={[styles.swatchLabel, { color: swatchTextColor(customStart) }]}>
                      {isCustom ? '✓ ' : ''}Custom
                    </Text>
                  </LinearGradient>
                </Pressable>
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 6,
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  triggerSwatch: { width: 36, height: 24, borderRadius: 6 },
  triggerLabel: { flex: 1, fontSize: 13, fontWeight: '500' },
  triggerChevron: { fontSize: 16 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    padding: 16,
  },
  card: {
    borderRadius: 12,
    padding: 16,
    maxHeight: '80%',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  closeGlyph: { fontSize: 18, fontWeight: '600' },
  list: { gap: 6 },
  swatchRow: {
    height: 36,
    borderRadius: 6,
    borderWidth: 2,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  swatchLabel: { fontSize: 12, fontWeight: '600' },
});
