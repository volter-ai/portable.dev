/**
 * Chat interaction flows — permission / ask-user / secrets /
 * connection-request wiring on top of the streamed message blocks.
 */

export {
  ChatInteractionProvider,
  useChatInteraction,
  useChatInteractions,
  type ChatInteractionValue,
  type ChatInteractionSocket,
  type ChatInteractionProviderProps,
} from './ChatInteractionContext';
export { ActiveChatInteractions, type ActiveChatInteractionsProps } from './ActiveChatInteractions';
export { AskUserQuestionBlock, type AskUserQuestionBlockProps } from './AskUserQuestionBlock';
export {
  useInteractionStore,
  type InteractionState,
  type AskQuestionPrompt,
  type SecretsStatus,
} from './interactionStore';
