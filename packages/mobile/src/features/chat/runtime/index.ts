/**
 * In-chat runtime preview — the draggable bubble + its preview overlay +
 * the tunnel-selection ViewModel. Surfaces the chat's running project:
 * iOS opens the system browser, Android embeds a navigable WebView.
 */

export { ChatRuntimeBubble } from './ChatRuntimeBubble';
export type { ChatRuntimeBubbleProps } from './ChatRuntimeBubble';
export { ChatRuntimePreviewOverlay } from './ChatRuntimePreviewOverlay';
export type { ChatRuntimePreviewOverlayProps } from './ChatRuntimePreviewOverlay';
export { useChatRuntimePreview, selectChatTunnel, isTunnelLive } from './useChatRuntimePreview';
