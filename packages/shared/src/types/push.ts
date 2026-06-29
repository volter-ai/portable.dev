/**
 * @vgit2/shared/types/push
 *
 * The PC -> gateway notify contract. The user's PC (api) asks the public
 * gateway to deliver a push notification to the user's mobile device tokens;
 * the gateway holds the FCM/VAPID credentials and fans the message out.
 *
 * These types are the single source of truth shared between the api notify
 * client and the gateway notify route handler — keeping them here guarantees
 * the wire shape cannot drift between the two packages.
 */

/** The user-visible notification content + routing metadata. */
export interface NotifyPayload {
  title: string;
  body: string;
  /** Chat the notification deep-links into (opened on tap). */
  chatId?: string;
  /** Collapse key — a newer notification with the same tag replaces the prior. */
  tag?: string;
  /** Notification icon URL. */
  icon?: string;
  /** App badge count to set. */
  badge?: number;
}

/** Request the PC sends to the gateway to deliver a push to its device tokens. */
export interface NotifyRequest {
  pcId: string;
  tokens: string[];
  payload: NotifyPayload;
}

/** Per-token delivery outcome. */
export interface NotifyResult {
  token: string;
  ok: boolean;
  error?: string;
}

/** Aggregate result of a notify fan-out (one entry per requested token). */
export interface NotifyResponse {
  results: NotifyResult[];
}
