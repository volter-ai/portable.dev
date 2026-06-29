/**
 * AttachButton — the composer's "+" attach trigger (web `ChatInputField` parity).
 *
 * The web renders the plus button in TWO places depending on the input's expand
 * state: INLINE beside the placeholder while the field is collapsed (empty +
 * unfocused), then as the FIRST item in the action row once it expands (focused /
 * has text / has attachments). This is that button — `variant` picks the size to
 * match each spot (a 44² inline touch target vs a denser 32² in the action row),
 * matching the web's `1.1rem`/`44px` inline and `1rem`/`32px` in-row plus buttons.
 *
 * It owns no state: pressing it asks the parent to open the AttachmentBar source
 * sheet (the attachment state lives there, reached via its imperative handle).
 */

import { Pressable, StyleSheet } from 'react-native';

import { Icon, useAppTheme } from '../../../theme';

export interface AttachButtonProps {
  /** Open the attachment source sheet (Photo Library / Files / Camera / Draw). */
  onPress: () => void;
  /** `inline` = collapsed beside the placeholder; `row` = expanded action row. */
  variant: 'inline' | 'row';
  testID?: string;
}

export function AttachButton({ onPress, variant, testID = 'attach-button' }: AttachButtonProps) {
  const { theme } = useAppTheme();
  const inline = variant === 'inline';
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel="Add attachment"
      onPress={onPress}
      hitSlop={inline ? 0 : 6}
      style={inline ? styles.inline : styles.row}
    >
      <Icon name="plus" size={inline ? 20 : 18} color={theme.colors.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  inline: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  row: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
});
