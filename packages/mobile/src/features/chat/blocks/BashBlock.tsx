/**
 * BashBlock / BashOutputBlock — shell command + output.
 *
 * The command renders as syntax-highlighted code, the tool result (stdout/stderr)
 * below it. Per-command favicon/icon detection is dropped (FontAwesome is not
 * bundled); a single terminal glyph stands in.
 */

import { memo } from 'react';
import { StyleSheet, Text } from 'react-native';

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

import { useAppTheme } from '../../../theme';
import { CodeHighlight } from './CodeHighlight';
import { ToolBlockShell } from './ToolBlockShell';
import {
  getToolResultText,
  isToolResultError,
  preview,
  toolInput,
  type ToolResult,
} from './blockHelpers';

export interface ToolBlockProps {
  block: ClaudeStreamBlock;
  result?: ToolResult;
  isRecent?: boolean;
}

export const BashBlock = memo(function BashBlock({ block, result, isRecent }: ToolBlockProps) {
  const { theme } = useAppTheme();
  const input = toolInput(block);
  const command = typeof input.command === 'string' ? input.command : '';
  const description = typeof input.description === 'string' ? input.description : '';
  const output = getToolResultText(result?.content);
  const hasError = isToolResultError(result);

  return (
    <ToolBlockShell
      id="bash"
      label="Bash"
      glyph="❯"
      toolName="Bash"
      preview={preview(description || command)}
      hasError={hasError}
      defaultExpanded={isRecent}
    >
      <CodeHighlight code={command} language="bash" />
      {output ? (
        <Text
          style={[
            styles.output,
            {
              fontFamily: theme.typography.fontFamilyMono,
              color: theme.colors.text,
              backgroundColor: theme.colors.backgroundElevated,
            },
          ]}
        >
          {output}
        </Text>
      ) : null}
    </ToolBlockShell>
  );
});

export const BashOutputBlock = memo(function BashOutputBlock({
  block,
  result,
  isRecent,
}: ToolBlockProps) {
  const { theme } = useAppTheme();
  const input = toolInput(block);
  // BashOutput's text comes from the result; toolInput only carries the shell id.
  const output = getToolResultText(result?.content);
  const hasError = isToolResultError(result);
  const shellId = typeof input.bash_id === 'string' ? input.bash_id : '';

  return (
    <ToolBlockShell
      id="bash-output"
      label="BashOutput"
      glyph="▤"
      toolName="BashOutput"
      preview={preview(shellId)}
      hasError={hasError}
      defaultExpanded={isRecent}
    >
      <Text
        style={[
          styles.output,
          {
            fontFamily: theme.typography.fontFamilyMono,
            color: theme.colors.text,
            backgroundColor: theme.colors.backgroundElevated,
          },
        ]}
      >
        {output}
      </Text>
    </ToolBlockShell>
  );
});

const styles = StyleSheet.create({
  output: {
    fontSize: 12,
    borderRadius: 6,
    padding: 8,
  },
});
