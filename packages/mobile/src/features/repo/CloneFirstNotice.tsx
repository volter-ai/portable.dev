/**
 * CloneFirstNotice — the shared "clone this repo first" empty state used by the
 * source-control surfaces (Source Control + Worktrees tabs, portable.dev#17).
 *
 * Both tabs operate on the repo's local clone under the workspace dir (git
 * plumbing runs against `/api/source-control/:owner/:repo/*`, which 404s when
 * the repo isn't cloned), so each tab gates on the repo being locally cloned
 * (the OverviewTab `isLocal` 404 pattern) and renders this notice otherwise.
 */

import { StyleSheet, Text, View } from 'react-native';

import { Icon, useAppTheme } from '../../theme';

export interface CloneFirstNoticeProps {
  /** Root testID so each tab can assert its own gate state. */
  testID: string;
  /** Short, surface-specific line (e.g. "to use source control"). */
  detail: string;
}

export function CloneFirstNotice({ testID, detail }: CloneFirstNoticeProps) {
  const { theme } = useAppTheme();
  return (
    <View style={styles.center} testID={testID}>
      <Icon name="download" size={22} color={theme.colors.textSecondary} />
      <Text style={[styles.title, { color: theme.colors.text }]}>Repository not cloned</Text>
      <Text style={[styles.body, { color: theme.colors.textSecondary }]}>
        Clone this repository first {detail}.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 32 },
  title: { fontSize: 15, fontWeight: '600' },
  body: { fontSize: 13, textAlign: 'center', paddingHorizontal: 24, lineHeight: 18 },
});
