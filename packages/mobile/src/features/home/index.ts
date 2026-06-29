/**
 * Home feature barrel — the home-screen sections that compose the new-chat
 * landing: the floating profile pill, the swipeable
 * recent-repos grid, the "Continue chats" preview, and the repos-error card.
 * `ChatHomeScreen` (in the chat feature) wires these around the `ChatComposer`.
 */

export { ProfilePill, type ProfilePillProps } from './ProfilePill';
export { HomeReposGrid, type HomeReposGridProps } from './HomeReposGrid';
export { NewProjectCard } from './NewProjectCard';
export { NewProjectModal, type NewProjectModalProps } from './NewProjectModal';
export { HomeChatsSection, type HomeChatsSectionProps } from './HomeChatsSection';
export { ChatCardBody, type ChatCardBodyProps } from './ChatCardBody';
export { LinkedIssueBadge, type LinkedIssueBadgeProps } from './LinkedIssueBadge';
export {
  HomeErrorDisplay,
  type HomeErrorInfo,
  type HomeErrorAction,
  type HomeErrorDisplayProps,
} from './HomeErrorDisplay';
export {
  getRelativeTime,
  getRepoFromPath,
  getRepoNameFromPath,
  getRepoOwnerFromPath,
  repoNameFontSize,
  pruneAutopilotStopWord,
} from './homeHelpers';
