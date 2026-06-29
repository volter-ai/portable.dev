/**
 * JsonDbAdapter module exports
 *
 * JSON file-backed chat/message persistence. All other domains
 * are delegated to a wrapped adapter.
 */

export { JsonDbAdapter } from './JsonDbAdapter.js';
export { JsonChatStore } from './JsonChatStore.js';
export type { ChatRow, MessageRow } from './JsonChatStore.js';
