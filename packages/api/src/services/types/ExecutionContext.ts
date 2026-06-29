import { IOutputEmitter } from '../emitters';

/**
 * Context for executing a chat message with Claude.
 *
 * This encapsulates all the information needed to run Claude,
 * regardless of whether the request came from a socket or webhook.
 *
 * The emitter determines how real-time notifications are delivered:
 * - SocketEmitter for live socket connections
 * - NoOpEmitter for headless/routine execution
 *
 * Note: User connection tokens (Google Drive, Slack, GitHub) are managed by
 * ConnectionsService and accessed during tool execution, not passed here.
 */
export interface ExecutionContext {
  /** Chat ID */
  chatId: string;

  /** User email (acts as user ID) */
  userId: string;

  /** GitHub username for git attribution */
  username: string;

  /** JWT auth token — the per-request credential (validated locally) */
  authToken: string;

  /** Output emitter - handles real-time notifications to clients */
  emitter: IOutputEmitter;

  /**
   * App version reported by the client in its Socket.IO handshake
   * (`handshake.auth.appVersion`, from the native build's
   * `Constants.expoConfig.version`). Absent for pre-handshake native RN builds
   * (and for any non-socket / headless execution). Used by the outdated-client
   * notice.
   */
  appVersion?: string;
}
