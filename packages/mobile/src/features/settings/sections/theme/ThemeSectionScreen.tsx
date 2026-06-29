/**
 * Theme settings (`/settings/theme`) — thin view over `useThemeSectionViewModel`
 * (every store write also background-syncs the full `ThemeOptions` via
 * `PUT /api/user/theme { themeConfig }`, debounced; reset = `DELETE` + store
 * reset to `MOBILE_DEFAULT_THEME_OPTIONS`). The page styles itself from
 * `useAppTheme()`, so it RE-THEMES LIVE as the user picks options.
 *
 * Content:
 *  1. Brightness 3-column grid (System / Light / Dark) + the conditional
 *     modifier toggles: system → BOTH "OLED Dark" ("Pure black") + "Paper
 *     Light" ("Warm sepia tones"); light → Paper only; dark → OLED only.
 *  2. Accent Color: trigger row (current gradient swatch + display label from
 *     `accentMetadata`) → modal with the 12 accents + Custom; accent==='custom'
 *     reveals two hex TextInputs (start/end, seeded from
 *     customGradientStart/End) committing via `setCustomGradient` on a valid
 *     #RRGGBB pair.
 *  3. "Bold Mode" ("Accent nav") + "Gradients" ("Use gradient") toggles —
 *     Gradients is disabled unless Bold Mode is on.
 *  4. "Reset Theme to Defaults" (danger-bordered button).
 *
 * testIDs:
 *   settings-theme (root) / settings-theme-back (shell)
 *   settings-theme-brightness-{system,light,dark}
 *   settings-theme-oled / settings-theme-paper
 *   settings-theme-accent-trigger / settings-theme-accent-label
 *   settings-theme-accent-modal / settings-theme-accent-close
 *   settings-theme-accent-option-<accent> / settings-theme-accent-option-custom
 *   settings-theme-custom-card / settings-theme-custom-start / settings-theme-custom-end
 *   settings-theme-bold / settings-theme-gradients
 *   settings-theme-reset
 *
 * Deliberate gaps (documented, not bugs):
 *  - NO background images section — mobile has no background-image support;
 *    server-side `backgroundImages` are preserved untouched by the PUT (the
 *    ViewModel snapshots the full store state, incl. hydrated extras).
 *  - NO per-tool color pickers (the 8 `customTool*` fields) — same preservation
 *    guarantee applies.
 *  - NO color-wheel picker — replaced with two hex TextInputs for the custom
 *    gradient (native adaptation).
 *  - NO reset confirmation modal — a single tap resets (the section page is
 *    already a deliberate navigation step).
 */

import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { Brightness } from '@vgit2/shared/types';

import { useAppTheme } from '../../../../theme';
import {
  OptionButton,
  SectionLabel,
  SettingsCard,
  SettingsSectionScreen,
  ToggleRow,
} from '../../chrome';
import { AccentPicker } from './AccentPicker';
import { useThemeSectionViewModel, type UseThemeSectionDeps } from './useThemeSectionViewModel';

const BRIGHTNESS_OPTIONS: ReadonlyArray<{
  value: Brightness;
  label: string;
  description: string;
}> = [
  { value: 'system', label: 'System', description: 'Follow system preference' },
  { value: 'light', label: 'Light', description: 'Clean and bright' },
  { value: 'dark', label: 'Dark', description: 'Easy on the eyes' },
];

export interface ThemeSectionScreenProps {
  /** ViewModel seams (api / debounceMs) — injectable for tests. */
  deps?: UseThemeSectionDeps;
  /** Back action override (default: `router.back()`). */
  onBack?: () => void;
}

export function ThemeSectionScreen({ deps, onBack }: ThemeSectionScreenProps) {
  const { theme } = useAppTheme();
  const vm = useThemeSectionViewModel(deps ?? {});

  const showOled = vm.brightness === 'system' || vm.brightness === 'dark';
  const showPaper = vm.brightness === 'system' || vm.brightness === 'light';

  return (
    <SettingsSectionScreen title="Theme" testID="settings-theme" onBack={onBack}>
      {/* 1. Brightness */}
      <View style={styles.group}>
        <SectionLabel>Brightness</SectionLabel>
        <View style={styles.brightnessRow}>
          {BRIGHTNESS_OPTIONS.map((option) => (
            <View key={option.value} style={styles.brightnessCell}>
              <OptionButton
                label={option.label}
                description={option.description}
                selected={vm.brightness === option.value}
                onPress={() => vm.selectBrightness(option.value)}
                testID={`settings-theme-brightness-${option.value}`}
              />
            </View>
          ))}
        </View>
        {showOled && (
          <ToggleRow
            label="OLED Dark"
            description="Pure black"
            value={vm.useOled}
            onValueChange={vm.setUseOled}
            testID="settings-theme-oled"
          />
        )}
        {showPaper && (
          <ToggleRow
            label="Paper Light"
            description="Warm sepia tones"
            value={vm.usePaper}
            onValueChange={vm.setUsePaper}
            testID="settings-theme-paper"
          />
        )}
      </View>

      {/* 2. Accent color */}
      <View style={styles.group}>
        <SectionLabel>Accent Color</SectionLabel>
        <AccentPicker
          accent={vm.accent}
          customStart={vm.customStart}
          customEnd={vm.customEnd}
          visible={vm.accentModalVisible}
          onOpen={vm.openAccentModal}
          onClose={vm.closeAccentModal}
          onSelect={vm.selectAccent}
        />
        {vm.accent === 'custom' && (
          <SettingsCard testID="settings-theme-custom-card">
            <Text style={[styles.hexLabel, { color: theme.colors.textSecondary }]}>
              {vm.useGradients ? 'Gradient Start' : 'Custom Accent Color'}
            </Text>
            <TextInput
              testID="settings-theme-custom-start"
              value={vm.customStartDraft}
              onChangeText={vm.setCustomStartDraft}
              placeholder="#0969DA"
              placeholderTextColor={theme.colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.hexInput,
                {
                  backgroundColor: theme.colors.surfaceHover,
                  borderColor: vm.customStartValid ? theme.colors.border : theme.colors.danger,
                  color: theme.colors.text,
                },
              ]}
            />
            <Text style={[styles.hexLabel, { color: theme.colors.textSecondary }]}>
              Gradient End
            </Text>
            <TextInput
              testID="settings-theme-custom-end"
              value={vm.customEndDraft}
              onChangeText={vm.setCustomEndDraft}
              placeholder="#8250DF"
              placeholderTextColor={theme.colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.hexInput,
                {
                  backgroundColor: theme.colors.surfaceHover,
                  borderColor: vm.customEndValid ? theme.colors.border : theme.colors.danger,
                  color: theme.colors.text,
                },
              ]}
            />
          </SettingsCard>
        )}
      </View>

      {/* 3. Bold mode + gradients */}
      <View style={styles.group}>
        <SectionLabel>Appearance</SectionLabel>
        <ToggleRow
          label="Bold Mode"
          description="Accent nav"
          value={vm.boldMode}
          onValueChange={vm.setBoldMode}
          testID="settings-theme-bold"
        />
        <ToggleRow
          label="Gradients"
          description="Use gradient"
          value={vm.useGradients}
          onValueChange={vm.setUseGradients}
          disabled={!vm.boldMode}
          testID="settings-theme-gradients"
        />
      </View>

      {/* 4. Reset */}
      <Pressable
        testID="settings-theme-reset"
        accessibilityRole="button"
        disabled={vm.resetting}
        onPress={() => void vm.resetToDefaults()}
        style={[
          styles.resetButton,
          {
            backgroundColor: theme.colors.surfaceHover,
            borderColor: theme.colors.danger,
            opacity: vm.resetting ? 0.6 : 1,
          },
        ]}
      >
        <Text style={[styles.resetText, { color: theme.colors.danger }]}>
          {vm.resetting ? 'Resetting…' : 'Reset Theme to Defaults'}
        </Text>
      </Pressable>
    </SettingsSectionScreen>
  );
}

const styles = StyleSheet.create({
  group: { gap: 6 },
  brightnessRow: { flexDirection: 'row', gap: 4 },
  brightnessCell: { flex: 1 },
  hexLabel: { fontSize: 10, fontWeight: '500', marginBottom: 4 },
  hexInput: {
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    fontSize: 12,
    fontFamily: 'monospace',
    marginBottom: 10,
  },
  resetButton: {
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  resetText: { fontSize: 12, fontWeight: '500' },
});
