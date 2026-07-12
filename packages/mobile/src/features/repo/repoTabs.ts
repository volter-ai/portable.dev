/**
 * Repo-page tab catalog + allowed-tabs guard.
 *
 * Canonical order: `overview`, then the two source-control surfaces
 * (`source-control`, `worktrees` — portable.dev#17), then `files` (the
 * directory tree, promoted out of the Overview dashboard), then the GitHub
 * surfaces (`issues` … `settings`). All wired tabs render content;
 * {@link IMPLEMENTED_REPO_TABS} is the full set.
 *
 * `resolveRepoTab` is the allowed-tabs guard: a known tab name is honored,
 * any unknown value falls back to the wired default (`overview`).
 */

export interface RepoTabDef {
  readonly key: RepoTab;
  readonly label: string;
}

/**
 * Ordered tab bar — the single source of the wired tab set + their labels.
 * `prs` renders as "PRs" and `settings` as "Details". `generations` is
 * always wired (the tab itself degrades to an empty list).
 */
export const REPO_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'source-control', label: 'Source Control' },
  { key: 'worktrees', label: 'Worktrees' },
  { key: 'files', label: 'Files' },
  { key: 'issues', label: 'Issues' },
  { key: 'prs', label: 'PRs' },
  { key: 'actions', label: 'Actions' },
  { key: 'workflows', label: 'Workflows' },
  { key: 'generations', label: 'Generations' },
  { key: 'branches', label: 'Branches' },
  { key: 'settings', label: 'Details' },
] as const satisfies readonly RepoTabDef[];

export type RepoTab =
  | 'overview'
  | 'branches'
  | 'issues'
  | 'prs'
  | 'actions'
  | 'workflows'
  | 'generations'
  | 'settings'
  | 'source-control'
  | 'worktrees'
  | 'files';

/** The wired tab keys (recognition set for the allowed-tabs guard). */
export const REPO_TAB_KEYS: readonly RepoTab[] = REPO_TABS.map((t) => t.key);

/** The tab a missing/unknown `?tab=` param falls back to. */
export const DEFAULT_REPO_TAB: RepoTab = 'overview';

/** Tabs that render real content; the rest show a placeholder. */
export const IMPLEMENTED_REPO_TABS: readonly RepoTab[] = [
  'overview',
  'branches',
  'issues',
  'prs',
  'actions',
  'workflows',
  'generations',
  'settings',
  'source-control',
  'worktrees',
  'files',
];

/**
 * Allowed-tabs guard — honor a known tab name, ignore anything else (falls back
 * to {@link DEFAULT_REPO_TAB}).
 */
export function resolveRepoTab(tab: string | null | undefined): RepoTab {
  return tab && (REPO_TAB_KEYS as readonly string[]).includes(tab)
    ? (tab as RepoTab)
    : DEFAULT_REPO_TAB;
}
