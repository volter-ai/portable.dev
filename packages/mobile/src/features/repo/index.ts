/**
 * Repo (detail) feature barrel — the RepoPage shell + Overview /
 * Branches tabs and their ViewModels. Distinct from the `repos` feature,
 * which owns the repository LIST.
 */

export { RepoPageScreen, type RepoPageScreenProps } from './RepoPageScreen';
export { useRepoPage, type UseRepoPage, type UseRepoPageOptions } from './useRepoPage';
export { OverviewTab, type OverviewTabProps } from './OverviewTab';
export { FilesTab, type FilesTabProps } from './FilesTab';
export {
  useRepoOverview,
  useRepoDetails,
  type UseRepoOverview,
  type UseRepoOverviewOptions,
  type RepoOverviewDetails,
} from './useRepoOverview';
export { useRepoTree, type RepoTreeEntry, type RepoTreeResponse } from './useRepoTree';
export {
  useRepoBranches,
  buildCompareBranchPrompt,
  BRANCHES_PAGE_SIZE,
  COMPARE_BASE_BRANCH,
  type UseRepoBranches,
  type UseRepoBranchesOptions,
} from './useRepoBranches';
export {
  REPO_TABS,
  REPO_TAB_KEYS,
  DEFAULT_REPO_TAB,
  IMPLEMENTED_REPO_TABS,
  resolveRepoTab,
  type RepoTab,
  type RepoTabDef,
} from './repoTabs';
export { IssuesTab, type IssuesTabProps } from './IssuesTab';
export { PullsTab, type PullsTabProps } from './PullsTab';
export {
  useRepoIssues,
  useRepoLabels,
  useRepoCollaborators,
  ISSUES_PAGE_SIZE,
  type UseRepoIssues,
  type UseRepoLabels,
  type UseRepoCollaborators,
  type IssueState,
  type IssueSort,
  type IssueDirection,
  type IssueListFilters,
} from './useRepoIssues';
export {
  useRepoIssue,
  type UseRepoIssue,
  type IssueComment,
  type IssueTimelineEntry,
} from './useRepoIssue';
export { useRepoPulls, PULLS_PAGE_SIZE, type UseRepoPulls } from './useRepoPulls';
export { useRepoPull, type UseRepoPull, type PullFile } from './useRepoPull';
export { ActionsTab, type ActionsTabProps } from './ActionsTab';
export { WorkflowsTab, type WorkflowsTabProps } from './WorkflowsTab';
export { useRepoActions, ACTIONS_PAGE_SIZE, type UseRepoActions } from './useRepoActions';
export {
  useWorkflowRun,
  type UseWorkflowRun,
  type WorkflowJob,
  type WorkflowStep,
} from './useWorkflowRun';
export {
  useWorkflows,
  type UseWorkflows,
  type WorkflowFileEntry,
  type WorkflowFileContent,
} from './useWorkflows';
export { GenerationsTab, type GenerationsTabProps } from './GenerationsTab';
export {
  useRepoGenerations,
  GENERATIONS_PAGE_SIZE,
  type UseRepoGenerations,
} from './useRepoGenerations';
export { SettingsTab, type SettingsTabProps } from './SettingsTab';
export {
  useRepoSettings,
  type UseRepoSettings,
  type RepoDetails,
  type Collaborator,
} from './useRepoSettings';
export { SourceControlTab, type SourceControlTabProps } from './SourceControlTab';
export { WorktreesTab, type WorktreesTabProps } from './WorktreesTab';
export { WorktreesView, type WorktreesViewProps } from './WorktreesView';
export { WorktreeChangesScreen, type WorktreeChangesScreenProps } from './WorktreeChangesScreen';
export { CloneFirstNotice, type CloneFirstNoticeProps } from './CloneFirstNotice';
export { ChangesView, statusBadgeLetter, type ChangesViewProps } from './ChangesView';
export { FileDiffScreen, type FileDiffScreenProps } from './FileDiffScreen';
export { useWorktrees, type UseWorktrees, type UseWorktreesOptions } from './useWorktrees';
export {
  useWorkingTreeChanges,
  type UseWorkingTreeChanges,
  type UseWorkingTreeChangesOptions,
} from './useWorkingTreeChanges';
export {
  useStageMutations,
  type UseStageMutations,
  type UseStageMutationsOptions,
} from './useStageMutations';
export { useCommit, type UseCommit } from './useCommit';
export { usePushPull, type UsePushPull, type UsePushPullOptions } from './usePushPull';
export { PushPullHeader, type PushPullHeaderProps } from './PushPullHeader';
export { WorktreeChatComposer, type WorktreeChatComposerProps } from './WorktreeChatComposer';
export { useFileDiff, type UseFileDiff } from './useFileDiff';
export {
  CommitGraphView,
  LANE_WIDTH,
  MAX_VISIBLE_LANES,
  relativeCommitDate,
  type CommitGraphViewProps,
} from './CommitGraphView';
export { CommitDetailScreen, type CommitDetailScreenProps } from './CommitDetailScreen';
export { useCommitGraph, type UseCommitGraph, type UseCommitGraphOptions } from './useCommitGraph';
export {
  usePullToRefresh,
  useSourceControlFocusRefresh,
  type PullToRefresh,
} from './sourceControlRefresh';
export { useCommitDetail, splitDiffByFile, type UseCommitDetail } from './useCommitDetail';
export {
  computeCommitLanes,
  laneColor,
  maxLaneColumn,
  LANE_COLORS,
  type LaneRow,
  type LaneEdge,
} from './commitLanes';
