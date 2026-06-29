/**
 * ToolBlockShell — collapsible header/body wrapper for tool blocks.
 *
 * Shared tool-block chrome (an icon glyph + tool name + a
 * one-line preview header that expands to the full body). FontAwesome is not
 * bundled, so the icon is a text/emoji glyph here. Collapsed by default
 * unless `defaultExpanded` (recent blocks auto-expand). An errored
 * tool result tints the header red.
 *
 * Colors follow the live theme. Pass `toolName` to tint the header in the tool's
 * FAMILY color (the `theme.tool.*` palette: Bash dark, Read blue, Edit amber,
 * …) — soft background + colored label/glyph; omit it for a neutral surface header.
 *
 * testIDs: `tool-block-<kebab>` (shell), `tool-block-<kebab>-toggle` (header),
 * `tool-block-<kebab>-body` (expanded body, absent when collapsed).
 */

import { type ReactNode, memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { getToolOperationType, useAppTheme, withAlpha, type ToolColors } from '../../../theme';

export interface ToolBlockShellProps {
  /** Stable kebab id for testIDs (e.g. `bash`, `read`). */
  id: string;
  /** Header label (e.g. "Bash", "Read"). */
  label: string;
  /** Leading glyph (emoji / text icon). */
  glyph: string;
  /** Real tool name → header tinted in its family color (theme.tool.*). */
  toolName?: string;
  /** One-line preview shown when collapsed (command, filename, pattern…). */
  preview?: string;
  /** Optional trailing badge (e.g. "+3 −1", "-i"). */
  badge?: string;
  hasError?: boolean;
  defaultExpanded?: boolean;
  children: ReactNode;
}

export const ToolBlockShell = memo(function ToolBlockShell({
  id,
  label,
  glyph,
  toolName,
  preview,
  badge,
  hasError = false,
  defaultExpanded = false,
  children,
}: ToolBlockShellProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { theme } = useAppTheme();

  // getToolOperationType's return type includes 'error' (a TOOL_COLORS key that is
  // NOT on ToolColorPalette and is never actually returned), so index through a
  // string record — at runtime the key is always a real family.
  const tone: ToolColors | null = toolName
    ? ((theme.tool as unknown as Record<string, ToolColors>)[getToolOperationType(toolName)] ??
      null)
    : null;
  const headerBg = hasError
    ? withAlpha(theme.colors.error, '22')
    : tone
      ? tone.soft
      : theme.colors.surfaceHover;
  const labelColor = hasError ? theme.colors.error : tone ? tone.icon : theme.colors.text;

  return (
    <View style={styles.wrapper} testID={`tool-block-${id}`}>
      <Pressable
        testID={`tool-block-${id}-toggle`}
        accessibilityRole="button"
        style={[styles.header, { backgroundColor: headerBg }]}
        onPress={() => setExpanded((v) => !v)}
      >
        <Text style={[styles.glyph, { color: labelColor }]}>{glyph}</Text>
        <Text style={[styles.label, { color: labelColor }]}>{label}</Text>
        {badge ? (
          <Text
            style={[
              styles.badge,
              { color: theme.colors.textSecondary, backgroundColor: theme.colors.surface },
            ]}
          >
            {badge}
          </Text>
        ) : null}
        {!expanded && preview ? (
          <Text
            style={[
              styles.preview,
              { color: theme.colors.textSecondary, fontFamily: theme.typography.fontFamilyMono },
            ]}
            numberOfLines={1}
          >
            {preview}
          </Text>
        ) : null}
        <Text style={[styles.chevron, { color: theme.colors.textTertiary }]}>
          {expanded ? '▾' : '▸'}
        </Text>
      </Pressable>
      {expanded ? (
        <View style={styles.body} testID={`tool-block-${id}-body`}>
          {children}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: { marginBottom: 6 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 8,
    borderRadius: 6,
  },
  glyph: { fontSize: 14 },
  label: { fontWeight: '600', fontSize: 14 },
  badge: {
    fontSize: 11,
    fontWeight: '600',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  preview: {
    flex: 1,
    fontSize: 12,
    textAlign: 'right',
  },
  chevron: { marginLeft: 'auto' },
  body: { paddingVertical: 6, gap: 6 },
});
