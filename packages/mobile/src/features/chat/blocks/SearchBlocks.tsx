/**
 * GrepBlock / GlobBlock — search blocks.
 *
 * A header with the search
 * pattern + match count, expanding to the matched lines/paths. Result text is
 * split into lines; the count drives the collapsed preview.
 */

import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

import { useAppTheme } from '../../../theme';
import { ToolBlockShell } from './ToolBlockShell';
import {
  getToolResultText,
  isToolResultError,
  preview,
  toolInput,
  type ToolResult,
} from './blockHelpers';

interface SearchBlockProps {
  block: ClaudeStreamBlock;
  result?: ToolResult;
  isRecent?: boolean;
}

function resultLines(result?: ToolResult): string[] {
  const text = getToolResultText(result?.content);
  return text ? text.split('\n').filter((line) => line.trim()) : [];
}

export const GrepBlock = memo(function GrepBlock({ block, result, isRecent }: SearchBlockProps) {
  const { theme } = useAppTheme();
  const input = toolInput(block);
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  const caseInsensitive = input['-i'] === true;
  const hasError = isToolResultError(result);
  const lines = resultLines(result);

  return (
    <ToolBlockShell
      id="grep"
      label="Grep"
      glyph="🔍"
      toolName={block.toolName}
      preview={preview(pattern)}
      badge={caseInsensitive ? '-i' : `${lines.length}`}
      hasError={hasError}
      defaultExpanded={isRecent}
    >
      <View testID="grep-results">
        {lines.map((line, i) => (
          <Text
            key={i}
            style={[
              styles.line,
              { color: theme.colors.text, fontFamily: theme.typography.fontFamilyMono },
            ]}
            numberOfLines={1}
          >
            {line}
          </Text>
        ))}
      </View>
    </ToolBlockShell>
  );
});

export const GlobBlock = memo(function GlobBlock({ block, result, isRecent }: SearchBlockProps) {
  const { theme } = useAppTheme();
  const input = toolInput(block);
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  const hasError = isToolResultError(result);
  const lines = resultLines(result);

  return (
    <ToolBlockShell
      id="glob"
      label="Glob"
      glyph="🗂"
      toolName={block.toolName}
      preview={preview(pattern)}
      badge={`${lines.length}`}
      hasError={hasError}
      defaultExpanded={isRecent}
    >
      <View testID="glob-results">
        {lines.map((line, i) => (
          <Text
            key={i}
            style={[
              styles.line,
              { color: theme.colors.text, fontFamily: theme.typography.fontFamilyMono },
            ]}
            numberOfLines={1}
          >
            {line}
          </Text>
        ))}
      </View>
    </ToolBlockShell>
  );
});

const styles = StyleSheet.create({
  line: { fontSize: 12 },
});
