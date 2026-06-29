/**
 * AI Style settings screen (`/settings/ai-style`), titled "AI Communication
 * Style". Thin view over `useAiStyleViewModel`; NO HTTP (pure MMKV chatStore
 * page).
 *
 * One `OptionButton` per shared `AI_STYLES` entry (exact shared label +
 * description strings); selected = `chatStore.aiStyle`. Selecting 'custom'
 * reveals the multiline custom-instructions input, which persists ON BLUR
 * (`onEndEditing`/`onBlur` → `setCustomAiStylePrompt`), never per keystroke.
 *
 * testIDs:
 *   settings-ai-style                  (root; back chevron = settings-ai-style-back)
 *   settings-ai-style-selected        (hidden mirror — children = current AIStyleMode)
 *   settings-ai-style-option-<id>     (one per shared style id)
 *   settings-ai-style-custom          (custom-instructions card, only when aiStyle==='custom')
 *   settings-ai-style-custom-input    (multiline draft input, commits on blur)
 *
 * Deliberate gaps:
 *   - No accordion mode (`showHeader=true` + isExpanded/onToggle) — mobile
 *     settings are sectioned sub-pages only, never inline accordions.
 *   - Styles render as a single column of full-width OptionButtons (the shared
 *     settings-chrome pattern; descriptions are visible instead of hover-only
 *     `title` tooltips).
 *   - No hover opacity transition (no pointer on native).
 */

import { StyleSheet, Text, TextInput, View } from 'react-native';

import { useAppTheme } from '../../../../theme';
import { OptionButton, SettingsSectionScreen } from '../../chrome';
import { useAiStyleViewModel, type AiStyleViewModelDeps } from './useAiStyleViewModel';

/** Header copy — verbatim from the shared `aiStyles.ts` module doc. */
export const AI_STYLE_HEADER_COPY = 'These styles control how the AI communicates with users.';

export interface AiStyleScreenProps {
  /** Back action override (default chrome `router.back()`); injectable for tests. */
  onBack?: () => void;
  /** ViewModel persistence seams; default = the real chatStore setters. */
  deps?: AiStyleViewModelDeps;
}

export function AiStyleScreen({ onBack, deps }: AiStyleScreenProps) {
  const { theme } = useAppTheme();
  const vm = useAiStyleViewModel(deps);

  return (
    <SettingsSectionScreen
      title="AI Communication Style"
      testID="settings-ai-style"
      onBack={onBack}
    >
      {/* Hidden mirror of the live selection (virtualization/testing-proof). */}
      <Text testID="settings-ai-style-selected" style={styles.hidden}>
        {vm.aiStyle}
      </Text>

      <View
        style={[
          styles.headerBox,
          { backgroundColor: theme.colors.backgroundElevated, borderColor: theme.colors.border },
        ]}
      >
        <Text style={[styles.headerCopy, { color: theme.colors.textSecondary }]}>
          {AI_STYLE_HEADER_COPY}
        </Text>
      </View>

      <View style={styles.optionsColumn}>
        {vm.styles.map((style) => (
          <OptionButton
            key={style.id}
            testID={`settings-ai-style-option-${style.id}`}
            label={style.label}
            description={style.description}
            selected={vm.aiStyle === style.id}
            onPress={() => vm.selectStyle(style.id)}
          />
        ))}
      </View>

      {vm.isCustom && (
        <View
          testID="settings-ai-style-custom"
          style={[styles.customBox, { backgroundColor: theme.colors.hover }]}
        >
          <Text style={[styles.customLabel, { color: theme.colors.textSecondary }]}>
            Custom Style Instructions
          </Text>
          <TextInput
            testID="settings-ai-style-custom-input"
            multiline
            value={vm.draftCustomPrompt}
            onChangeText={vm.setDraftCustomPrompt}
            onEndEditing={vm.commitCustomPrompt}
            onBlur={vm.commitCustomPrompt}
            placeholder="Describe how you want the AI to communicate..."
            placeholderTextColor={theme.colors.textTertiary}
            style={[
              styles.customInput,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                color: theme.colors.text,
              },
            ]}
          />
          <Text style={[styles.customHelper, { color: theme.colors.textTertiary }]}>
            Your custom style will be applied to all new messages
          </Text>
        </View>
      )}
    </SettingsSectionScreen>
  );
}

const styles = StyleSheet.create({
  hidden: { height: 0 },
  headerBox: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
  },
  headerCopy: { fontSize: 13, lineHeight: 19 },
  optionsColumn: { gap: 4 },
  customBox: {
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  customLabel: { fontSize: 12, fontWeight: '600', marginBottom: 6 },
  customInput: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 6,
    padding: 6,
    fontSize: 12,
    textAlignVertical: 'top',
  },
  customHelper: { fontSize: 11, marginTop: 4 },
});
