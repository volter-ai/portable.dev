/**
 * ChatSummaryPanel — the collapsible AI-summary panel. The summary
 * is socket-driven (`chat:summary_updated` → `chatChromeStore`); this renders it
 * when present. Nothing renders without a summary.
 */

import { StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../../theme';

export interface ChatSummaryPanelProps {
  summary?: string;
}

export function ChatSummaryPanel({ summary }: ChatSummaryPanelProps) {
  const { theme } = useAppTheme();
  if (!summary) return null;
  return (
    <View
      style={[
        styles.panel,
        {
          backgroundColor: theme.colors.backgroundElevated,
          borderBottomColor: theme.colors.borderLight,
        },
      ]}
      testID="chat-summary-panel"
    >
      <Text style={[styles.heading, { color: theme.colors.textTertiary }]}>Summary</Text>
      <Text style={[styles.body, { color: theme.colors.text }]} testID="chat-summary-text">
        {summary}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  heading: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  body: { fontSize: 13 },
});
