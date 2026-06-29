/**
 * FallbackBlock — visible placeholder for unhandled block types.
 *
 * Rather than returning `null` for unknown blocks, we render a
 * small, visible placeholder naming the block/tool so nothing silently vanishes
 * AND so partial coverage during the build-out is obvious. It NEVER
 * dumps raw JSON (the AC's explicit anti-requirement) — only the type/tool name.
 */

import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

import { useAppTheme } from '../../../theme';

export interface FallbackBlockProps {
  block: ClaudeStreamBlock;
}

export const FallbackBlock = memo(function FallbackBlock({ block }: FallbackBlockProps) {
  const { theme } = useAppTheme();
  const label = block.toolName ? `${block.type} · ${block.toolName}` : block.type;
  return (
    <View
      testID="block-fallback"
      style={[
        styles.container,
        { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundElevated },
      ]}
    >
      <Text style={[styles.text, { color: theme.colors.textTertiary }]}>
        Unsupported block: {label}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderRadius: 6,
    padding: 8,
  },
  text: { fontSize: 12, fontStyle: 'italic' },
});
