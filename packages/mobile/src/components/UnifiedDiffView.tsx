/**
 * UnifiedDiffView — the ONE native unified-diff renderer, extracted verbatim
 * from `PullViewer.tsx`'s `PatchLines`/`FileBlock` (portable.dev#17). Theme-aware
 * add/remove/context tints + `@@` hunk headers; renders a scrollable monospace
 * patch from a unified-diff string with an optional filename header. Shared by
 * the PR Files tab, the source-control Changes view + commit detail, and the
 * per-file diff screen.
 *
 * Large-diff safety: the line split is `useMemo`'d on the diff string, the
 * per-kind color/background maps are `useMemo`'d on the theme, and each line is
 * a `memo`'d `DiffLine` taking precomputed colors — so a re-render that doesn't
 * change the diff or theme re-renders no line.
 */

import { memo, useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useAppTheme, withAlpha } from '../theme';

export interface UnifiedDiffViewProps {
  /** A unified-diff string (the `patch` from git/GitHub). */
  diff: string;
  /** Optional filename — rendered as a header row above the diff when present. */
  filename?: string;
  /** testID for the scrollable patch box (e.g. `pull-viewer-patch-<filename>`). */
  testID?: string;
  /** Caps the scrollable height (default 500, matching the PR Files tab). */
  maxHeight?: number;
  style?: StyleProp<ViewStyle>;
}

type LineKind = 'hunk' | 'add' | 'remove' | 'context';

/** Classify a unified-diff line (verbatim from the original `PatchLines`). */
export function classifyDiffLine(line: string): LineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

const DiffLine = memo(function DiffLine({
  line,
  color,
  backgroundColor,
}: {
  line: string;
  color: string;
  backgroundColor?: string;
}) {
  return <Text style={[styles.patchLine, { color, backgroundColor }]}>{line || ' '}</Text>;
});

export const UnifiedDiffView = memo(function UnifiedDiffView({
  diff,
  filename,
  testID,
  maxHeight = 500,
  style,
}: UnifiedDiffViewProps) {
  const { theme } = useAppTheme();

  const lines = useMemo(
    () => diff.split('\n').map((line) => ({ line, kind: classifyDiffLine(line) })),
    [diff]
  );

  const colorFor = useMemo<Record<LineKind, string>>(
    () => ({
      hunk: theme.colors.textTertiary,
      add: theme.colors.success,
      remove: theme.colors.danger,
      context: theme.colors.textSecondary,
    }),
    [theme]
  );

  const bgFor = useMemo<Record<LineKind, string | undefined>>(
    () => ({
      hunk: undefined,
      add: withAlpha(theme.colors.success, '1A'),
      remove: withAlpha(theme.colors.danger, '1A'),
      context: undefined,
    }),
    [theme]
  );

  return (
    <ScrollView
      style={[styles.patchBox, { borderColor: theme.colors.border, maxHeight }, style]}
      nestedScrollEnabled
      testID={testID}
    >
      {filename ? (
        <Text
          numberOfLines={1}
          style={[
            styles.filename,
            { color: theme.colors.textSecondary, borderBottomColor: theme.colors.border },
          ]}
        >
          {filename}
        </Text>
      ) : null}
      <View style={styles.patchLines}>
        {lines.map(({ line, kind }, index) => (
          <DiffLine key={index} line={line} color={colorFor[kind]} backgroundColor={bgFor[kind]} />
        ))}
      </View>
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  patchBox: { marginTop: 8, borderWidth: 1, borderRadius: 6, maxHeight: 500 },
  filename: {
    fontFamily: 'monospace',
    fontSize: 12,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
  },
  patchLines: { padding: 8 },
  patchLine: { fontFamily: 'monospace', fontSize: 11, lineHeight: 16 },
});
