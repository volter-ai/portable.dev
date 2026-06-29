/**
 * Chat feature barrel — directory / home / active-chat screens,
 * the directory + settings ViewModels, and the new-chat settings defaults.
 */

export { ChatDirectoryScreen, type ChatDirectoryScreenProps } from './ChatDirectoryScreen';
export { SwipeableChatRow, type SwipeableChatRowProps } from './SwipeableChatRow';
export { ChatHomeScreen, HOME_DRAFT_KEY } from './ChatHomeScreen';
export { ChatComposer, type ChatComposerProps } from './ChatComposer';
export {
  FollowUpComposer,
  type FollowUpComposerProps,
  type FollowUpComposerHandle,
} from './FollowUpComposer';
export {
  dispatchMessageAction,
  ARCHIVE_CHAT_PROMPT,
  type MessageActionHandlers,
} from './messageActions';
export { SelectorSheet, type SelectorOption, type SelectorSheetProps } from './composer';
export {
  useChatComposer,
  DRAFT_DEBOUNCE_MS,
  DEFAULT_AGENT_SETUP,
  type UseChatComposer,
  type UseChatComposerOptions,
  type ProjectSelection,
} from './useChatComposer';
export { HOME_FRAMEWORKS, faviconUrl, type FrameworkOption } from './frameworks';
export {
  createNewChatFlow,
  sanitizeFolderName,
  DEFAULT_FRAMEWORK,
  type NewChatFlowDeps,
  type NewChatFlowResult,
  type NewChatFlowSettings,
  type IntentAnalysis,
  type IntentType,
} from './newChatFlow';
export { ActiveChatScreen } from './ActiveChatScreen';
export { ChatListSync } from './ChatListSync';
export {
  useChatDirectory,
  CHAT_PAGE_SIZE,
  type UseChatDirectory,
  type UseChatDirectoryOptions,
} from './useChatDirectory';
export { useChatSettings, type UseChatSettings } from './useChatSettings';
export { NEW_CHAT_SETTINGS, resolveChatSettings } from './chatSettingsDefaults';

export {
  AttachmentBar,
  ImageGalleryModal,
  useAttachments,
  uploadAttachment,
  type AttachmentBarProps,
  type AttachmentBarHandle,
  type GalleryImage,
  type PickedFile,
  type UploadedAttachment,
} from './attachments';

export { MessageList, type MessageListProps } from './MessageList';
export { TypingIndicator, type TypingIndicatorProps } from './TypingIndicator';
export { getAgentInfo, DEFAULT_AGENT_COLOR, type AgentInfo } from './agentInfo';
export { transformBufferedMessage, transformBufferedMessages } from './messageTransformers';
export { startRepoChatFlow, type StartRepoChatDeps } from './startRepoChat';
export {
  useChatStream,
  type UseChatStream,
  type UseChatStreamOptions,
  type ChatStreamSocket,
} from './useChatStream';
export {
  useChatMessagesStore,
  appendBlockToMessages,
  mergeJoinedHistory,
  RUN_START_SYNC_GRACE_MS,
  type ChatMessagesState,
  type MobileChatMessage,
} from './chatMessagesStore';
export { groupBlocksByAgent, findTaskForParentId, type BlockGroup } from './groupBlocksByAgent';
export {
  ChatInteractionProvider,
  useChatInteraction,
  useChatInteractions,
  ActiveChatInteractions,
  AskUserQuestionBlock,
  useInteractionStore,
  type ChatInteractionValue,
  type ChatInteractionSocket,
  type ChatInteractionProviderProps,
  type ActiveChatInteractionsProps,
  type AskUserQuestionBlockProps,
  type AskQuestionPrompt,
  type SecretsStatus,
} from './interactions';
export {
  BlockRenderer,
  TOOL_RENDERERS,
  renderMessageBlocks,
  consolidateBlocks,
  type BlockRendererProps,
  type ToolResult,
} from './blocks';
export {
  ChatChrome,
  GitStatusBanner,
  GitStatusIndicators,
  ContainerStatusBanner,
  QuickActionsBar,
  ChatSummaryPanel,
  RuntimeIndicator,
  useChatChrome,
  useChatRepoPath,
  useChatChromeStore,
  type ChatChromeProps,
  type UseChatChromeResult,
  type ContainerStatus,
} from './chrome';
