/**
 * ActiveChatInteractions — renders the active `ask_user_question` prompt for a
 * chat.
 *
 * Subscribes to `interactionStore.askPrompts[chatId]` (fed by the socket's
 * `ask_user_question` handler) and renders the native `AskUserQuestionBlock` when
 * a prompt is pending. On submit it routes the answers through the chat
 * interaction context (`answer_user_question` + clears the prompt). Renders
 * nothing when there is no pending prompt.
 *
 * The prompt's content is unbounded (N questions + free-text inputs + a shared
 * Submit), so this surface mounts INSIDE the transcript scroller — the
 * `MessageList` `footer` (issue #10). The list owns scrolling the whole prompt
 * (Submit included) and, via `onOtherInputFocus`, keeping a focused "Other"
 * input visible above the keyboard.
 *
 * (Permission / secrets / connection prompts render inline in the message stream
 * via the block renderer; this surface owns only the ask prompt, which is NOT
 * part of the streamed blocks.)
 */

import type { TextInput } from 'react-native';

import { useChatInteraction } from './ChatInteractionContext';
import { AskUserQuestionBlock } from './AskUserQuestionBlock';
import { useInteractionStore } from './interactionStore';

export interface ActiveChatInteractionsProps {
  chatId: string;
  /** Forwarded to {@link AskUserQuestionBlock} — see its `onOtherInputFocus`. */
  onOtherInputFocus?: (input: TextInput | null) => void;
}

export function ActiveChatInteractions({ chatId, onOtherInputFocus }: ActiveChatInteractionsProps) {
  const prompt = useInteractionStore((s) => s.askPrompts[chatId]);
  const interaction = useChatInteraction();

  if (!prompt) return null;

  return (
    <AskUserQuestionBlock
      questions={prompt.questions}
      requestId={prompt.requestId}
      onAnswer={(answers) => interaction?.answerQuestion(prompt.requestId, answers)}
      onOtherInputFocus={onOtherInputFocus}
    />
  );
}
