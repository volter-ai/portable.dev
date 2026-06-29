/**
 * interactionStore — per-chat interactive-prompt state.
 *
 * Holds the transient state for the two server-driven interaction prompts that
 * are NOT folded into the streamed message blocks: the active `ask_user_question`
 * prompt and the `secrets:submit` → `secrets:submitted` lifecycle. The socket
 * provider (`useNativeSocket`) folds the `ask_user_question` / `secrets:submitted`
 * server events into this store; the interaction surfaces subscribe to it.
 *
 * (Permission state lives ON the message block — `needsPermission` /
 * `permissionRequestId` set by `chatMessagesStore.markToolPermissionRequired` —
 * mirroring the web, which retroactively updated the tool_use block.)
 *
 * NOT persisted: same in-memory lifecycle as `socketStore` / `chatMessagesStore`,
 * reset on socket teardown.
 */

import type { AskUserQuestion } from '@vgit2/shared/types';
import { create } from 'zustand';

/** An active `ask_user_question` prompt awaiting the user's answers. */
export interface AskQuestionPrompt {
  chatId: string;
  requestId: string;
  questions: AskUserQuestion[];
  /** Block id of the streamed `ask_user` tool_use this prompt corresponds to. */
  toolUseId?: string;
}

/** Secrets-form lifecycle: idle → submitting (emit) → submitted (`secrets:submitted`). */
export type SecretsStatus = 'idle' | 'submitting' | 'submitted';

export interface InteractionState {
  /** chatId → active ask-user-question prompt (undefined when none). */
  askPrompts: Record<string, AskQuestionPrompt | undefined>;
  /** chatId → secrets submission status. */
  secretsStatus: Record<string, SecretsStatus>;

  /** Set / replace the active ask prompt for a chat (`ask_user_question`). */
  setAskPrompt: (prompt: AskQuestionPrompt) => void;
  /** Clear the ask prompt once answered. */
  clearAskPrompt: (chatId: string) => void;
  /** Read the active ask prompt (undefined when none). */
  getAskPrompt: (chatId: string) => AskQuestionPrompt | undefined;

  /** Set the secrets status (`submitting` on emit, `submitted` on ack event). */
  setSecretsStatus: (chatId: string, status: SecretsStatus) => void;
  /** Read the secrets status (`idle` when unset). */
  getSecretsStatus: (chatId: string) => SecretsStatus;

  /** Clear everything — used on socket teardown / unmount. */
  reset: () => void;
}

export const useInteractionStore = create<InteractionState>()((set, get) => ({
  askPrompts: {},
  secretsStatus: {},

  setAskPrompt: (prompt) =>
    set((state) => ({ askPrompts: { ...state.askPrompts, [prompt.chatId]: prompt } })),

  clearAskPrompt: (chatId) =>
    set((state) => {
      if (!(chatId in state.askPrompts)) return {};
      const askPrompts = { ...state.askPrompts };
      delete askPrompts[chatId];
      return { askPrompts };
    }),

  getAskPrompt: (chatId) => get().askPrompts[chatId],

  setSecretsStatus: (chatId, status) =>
    set((state) => ({ secretsStatus: { ...state.secretsStatus, [chatId]: status } })),

  getSecretsStatus: (chatId) => get().secretsStatus[chatId] ?? 'idle',

  reset: () => set({ askPrompts: {}, secretsStatus: {} }),
}));
