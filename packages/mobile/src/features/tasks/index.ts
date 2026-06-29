/**
 * Tasks feature barrel — the grouped GitHub issues/PRs dashboard:
 * screen + ViewModel + pure grouping helpers + wire
 * types. Self-contained (never imports the chat barrel).
 */

export { TasksScreen, type TasksScreenProps } from './TasksScreen';
export { useTasks, type UseTasks, type UseTasksOptions } from './useTasks';
export { TaskGroup, type TaskGroupProps } from './TaskGroup';
export { TaskIssueItem, type TaskIssueItemProps } from './TaskIssueItem';
export { TaskItemViewer, type TaskItemViewerProps } from './viewer/TaskItemViewer';
export {
  useViewerChat,
  type UseViewerChat,
  type UseViewerChatOptions,
  type ViewerChatStart,
} from './viewer/useViewerChat';
export * from './viewer/viewerTypes';
export { formatRelativeTime } from './viewer/relativeTime';
export * from './taskHelpers';
export * from './types';
