/**
 * rankSlashCommands — relevance ranking for the `/` command picker.
 *
 * THE BUG THIS FIXES: the picker used to render the filtered list grouped by KIND
 * (skills → commands → built-ins). That makes KIND the primary sort key and ignores
 * how well each item matches what was typed — so `/comp` put every skill whose
 * *description* contained "comp" ABOVE the built-in `compact`, even though `compact`
 * is a perfect name-prefix match. Relevance must win; kind is only a tie-breaker.
 *
 * MODEL (production command-palette behaviour — VS Code / Linear / fzf): a TIERED
 * score, bands spaced so a better tier ALWAYS beats a worse one regardless of the
 * intra-tier nudges. Name matches outrank description matches; an exact/prefix hit
 * outranks a fuzzy one; a typo'd query still resolves last.
 *
 *   1000  exact name
 *   ~900  name prefix                    (`/comp` → `compact`)
 *   ~800  word-boundary prefix           (`/req` → `pull-request`)
 *   ~700  contiguous substring in name   (`/pact` → `compact`)
 *   ~600  subsequence in name (gaps)     (`/cpct` → `compact`)
 *   ~400  substring in description       (secondary field)
 *   ~300  subsequence in description
 *   ~150  name typo (Damerau ≤ k)        (`/comapct` → `compact`)
 *
 * Intra-tier: shorter names win (a query covers more of a short name → more
 * specific), earlier substrings win. Ties break on name length → kind → A→Z so the
 * order is deterministic (never relying on Array.sort stability).
 *
 * An EMPTY query returns the input unchanged — that is "browse mode", where the
 * picker keeps the server's grouped/sorted catalog (the caller renders sections).
 */

import type { SlashCommandInfo } from '@vgit2/shared/types';

const KIND_RANK: Record<SlashCommandInfo['kind'], number> = { skill: 0, command: 1, builtin: 2 };

const NO_MATCH = Number.NEGATIVE_INFINITY;

/** Indices where a token begins: index 0, and any char after a non-alphanumeric separator. */
function wordStarts(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (i === 0 || /[^a-z0-9]/.test(s[i - 1])) out.push(i);
  }
  return out;
}

/**
 * In-order character match (the fzf-style subsequence). Returns 0 when not all query
 * chars appear in order, else a small bonus (capped < 60) that rewards consecutive
 * runs and word-boundary-aligned hits — so `/cpct` matching `compact` densely scores
 * above a scattered match.
 */
function subsequenceBonus(q: string, hay: string): number {
  const starts = new Set(wordStarts(hay));
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let i = 0; i < hay.length && qi < q.length; i++) {
    if (hay[i] !== q[qi]) continue;
    score += 1 + (i === prev + 1 ? 3 : 0) + (starts.has(i) ? 2 : 0);
    prev = i;
    qi++;
  }
  return qi === q.length ? Math.min(60, score) : 0;
}

/**
 * Bounded Damerau-Levenshtein (optimal-string-alignment, transposition-aware) — the
 * most common typo is an adjacent swap (`compact` → `comapct`), which this counts as
 * one edit. Bails to `max + 1` as soon as a row's minimum exceeds the budget.
 */
function damerau(a: string, b: string, max: number): number {
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;

  let prevPrev = new Array<number>(bl + 1).fill(0);
  let prev = new Array<number>(bl + 1);
  let curr = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, prevPrev[j - 2] + 1);
      }
      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > max) return max + 1;
    prevPrev = prev;
    prev = curr;
    curr = new Array<number>(bl + 1);
  }
  return prev[bl];
}

/**
 * Typo tolerance, gated low and only against the NAME's leading window (typos almost
 * always sit at the start of what you've typed). Off for very short queries (they'd
 * match everything). maxEdits scales 1→2 with length.
 */
function typoScore(q: string, name: string): number {
  if (q.length < 3) return NO_MATCH;
  const maxEdits = q.length <= 4 ? 1 : 2;
  let best = maxEdits + 1;
  for (const wlen of [q.length - 1, q.length, q.length + 1]) {
    if (wlen <= 0 || wlen > name.length) continue;
    const d = damerau(q, name.slice(0, wlen), maxEdits);
    if (d < best) best = d;
  }
  return best <= maxEdits ? 200 - 50 * best : NO_MATCH;
}

function scoreName(q: string, n: string): number {
  if (n === q) return 1000;
  // Prefers shorter names within a tier (`compact` > `compactify` for `/comp`).
  const nudge = 50 * (q.length / n.length);
  if (n.startsWith(q)) return 900 + nudge;
  if (wordStarts(n).some((s) => s > 0 && n.startsWith(q, s))) return 800 + nudge;
  const i = n.indexOf(q);
  if (i > 0) return 700 + nudge - Math.min(i, 15); // earlier substring = better
  const sub = subsequenceBonus(q, n);
  if (sub > 0) return 600 + sub;
  return typoScore(q, n);
}

function scoreDescription(q: string, d: string | undefined): number {
  if (!d) return NO_MATCH;
  const dl = d.toLowerCase();
  const i = dl.indexOf(q);
  if (i >= 0) return 400 - Math.min(i, 15);
  const sub = subsequenceBonus(q, dl);
  return sub > 0 ? 300 + sub : NO_MATCH;
}

/** The best relevance score for a single command, or `NO_MATCH` when it doesn't match. */
export function scoreSlashCommand(query: string, cmd: SlashCommandInfo): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  return Math.max(scoreName(q, cmd.name.toLowerCase()), scoreDescription(q, cmd.description));
}

/**
 * Rank the available commands for the typed query, best-match-first. Non-matches are
 * dropped. An empty query returns the catalog UNCHANGED (browse mode — the caller
 * keeps the server's grouped order).
 */
export function rankSlashCommands(query: string, commands: SlashCommandInfo[]): SlashCommandInfo[] {
  const q = query.trim();
  if (!q) return commands;

  return commands
    .map((cmd) => ({ cmd, score: scoreSlashCommand(q, cmd) }))
    .filter((r) => r.score !== NO_MATCH)
    .sort(
      (a, b) =>
        b.score - a.score || // 1. relevance
        a.cmd.name.length - b.cmd.name.length || // 2. shorter wins exact ties
        KIND_RANK[a.cmd.kind] - KIND_RANK[b.cmd.kind] || // 3. kind = weak tie-break only
        a.cmd.name.localeCompare(b.cmd.name) // 4. deterministic
    )
    .map((r) => r.cmd);
}
