/**
 * ChatInteractionContext — wires the interactive-prompt flows to the socket.
 *
 * The blocks reach into the socket here: the
 * active-chat screen mounts `ChatInteractionProvider` with the current `chatId`
 * and the live socket, and the interaction blocks (Permission / Secrets /
 * ConnectionRequest) + the ask-user prompt consume the handlers via
 * `useChatInteraction()` instead of prop-drilling callbacks through the block
 * renderer. Outside a provider the hook returns `null`, so a block renders inertly
 * (e.g. in the block-renderer unit tests).
 *
 * The four flows:
 *  - `respondToPermission` → `permission:respond` (approve/deny a tool).
 *  - `submitSecrets`       → `secrets:submit`, resolving on the `secrets:submitted`
 *                            confirmation (status driven by the socket handler).
 *  - `answerQuestion`      → `answer_user_question` (fire-and-forget) + clears the
 *                            active prompt.
 *  - `startConnection`     → opens the third-party connection flow (injectable).
 */

import type { SocketAck, SocketEmitters } from '@vgit2/shared/socket';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { useInteractionStore } from './interactionStore';

/** The socket surface the interaction handlers need (structural — eases testing). */
export interface ChatInteractionSocket {
  emitters: Pick<SocketEmitters, 'respondToPermission' | 'answerUserQuestion' | 'submitSecrets'>;
}

/** The handlers the interaction surfaces invoke. */
export interface ChatInteractionValue {
  chatId: string;
  /** Approve/deny a tool-permission request → `permission:respond`. */
  respondToPermission: (requestId: string | undefined, approved: boolean) => void;
  /** Submit secrets → `secrets:submit`; resolves on the server ack. */
  submitSecrets: (secrets: Record<string, string>) => Promise<SocketAck>;
  /** Answer an `ask_user_question` prompt → `answer_user_question` + clear it. */
  answerQuestion: (requestId: string, answers: Record<string, string[]>) => void;
  /** Begin the third-party connection flow for `service`. */
  startConnection: (service: string) => void;
}

const ChatInteractionContext = createContext<ChatInteractionValue | null>(null);

export interface ChatInteractionProviderProps {
  chatId: string;
  /** The live native socket (null before the app-shell mounts the SocketProvider). */
  socket: ChatInteractionSocket | null;
  /**
   * Begin the connection flow for a service. Injectable so the screen can wire it
   * to the in-app OAuth browser (Epic E6 Connections); the test injects a spy.
   * Defaults to a no-op.
   */
  onStartConnection?: (service: string) => void;
  children: ReactNode;
}

/** Build the interaction handlers bound to a socket + chat (the ViewModel). */
export function useChatInteractions(
  deps: Omit<ChatInteractionProviderProps, 'children'>
): ChatInteractionValue {
  const { chatId, socket, onStartConnection } = deps;
  return useMemo<ChatInteractionValue>(
    () => ({
      chatId,
      respondToPermission: (requestId, approved) => {
        if (!socket || !requestId) return;
        void socket.emitters.respondToPermission({ requestId, chatId, approved }).catch(() => {});
      },
      submitSecrets: async (secrets) => {
        if (!socket) return { success: false, error: 'Socket not connected' };
        useInteractionStore.getState().setSecretsStatus(chatId, 'submitting');
        try {
          return await socket.emitters.submitSecrets({ chatId, secrets });
        } catch (err) {
          useInteractionStore.getState().setSecretsStatus(chatId, 'idle');
          throw err;
        }
      },
      answerQuestion: (requestId, answers) => {
        socket?.emitters.answerUserQuestion({
          type: 'answer_user_question',
          request_id: requestId,
          chat_id: chatId,
          answers,
        });
        useInteractionStore.getState().clearAskPrompt(chatId);
      },
      startConnection: (service) => onStartConnection?.(service),
    }),
    [chatId, socket, onStartConnection]
  );
}

export function ChatInteractionProvider({ children, ...deps }: ChatInteractionProviderProps) {
  const value = useChatInteractions(deps);
  return (
    <ChatInteractionContext.Provider value={value}>{children}</ChatInteractionContext.Provider>
  );
}

/** Access the chat interaction handlers. Returns `null` outside a provider. */
export function useChatInteraction(): ChatInteractionValue | null {
  return useContext(ChatInteractionContext);
}
