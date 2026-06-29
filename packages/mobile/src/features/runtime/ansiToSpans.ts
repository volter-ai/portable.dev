/**
 * Tiny ANSI → styled-span parser for the process-output terminal (web
 * `RuntimeProcessDetailInstance` `ansiToReact` parity). Framework-free: returns
 * plain data so a native `<Text>` renderer can map it to colored spans, and so it
 * unit-tests with no renderer.
 *
 * Handles SGR sequences (`\x1b[...m`): reset (0), bold (1), dim (2), normal
 * intensity (22), default fg (39), the 8 standard fg colors (30–37) and the 8
 * bright fg colors (90–97). Background colors (40–47/100–107) are consumed but
 * not rendered. Any other escape sequence (cursor moves, clears, OSC) is stripped.
 */

export interface AnsiSpan {
  text: string;
  /** Resolved hex color for the span's foreground, or undefined for default. */
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

/** Standard 16-color terminal palette (codes 30–37 base, 90–97 bright). */
const FG: Record<number, string> = {
  30: '#000000',
  31: '#ef4444', // red
  32: '#22c55e', // green
  33: '#eab308', // yellow
  34: '#3b82f6', // blue
  35: '#a855f7', // magenta
  36: '#06b6d4', // cyan
  37: '#d1d5db', // white/gray
  90: '#6b7280', // bright black (gray)
  91: '#f87171',
  92: '#4ade80',
  93: '#fde047',
  94: '#60a5fa',
  95: '#c084fc',
  96: '#22d3ee',
  97: '#f9fafb',
};

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

interface SgrState {
  color?: string;
  bold: boolean;
  dim: boolean;
}

function applySgr(state: SgrState, codes: string): void {
  const params = codes === '' ? [0] : codes.split(';').map((n) => parseInt(n, 10) || 0);
  for (const code of params) {
    if (code === 0) {
      state.color = undefined;
      state.bold = false;
      state.dim = false;
    } else if (code === 1) {
      state.bold = true;
    } else if (code === 2) {
      state.dim = true;
    } else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 39) {
      state.color = undefined;
    } else if (FG[code]) {
      state.color = FG[code];
    }
    // 40–47 / 100–107 (bg) and unknown SGR codes are intentionally ignored.
  }
}

/** Parse a string containing ANSI escapes into renderable spans. */
export function ansiToSpans(input: string): AnsiSpan[] {
  if (!input) return [];
  const spans: AnsiSpan[] = [];
  const state: SgrState = { bold: false, dim: false };
  let lastIndex = 0;

  const push = (text: string) => {
    if (!text) return;
    spans.push({
      text,
      color: state.color,
      bold: state.bold || undefined,
      dim: state.dim || undefined,
    });
  };

  let match: RegExpExecArray | null;
  ANSI_RE.lastIndex = 0;
  while ((match = ANSI_RE.exec(input)) !== null) {
    push(input.slice(lastIndex, match.index));
    lastIndex = ANSI_RE.lastIndex;
    // Only `...m` (group 1 defined) is an SGR sequence; others are stripped.
    if (match[1] !== undefined) applySgr(state, match[1]);
  }
  push(input.slice(lastIndex));
  return spans;
}
