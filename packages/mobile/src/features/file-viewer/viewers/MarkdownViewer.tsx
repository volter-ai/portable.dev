/**
 * MarkdownViewer — native markdown file viewer.
 *
 * Renders the file body through `MarkdownText`, which wraps
 * `react-native-markdown-display` (the AC-mandated native Markdown renderer) —
 * the same path the Overview README and assistant text blocks use.
 * Imports the `MarkdownText` FILE directly (not the chat barrel) to keep
 * expo-audio / socket out of the module graph.
 */

import { memo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { useAppTheme } from '../../../theme';
import { MarkdownText } from '../../chat/blocks/MarkdownText';

export interface MarkdownViewerProps {
  content: string;
}

export const MarkdownViewer = memo(function MarkdownViewer({ content }: MarkdownViewerProps) {
  const { theme } = useAppTheme();
  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.colors.surface }]}
      testID="file-viewer-markdown"
    >
      <MarkdownText content={content} testID="markdown" />
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, padding: 12 },
});
