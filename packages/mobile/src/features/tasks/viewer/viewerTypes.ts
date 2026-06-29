/**
 * Viewer targets — what a tap on a Tasks row opens.
 * `{ kind, owner, repo, number, preloaded? }`, where `preloaded` is the
 * list-row data passed as `issueData`/`prData` to skip the skeleton.
 */

import { repoFullNameOf } from '../taskHelpers';
import type { TaskIssue } from '../types';

export interface ViewerTarget {
  kind: 'issue' | 'pull';
  owner: string;
  repo: string;
  number: number;
  /** Row data for the immediate-render fast path. */
  preloaded?: TaskIssue;
}

/**
 * Derive the viewer target for a Tasks row. `null` when the row has no
 * derivable repo (no `repository.full_name` and no `repository_url`) — the
 * caller falls back to opening `html_url` in the browser (the viewer can't
 * open without owner/repo either).
 */
export function viewerTargetForTaskItem(item: TaskIssue): ViewerTarget | null {
  const fullName = repoFullNameOf(item);
  if (!fullName) return null;
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) return null;
  return {
    kind: item.pull_request ? 'pull' : 'issue',
    owner,
    repo,
    number: item.number,
    preloaded: item,
  };
}

const GITHUB_PR_URL = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

/** Parse a related-PR chip url (`https://github.com/o/r/pull/n`) into a target. */
export function viewerTargetForPrUrl(url: string): ViewerTarget | null {
  const match = url.match(GITHUB_PR_URL);
  if (!match) return null;
  return { kind: 'pull', owner: match[1], repo: match[2], number: Number(match[3]) };
}
