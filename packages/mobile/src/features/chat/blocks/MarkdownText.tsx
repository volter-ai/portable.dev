/**
 * MarkdownText — renders assistant text as Markdown.
 *
 * Wraps `react-native-markdown-display` (the AC-mandated native Markdown
 * renderer) so all assistant text routes through ONE place. Tests mock
 * `react-native-markdown-display` to a marker so the routing is assertable
 * without loading the real markdown-it parser (see the blocks test + the note in
 * packages/mobile/CLAUDE.md — any test importing the chat blocks must mock it).
 */

import { memo, useMemo } from 'react';
import { View } from 'react-native';
import Markdown from 'react-native-markdown-display';

import { createMarkdownStyles, useAppTheme } from '../../../theme';

export interface MarkdownTextProps {
  content: string;
  testID?: string;
}

export const MarkdownText = memo(function MarkdownText({
  content,
  testID = 'markdown',
}: MarkdownTextProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createMarkdownStyles(theme), [theme]);
  return (
    <View testID={testID}>
      <Markdown style={styles}>{content}</Markdown>
    </View>
  );
});
