/**
 * parseCsv — PapaParse wrapper for the native CSV viewer.
 *
 * Parses with PapaParse (the AC requires reusing PapaParse):
 * delimiter inferred from the extension (`.tsv` → tab, else comma), empty lines
 * skipped, the first row treated as the header. Framework-free so the table
 * component + its tests stay simple. Returns a discriminated `{ headers, rows }`
 * (or an `error` string) instead of throwing.
 */

import Papa from 'papaparse';

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  /** Set when the content is empty / unparseable; `headers`/`rows` are then empty. */
  error?: string;
}

export function parseCsv(content: string, filename: string): ParsedCsv {
  const isTsv = filename.toLowerCase().endsWith('.tsv');
  const delimiter = isTsv ? '\t' : ',';

  if (!content || content.trim().length === 0) {
    return { headers: [], rows: [], error: 'Empty content' };
  }

  const result = Papa.parse<string[]>(content, { delimiter, skipEmptyLines: true });

  if (result.errors.length > 0) {
    return {
      headers: [],
      rows: [],
      error: result.errors.map((e) => e.message).join(', '),
    };
  }

  const data = result.data;
  if (data.length === 0) {
    return { headers: [], rows: [], error: 'No data rows found' };
  }

  // First row is the header; the rest are data rows. Normalise empty headers.
  const headers = data[0].map((h, idx) => h || `Column ${idx + 1}`);
  return { headers, rows: data.slice(1), error: undefined };
}
