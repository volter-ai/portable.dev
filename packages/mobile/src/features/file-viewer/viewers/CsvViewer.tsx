/**
 * CsvViewer — native, read-only CSV/TSV table viewer.
 *
 * Parses with PapaParse (`parseCsv`) and
 * renders a native table: a metadata bar ("N rows × M columns"), a sticky header
 * row of sortable column buttons + the data rows, inside a horizontal `ScrollView`
 * (wide tables scroll sideways) and a vertical `FlatList` (long tables virtualize).
 * Tapping a header cycles asc → desc → unsorted on that column (string compare,
 * numeric when both cells parse as numbers).
 *
 * Column widths are AUTO-SIZED from the longest cell value per column (capped at
 * `MAX_COLUMN_WIDTH` so one column can't dominate), replacing the old fixed width.
 * A header-only file (no data rows) renders an explicit empty-table state.
 *
 * v1 is READ-ONLY on both platforms (no inline cell editing) — editable
 * CSV is intentionally out of scope.
 */

import { memo, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../../theme';
import { parseCsv } from '../parseCsv';

export interface CsvViewerProps {
  content: string;
  fileName: string;
}

type SortState = { col: number; dir: 'asc' | 'desc' } | null;

const MIN_COLUMN_WIDTH = 64;
const MAX_COLUMN_WIDTH = 240;
const CHAR_WIDTH = 8; // ~13px monospace-ish glyph advance
const CELL_PADDING = 20;
/** Cap the rows scanned for auto-width so a huge CSV doesn't stall the measure. */
const WIDTH_SAMPLE_ROWS = 1000;

/** Compare two cells: numeric when both parse as finite numbers, else string. */
function compareCells(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)) {
    return na - nb;
  }
  return a.localeCompare(b);
}

export const CsvViewer = memo(function CsvViewer({ content, fileName }: CsvViewerProps) {
  const { theme } = useAppTheme();
  const [sort, setSort] = useState<SortState>(null);
  const parsed = useMemo(() => parseCsv(content, fileName), [content, fileName]);

  // Per-column width from the longest cell value (header + sampled rows), capped.
  const colWidths = useMemo(() => {
    const sample = parsed.rows.slice(0, WIDTH_SAMPLE_ROWS);
    return parsed.headers.map((header, col) => {
      let maxLen = header.length;
      for (const row of sample) {
        const cell = row[col] ?? '';
        if (cell.length > maxLen) maxLen = cell.length;
      }
      return Math.max(
        MIN_COLUMN_WIDTH,
        Math.min(MAX_COLUMN_WIDTH, maxLen * CHAR_WIDTH + CELL_PADDING)
      );
    });
  }, [parsed]);

  const sortedRows = useMemo(() => {
    if (!sort) return parsed.rows;
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...parsed.rows].sort(
      (r1, r2) => factor * compareCells(r1[sort.col] ?? '', r2[sort.col] ?? '')
    );
  }, [parsed.rows, sort]);

  function toggleSort(col: number) {
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: 'asc' };
      if (prev.dir === 'asc') return { col, dir: 'desc' };
      return null; // third tap clears the sort
    });
  }

  if (parsed.error) {
    return (
      <View style={styles.center} testID="file-viewer-csv-error">
        <Text style={[styles.errorText, { color: theme.colors.error }]}>
          Could not parse CSV: {parsed.error}
        </Text>
      </View>
    );
  }

  const rowCount = parsed.rows.length;
  const colCount = parsed.headers.length;

  return (
    <View
      style={[styles.container, { backgroundColor: theme.colors.surface }]}
      testID="file-viewer-csv"
    >
      {/* Metadata bar — row/column counts. */}
      <View style={[styles.metaBar, { borderBottomColor: theme.colors.borderLight }]}>
        <Text style={[styles.metaText, { color: theme.colors.textSecondary }]} testID="csv-meta">
          {rowCount} {rowCount === 1 ? 'row' : 'rows'} × {colCount}{' '}
          {colCount === 1 ? 'column' : 'columns'}
        </Text>
      </View>

      {rowCount === 0 ? (
        <View style={styles.center} testID="csv-empty">
          <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
            This table has no rows.
          </Text>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator>
          <View>
            {/* Header row — sortable column buttons */}
            <View style={[styles.headerRow, { backgroundColor: theme.colors.background }]}>
              {parsed.headers.map((header, idx) => {
                const active = sort?.col === idx;
                const arrow = active ? (sort?.dir === 'asc' ? ' ▲' : ' ▼') : '';
                return (
                  <Pressable
                    key={`h-${idx}`}
                    testID={`csv-header-${idx}`}
                    onPress={() => toggleSort(idx)}
                    style={[
                      styles.headerCell,
                      { width: colWidths[idx], borderColor: theme.colors.border },
                    ]}
                  >
                    <Text
                      style={[styles.headerText, { color: theme.colors.text }]}
                      numberOfLines={1}
                    >
                      {header}
                      {arrow}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Data rows */}
            <FlatList
              testID="csv-rows"
              data={sortedRows}
              keyExtractor={(_, idx) => `row-${idx}`}
              renderItem={({ item, index }) => (
                <View
                  style={[
                    styles.row,
                    index % 2 === 1 && { backgroundColor: theme.colors.surfaceHover },
                  ]}
                  testID={`csv-row-${index}`}
                >
                  {parsed.headers.map((_, col) => (
                    <View
                      key={`c-${col}`}
                      style={[
                        styles.cell,
                        { width: colWidths[col], borderColor: theme.colors.borderLight },
                      ]}
                    >
                      <Text
                        style={[styles.cellText, { color: theme.colors.textSecondary }]}
                        numberOfLines={2}
                      >
                        {item[col] ?? ''}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            />
          </View>
        </ScrollView>
      )}

      {/* Hidden, virtualization-proof row count (FlatList renders ~10 under Jest). */}
      <Text testID="csv-row-count" style={styles.hidden}>
        {sortedRows.length}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
  emptyText: { fontSize: 14, textAlign: 'center' },
  metaBar: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  metaText: { fontSize: 12, fontWeight: '600' },
  headerRow: { flexDirection: 'row' },
  headerCell: {
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 1,
  },
  headerText: { fontSize: 13, fontWeight: '700' },
  row: { flexDirection: 'row' },
  cell: {
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cellText: { fontSize: 13 },
  hidden: { width: 0, height: 0, opacity: 0 },
});
