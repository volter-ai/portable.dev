/**
 * Commits settings screen (`/settings/commits`) — the per-user "AI co-author on
 * commits" toggle. Thin view over `useCommitsViewModel`.
 *
 * When ON (default), commits made by the Portable agent include a `Co-Authored-By:`
 * trailer crediting the AI. Turning it OFF is "non-AI-co-author mode": commits are
 * attributed to the user alone, with no AI co-author line. The preference is per-user
 * server state (persisted in user settings) and applies to FUTURE agent sessions.
 *
 * testIDs:
 *   settings-commits            (root; back chevron = settings-commits-back)
 *   settings-commits-loading    (initial settings fetch)
 *   settings-commits-coauthor   (the Switch; value = include co-author)
 */

import { Text, StyleSheet } from 'react-native';

import { useAppTheme } from '../../../../theme';
import { SectionLabel, SectionLoading, SettingsSectionScreen, ToggleRow } from '../../chrome';
import { useCommitsViewModel } from './useCommitsViewModel';

export interface CommitsScreenProps {
  /** Back action override (default chrome `router.back()`); injectable for tests. */
  onBack?: () => void;
}

export function CommitsScreen({ onBack }: CommitsScreenProps) {
  const { theme } = useAppTheme();
  const vm = useCommitsViewModel();

  return (
    <SettingsSectionScreen title="Commits" testID="settings-commits" onBack={onBack}>
      {vm.loading ? (
        <SectionLoading testID="settings-commits-loading" />
      ) : (
        <>
          <SectionLabel>Attribution</SectionLabel>
          <ToggleRow
            testID="settings-commits-coauthor"
            label="AI co-author on commits"
            description="When on, commits made by Portable include a Co-Authored-By trailer crediting the AI. Turn off to attribute commits to you alone."
            value={vm.includeCoAuthoredBy}
            onValueChange={vm.setIncludeCoAuthoredBy}
          />
          <Text style={[styles.footnote, { color: theme.colors.textTertiary }]}>
            Applies to future commits the agent makes. Your git author identity is unchanged.
          </Text>
        </>
      )}
    </SettingsSectionScreen>
  );
}

const styles = StyleSheet.create({
  footnote: { fontSize: 11, lineHeight: 16, paddingHorizontal: 2 },
});
