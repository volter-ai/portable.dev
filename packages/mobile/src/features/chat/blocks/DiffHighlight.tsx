/**
 * DiffHighlight — native diff view for Edit blocks.
 *
 * A line-oriented diff: removed (old) lines render with a red gutter + `-` prefix,
 * added (new) lines with a green gutter + `+` prefix. Common leading/trailing
 * lines shared by both sides render as unchanged context, so a small edit shows
 * only the changed hunk rather than the whole file twice.
 *
 * testIDs: `diff-highlight`, `diff-line-remove`, `diff-line-add`, `diff-line-context`.
 */

import { memo, useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../../theme';

export interface DiffHighlightProps {
  oldString: string;
  newString: string;
  testID?: string;
}

interface DiffLine {
  kind: 'add' | 'remove' | 'context';
  text: string;
}

/**
 * A minimal line diff: strip the common prefix/suffix of unchanged lines, then
 * emit the removed middle (old) followed by the added middle (new). Not a full
 * LCS — enough to show a focused, clearly-marked +/- hunk natively.
 */
function diffLines(oldString: string, newString: string): DiffLine[] {
  const oldLines = oldString.length ? oldString.split('\n') : [];
  const newLines = newString.length ? newString.split('\n') : [];

  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--;
    endNew--;
  }

  const lines: DiffLine[] = [];
  for (let i = 0; i < start; i++) lines.push({ kind: 'context', text: oldLines[i] });
  for (let i = start; i < endOld; i++) lines.push({ kind: 'remove', text: oldLines[i] });
  for (let i = start; i < endNew; i++) lines.push({ kind: 'add', text: newLines[i] });
  for (let i = endOld; i < oldLines.length; i++) lines.push({ kind: 'context', text: oldLines[i] });
  return lines;
}

const PREFIX: Record<DiffLine['kind'], string> = { add: '+', remove: '-', context: ' ' };

// Diff line colors per theme brightness (green = add, red = remove); the bg tints
// are the same translucent green/red on both so the gutter reads on either surface.
const DARK_DIFF = {
  add: { color: '#86efac', backgroundColor: 'rgba(34,197,94,0.15)' },
  remove: { color: '#fca5a5', backgroundColor: 'rgba(239,68,68,0.15)' },
} as const;
const LIGHT_DIFF = {
  add: { color: '#22863a', backgroundColor: 'rgba(34,197,94,0.15)' },
  remove: { color: '#b31d28', backgroundColor: 'rgba(239,68,68,0.12)' },
} as const;

export const DiffHighlight = memo(function DiffHighlight({
  oldString,
  newString,
  testID = 'diff-highlight',
}: DiffHighlightProps) {
  const { theme } = useAppTheme();
  const diff = theme.colors.isLight ? LIGHT_DIFF : DARK_DIFF;
  const lineColor = (kind: DiffLine['kind']) =>
    kind === 'context' ? { color: theme.colors.textSecondary } : diff[kind];
  const lines = useMemo(() => diffLines(oldString, newString), [oldString, newString]);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[
        styles.container,
        { backgroundColor: theme.colors.backgroundElevated, borderColor: theme.colors.border },
      ]}
    >
      <View testID={testID}>
        {lines.map((line, i) => (
          <Text
            key={i}
            testID={`diff-line-${line.kind}`}
            style={[
              styles.line,
              { fontFamily: theme.typography.fontFamilyMono },
              lineColor(line.kind),
            ]}
            selectable
          >
            {PREFIX[line.kind]} {line.text}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  container: { borderRadius: 8, borderWidth: 1, padding: 8 },
  line: { fontSize: 12 },
});
