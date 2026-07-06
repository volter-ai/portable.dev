/**
 * Task-notification display hygiene — re-exported from the single source in
 * `@vgit2/shared/utils/taskNotificationHelpers` (the api strips the same marker when
 * building chat-list previews, so both sides share one implementation; public issue #11).
 * See that module for what a `<task-notification>` blob is and why it must never render.
 */
export {
  isOnlyTaskNotification,
  stripTaskNotifications,
  stripTaskNotificationsForPreview,
} from '@vgit2/shared/utils/taskNotificationHelpers';
