/**
 * Pure grouping / filtering / formatting helpers for the native Tasks page —
 * priority scoring, the
 * local-midnight Done-Today filter, the backlog/owner/state/repo/label/assignee
 * predicate chain, and the In-Review PR→issue resolution algorithm.
 * Framework-free so the whole pipeline unit-tests without mounting the screen.
 *
 * Deliberate quirks (do NOT "fix"):
 *   - The repo filter passes issues/PRs that have NO repo full name.
 *   - The `groupBy` select is a complete no-op and is NOT implemented.
 *   - Related-PR chips only ever appear in the In Review section (the
 *     Done/Todo map lookups use a key that never matches — dead code, dropped).
 *
 * Repo filter behavior:
 *   - `deriveFilterOptions` DOES include PR repos (from `pr.base.repo.nameWithOwner`,
 *     which IS populated by the mobile backend), so a PR-only repo is still
 *     selectable.
 *   - PRs honor the REPO filter too (not only the owner filter), so picking a
 *     repo narrows the In Review section as well — otherwise In Review kept
 *     showing other repos' PRs and the filter looked broken.
 */

import type { TaskIssue, TaskPr, TasksResponse, TasksView } from './types';

/** Distinct values the filter selectors offer. */
export interface TaskFilterSelectOptions {
  /** Sorted owner logins (WITHOUT the 'all' entry — the UI prepends it). */
  owners: string[];
  labels: string[];
  assignees: string[];
  repositories: string[];
}

export type TaskStateFilter = 'open' | 'closed' | 'all';

export interface TaskFilters {
  /** `'all'` or an owner login. Persists across Clear-all. */
  ownerFilter: string;
  /** Backlog items (label `/backlog/i`) hidden unless on. Persists across Clear-all. */
  showBacklog: boolean;
  stateFilter: TaskStateFilter;
  /** Case-insensitive substring of `repository.full_name`. */
  repoFilter: string;
  /** AND logic — an issue must carry EVERY selected label. */
  selectedLabels: string[];
  /** Case-insensitive substring of any assignee login. */
  assigneeFilter: string;
}

export const DEFAULT_TASK_FILTERS: TaskFilters = {
  ownerFilter: 'all',
  showBacklog: false,
  stateFilter: 'open',
  repoFilter: '',
  selectedLabels: [],
  assigneeFilter: '',
};

/** `hasActiveFilters` — owner + backlog are deliberately excluded. */
export function hasActiveTaskFilters(f: TaskFilters): boolean {
  return (
    f.stateFilter !== 'open' || !!f.repoFilter || f.selectedLabels.length > 0 || !!f.assigneeFilter
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `formatTimeAgo`: s → m → h → d → mo (30d) → y (12mo). */
export function formatTimeAgo(date: string, nowMs: number = Date.now()): string {
  const seconds = Math.floor((nowMs - new Date(date).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** Luminance-based black/white text for a GitHub label color (no `#` in input). */
export function getContrastColor(hexColor?: string): '#000000' | '#ffffff' {
  if (!hexColor) return '#ffffff';
  const hex = hexColor.replace('#', '');
  if (hex.length !== 6) return '#ffffff';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return '#ffffff';
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

export function isBacklogItem(issue: TaskIssue): boolean {
  return (issue.labels ?? []).some((l) => !!l.name && /backlog/i.test(l.name));
}

/** Priority score for Todo sorting (descending). */
export function getPriority(issue: TaskIssue, nowMs: number = Date.now()): number {
  let score = 0;
  const names = (issue.labels ?? []).map((l) => l.name ?? '');
  if (names.some((n) => /critical|urgent/i.test(n))) score += 300;
  if (names.some((n) => /priority:high|high priority/i.test(n))) score += 200;
  if (names.some((n) => /priority:medium/i.test(n))) score += 100;
  if (issue.milestone?.due_on) {
    const daysUntilDue = Math.floor((new Date(issue.milestone.due_on).getTime() - nowMs) / DAY_MS);
    if (daysUntilDue < 7) score += 200;
    else if (daysUntilDue < 30) score += 100;
  }
  const daysSinceUpdate = Math.floor((nowMs - new Date(issue.updated_at).getTime()) / DAY_MS);
  score += Math.max(0, 50 - daysSinceUpdate);
  score += Math.min((issue.comments ?? 0) * 5, 50);
  return score;
}

/** Keep issues whose `closed_at` is ≥ the DEVICE-local start of today. */
export function filterDoneToday(issues: TaskIssue[], nowMs: number = Date.now()): TaskIssue[] {
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return issues.filter((issue) => {
    if (!issue.closed_at) return false;
    return new Date(issue.closed_at).getTime() >= startOfToday;
  });
}

/** The `applyFilters` predicate chain. */
export function applyIssueFilters(issues: TaskIssue[], f: TaskFilters): TaskIssue[] {
  return issues.filter((issue) => {
    if (!f.showBacklog && isBacklogItem(issue)) return false;
    if (f.ownerFilter !== 'all') {
      const owner = issue.repository?.owner?.login;
      if (!owner || owner !== f.ownerFilter) return false;
    }
    if (f.stateFilter !== 'all' && issue.state !== f.stateFilter) return false;
    if (
      f.repoFilter &&
      issue.repository?.full_name &&
      !issue.repository.full_name.toLowerCase().includes(f.repoFilter.toLowerCase())
    ) {
      return false;
    }
    if (f.selectedLabels.length > 0) {
      const labelNames = (issue.labels ?? []).map((l) => l.name ?? '');
      if (!f.selectedLabels.every((label) => labelNames.includes(label))) return false;
    }
    if (
      f.assigneeFilter &&
      (!issue.assignees ||
        !issue.assignees.some((a) =>
          a.login.toLowerCase().includes(f.assigneeFilter.toLowerCase())
        ))
    ) {
      return false;
    }
    return true;
  });
}

/**
 * PRs honor the owner AND repo filters (the repo filter applies here
 * too so picking a repo narrows In Review). Like
 * `applyIssueFilters`, a PR lacking repo info PASSES the repo filter. The other
 * issue-only filters (state/label/assignee) deliberately do NOT apply to PRs.
 */
export function applyPrFilters(prs: TaskPr[], filters: TaskFilters): TaskPr[] {
  return prs.filter((pr) => {
    if (filters.ownerFilter !== 'all' && pr.base?.repo?.owner?.login !== filters.ownerFilter) {
      return false;
    }
    const fullName = pr.base?.repo?.nameWithOwner;
    if (
      filters.repoFilter &&
      fullName &&
      !fullName.toLowerCase().includes(filters.repoFilter.toLowerCase())
    ) {
      return false;
    }
    return true;
  });
}

/** The literal `repos/owner/repo` substring of an API url ('' when absent) — the map key. */
export function repoKeyOf(url?: string): string {
  return url?.match(/repos\/([^/]+)\/([^/]+)$/)?.[0] ?? '';
}

/** `owner/repo` of an issue, from `repository.full_name` else `repository_url`. */
export function repoFullNameOf(issue: TaskIssue): string | null {
  if (issue.repository?.full_name) return issue.repository.full_name;
  const match = issue.repository_url?.match(/repos\/([^/]+)\/([^/]+)$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Stable per-item key/testID suffix: `owner/repo#number` (id is NOT unique across repos). */
export function taskItemKey(issue: TaskIssue): string {
  return `${repoFullNameOf(issue) ?? 'unknown'}#${issue.number}`;
}

/** The PR→issue-like conversion (the `pull_request` marker flips PR rendering). */
export function prToIssueLike(pr: TaskPr): TaskIssue {
  const baseRepo = pr.base?.repo;
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    user: pr.user,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    html_url: pr.html_url,
    labels: pr.labels ?? [],
    assignees: pr.assignees,
    comments: pr.comments ?? 0,
    repository_url: pr.repository_url,
    milestone: null,
    closed_at: pr.closed_at ?? null,
    body: pr.body ?? null,
    pull_request: { url: pr.html_url, html_url: pr.html_url },
    repository:
      baseRepo?.owner && baseRepo.name
        ? {
            full_name: `${baseRepo.owner.login}/${baseRepo.name}`,
            owner: { login: baseRepo.owner.login },
            name: baseRepo.name,
          }
        : undefined,
  };
}

export interface RelatedPrChip {
  number: number;
  title: string;
  isDraft?: boolean;
  /** What tapping the chip opens. */
  url: string;
}

/** A pre-resolved In Review row. */
export interface ReviewEntry {
  key: string;
  item: TaskIssue;
  /** The PR chip under a linked issue (absent when the row IS the PR). */
  relatedPR?: RelatedPrChip;
  /** What tapping the row opens (issue url for linked issues, PR url for PR rows). */
  openUrl: string;
}

/**
 * The In Review algorithm: a PR with linked issues renders each
 * linked ISSUE (deduped across PRs — first PR wins, and the key is claimed even
 * when the issue isn't in the map); a linked number missing from the map, or a
 * PR with no links, renders the PR itself as an issue-like row.
 */
export function buildInReview(prs: TaskPr[], issueMap: Map<string, TaskIssue>): ReviewEntry[] {
  const entries: ReviewEntry[] = [];
  const processed = new Set<string>();
  for (const pr of prs) {
    const repoKey = repoKeyOf(pr.repository_url);
    const prEntry = (suffix: string): ReviewEntry => ({
      key: `pr-${pr.number}-${pr.repository_url ?? ''}${suffix}`,
      item: prToIssueLike(pr),
      openUrl: pr.html_url,
    });
    if (pr.linked_issue_numbers && pr.linked_issue_numbers.length > 0) {
      pr.linked_issue_numbers.forEach((issueNum, idx) => {
        const issueKey = `${repoKey}#${issueNum}`;
        if (processed.has(issueKey)) return;
        processed.add(issueKey);
        const linked = issueMap.get(issueKey);
        if (linked) {
          entries.push({
            key: `issue-${issueKey}`,
            item: linked,
            relatedPR: { number: pr.number, title: pr.title, isDraft: pr.draft, url: pr.html_url },
            openUrl: linked.html_url,
          });
        } else {
          entries.push(prEntry(`-${idx}`));
        }
      });
    } else {
      entries.push(prEntry(''));
    }
  }
  return entries;
}

export interface GroupedTasks {
  /** Closed since device-local midnight — collapsed by default. */
  done: TaskIssue[];
  inReview: ReviewEntry[];
  /**
   * The In Review header count + visibility + empty-state input is the
   * FILTERED PR count (`grouped.inReview = filteredPRs`), NOT the
   * resolved row count — one PR closing two issues renders 2 rows but counts 1.
   */
  inReviewPrCount: number;
  /** `my` view only: assigned-to-or-authored-by the user, priority-sorted. */
  todo: TaskIssue[];
  /** `all` view only. */
  todoAssigned: TaskIssue[];
  /** `all` view only — collapsed by default. */
  todoUnassigned: TaskIssue[];
  isEmpty: boolean;
}

const EMPTY_GROUPS: GroupedTasks = {
  done: [],
  inReview: [],
  inReviewPrCount: 0,
  todo: [],
  todoAssigned: [],
  todoUnassigned: [],
  isEmpty: true,
};

/** The `grouped` memo, as a pure function of (data, view, filters). */
export function groupTasks(
  data: TasksResponse | undefined,
  view: TasksView,
  filters: TaskFilters,
  nowMs: number = Date.now()
): GroupedTasks {
  if (!data) return EMPTY_GROUPS;

  const filteredOpen = applyIssueFilters(data.open_issues ?? [], filters);
  const filteredClosed = applyIssueFilters(data.closed_today ?? [], filters);
  const filteredPrs = applyPrFilters(data.prs ?? [], filters);

  const done = filterDoneToday(filteredClosed, nowMs);

  const issueMap = new Map<string, TaskIssue>();
  for (const issue of [...filteredOpen, ...filteredClosed]) {
    issueMap.set(`${repoKeyOf(issue.repository_url)}#${issue.number}`, issue);
  }

  // Issues that have a linked PR move to In Review and leave Todo.
  const linkedKeys = new Set<string>();
  for (const pr of filteredPrs) {
    const repoKey = repoKeyOf(pr.repository_url);
    for (const num of pr.linked_issue_numbers ?? []) linkedKeys.add(`${repoKey}#${num}`);
  }

  const userLogin = data.user?.login;
  const todoItems = filteredOpen
    .filter((i) =>
      view === 'my'
        ? (i.assignees ?? []).some((a) => a.login === userLogin) || i.user?.login === userLogin
        : true
    )
    .sort((a, b) => getPriority(b, nowMs) - getPriority(a, nowMs));
  const todoWithoutPrs = todoItems.filter(
    (i) => !linkedKeys.has(`${repoKeyOf(i.repository_url)}#${i.number}`)
  );

  const inReview = buildInReview(filteredPrs, issueMap);

  const todo = view === 'my' ? todoWithoutPrs : [];
  const todoAssigned =
    view === 'all' ? todoWithoutPrs.filter((i) => (i.assignees ?? []).length > 0) : [];
  const todoUnassigned =
    view === 'all' ? todoWithoutPrs.filter((i) => (i.assignees ?? []).length === 0) : [];

  return {
    done,
    inReview,
    inReviewPrCount: filteredPrs.length,
    todo,
    todoAssigned,
    todoUnassigned,
    isEmpty:
      done.length === 0 &&
      filteredPrs.length === 0 &&
      todo.length === 0 &&
      todoAssigned.length === 0 &&
      todoUnassigned.length === 0,
  };
}

/** Distinct filter options derived from the loaded data. */
export function deriveFilterOptions(data: TasksResponse | undefined): TaskFilterSelectOptions {
  if (!data) return { owners: [], labels: [], assignees: [], repositories: [] };
  const issues = [...(data.open_issues ?? []), ...(data.closed_today ?? [])];

  const owners = new Set<string>();
  for (const issue of issues) {
    const login = issue.repository?.owner?.login;
    if (login) owners.add(login);
  }
  for (const pr of data.prs ?? []) {
    const login = pr.base?.repo?.owner?.login;
    if (login) owners.add(login);
  }

  const labels = new Set<string>();
  const assignees = new Set<string>();
  const repositories = new Set<string>();
  for (const issue of issues) {
    for (const label of issue.labels ?? []) if (label.name) labels.add(label.name);
    for (const a of issue.assignees ?? []) assignees.add(a.login);
    if (issue.repository?.full_name) repositories.add(issue.repository.full_name);
  }
  // PR repos ARE included: the mobile backend populates
  // `pr.base.repo.nameWithOwner`, so a repo whose only task is a PR is still
  // offered in the repo picker (and the PR repo filter narrows it).
  for (const pr of data.prs ?? []) {
    const fullName = pr.base?.repo?.nameWithOwner;
    if (fullName) repositories.add(fullName);
  }

  return {
    owners: Array.from(owners).sort((a, b) => a.localeCompare(b)),
    labels: Array.from(labels).sort(),
    assignees: Array.from(assignees).sort(),
    repositories: Array.from(repositories).sort(),
  };
}

/** Backlog items passing the OWNER filter only (the toggle's `(n)` count). */
export function countBacklog(data: TasksResponse | undefined, ownerFilter: string): number {
  if (!data) return 0;
  const issues = [...(data.open_issues ?? []), ...(data.closed_today ?? [])];
  return issues.filter((issue) => {
    if (ownerFilter !== 'all') {
      const owner = issue.repository?.owner?.login;
      if (!owner || owner !== ownerFilter) return false;
    }
    return isBacklogItem(issue);
  }).length;
}
