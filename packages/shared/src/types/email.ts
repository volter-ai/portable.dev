/**
 * Email template data types
 * Add new email types here as you create templates
 */

export interface WelcomeEmailData {
  username: string;
  app_url: string;
  discord_url: string;
}

export interface RejectionEmailData {
  email: string;
  discord_url: string;
}

// Add more email data types as needed:
// export interface PasswordResetEmailData {
//   username: string;
//   reset_url: string;
//   expires_in: string;
// }

// export interface NotificationEmailData {
//   username: string;
//   notification_title: string;
//   notification_body: string;
//   action_url?: string
// }

/**
 * Union type of all email data types
 */
export interface EmailData {
  welcome: WelcomeEmailData;
  rejection: RejectionEmailData;
  // Add more here as you create them:
  // passwordReset: PasswordResetEmailData;
  // notification: NotificationEmailData;
}

export type EmailType = keyof EmailData;

/**
 * Email send response
 */
export interface EmailSendResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}
