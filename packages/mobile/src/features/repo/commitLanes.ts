/**
 * commitLanes — pure, framework-free multi-lane DAG layout for the commit graph
 * (portable.dev#17). `computeCommitLanes(nodes)` assigns each commit a column from
 * its `parents[]` and emits, per row, the edges that connect it to the row below:
 *
 *   - the FIRST parent continues the commit's lane (same column);
 *   - ADDITIONAL parents allocate/route new lanes (a merge fans out);
 *   - converging lanes (multiple lanes awaiting the same commit) collapse to the
 *     LEFTMOST lane when that commit is drawn.
 *
 * Output per row = `{ column, edges: { fromCol, toCol, color }[] }`, where the
 * edges describe the line segments in the GAP BELOW the row (from this row down
 * to the next). The renderer draws a dot at `column` and a bezier per edge.
 *
 * The input `nodes` are in topological order (children before parents — the
 * order `git log --topo-order` emits and the backend graph endpoint preserves).
 */

import type { CommitGraphNode } from '@vgit2/shared/types';

/** Distinct lane colors, indexed by column (the AC's "distinct color per lane"). */
export const LANE_COLORS = [
  '#3b82f6', // blue
  '#22c55e', // green
  '#f59e0b', // amber
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#ef4444', // red
  '#eab308', // yellow
] as const;

/** Stable color for a lane/column (wraps the palette). */
export function laneColor(column: number): string {
  return LANE_COLORS[((column % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length];
}

/** A single line segment in the gap between a row and the row below it. */
export interface LaneEdge {
  /** Column at the TOP of the gap (this row). */
  fromCol: number;
  /** Column at the BOTTOM of the gap (the next row). */
  toCol: number;
  color: string;
}

/** Per-row layout: the commit's column + the edges leaving it downward. */
export interface LaneRow {
  column: number;
  edges: LaneEdge[];
}

/**
 * Compute the lane layout for a list of commit nodes (topo order). Pure: the
 * same input always yields the same output, so it is straightforward to
 * unit-test (linear history, a branch+merge, multiple parallel branches).
 */
export function computeCommitLanes(nodes: CommitGraphNode[]): LaneRow[] {
  // lanes[col] = the sha that lane (column) is currently tracking, or null = free.
  const lanes: (string | null)[] = [];
  const columnOf: number[] = [];
  // Lane state AFTER processing each row (the state entering the next row).
  const stateAfter: (string | null)[][] = [];
  // Lanes spawned by a commit's ADDITIONAL parents (their lines fan out from the
  // commit's own column, not from the new lane's column).
  const spawned: Set<number>[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const sha = nodes[i].sha;
    const parents = nodes[i].parents ?? [];

    // 1. This commit's column: the leftmost lane awaiting it, else a free lane.
    let myCol = lanes.indexOf(sha);
    if (myCol === -1) {
      myCol = lanes.indexOf(null);
      if (myCol === -1) myCol = lanes.length;
    }
    if (myCol >= lanes.length) lanes[myCol] = null;
    columnOf[i] = myCol;

    // 2. Converging lanes (other lanes awaiting this same sha) collapse to myCol.
    for (let j = 0; j < lanes.length; j++) {
      if (j !== myCol && lanes[j] === sha) lanes[j] = null;
    }

    // 3. Route parents. First parent continues this lane; extras get new lanes.
    const spawnedHere = new Set<number>();
    if (parents.length === 0) {
      lanes[myCol] = null; // root commit — the lane ends here
    } else {
      lanes[myCol] = parents[0];
      for (let k = 1; k < parents.length; k++) {
        const p = parents[k];
        if (lanes.indexOf(p) !== -1) continue; // a lane already awaits this parent
        let slot = lanes.indexOf(null);
        if (slot === -1) slot = lanes.length;
        lanes[slot] = p;
        spawnedHere.add(slot);
      }
    }
    spawned[i] = spawnedHere;
    stateAfter[i] = lanes.slice();
  }

  // Second pass: derive the gap edges for each row from the lane snapshots.
  const rows: LaneRow[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const edges: LaneEdge[] = [];
    if (i < nodes.length - 1) {
      const after = stateAfter[i];
      const nextSha = nodes[i + 1].sha;
      const nextCol = columnOf[i + 1];
      for (let j = 0; j < after.length; j++) {
        if (after[j] == null) continue;
        // Where this lane lands at the next row.
        const toCol = after[j] === nextSha ? nextCol : j;
        // Where this lane's line starts at this row: the commit's own lane and
        // its spawned merge lanes fan out from the commit's column; a passthrough
        // lane stays in its own column.
        const fromCol = j === columnOf[i] || spawned[i].has(j) ? columnOf[i] : j;
        edges.push({ fromCol, toCol, color: laneColor(j) });
      }
    }
    rows.push({ column: columnOf[i], edges });
  }
  return rows;
}

/** Max column index used across rows (for sizing the graph gutter). */
export function maxLaneColumn(rows: LaneRow[]): number {
  let max = 0;
  for (const row of rows) {
    if (row.column > max) max = row.column;
    for (const e of row.edges) {
      if (e.fromCol > max) max = e.fromCol;
      if (e.toCol > max) max = e.toCol;
    }
  }
  return max;
}
