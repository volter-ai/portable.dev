/**
 * useViewerChat — the viewer's AI actions ("Start issue chat" / "Quick fix" /
 * "Review with AI" / "Quick Merge"): create a `claude_code` chat over the
 * socket with the user's
 * global new-chat prefs, navigate to it, then send the prompt. Buttons are
 * gated on the live socket (`connected`); with no SocketProvider above (or
 * while disconnected) `start`
 * is a no-op returning false.
 */

import { router } from 'expo-router';
import { useState } from 'react';

import { useOptionalSocket, useSocketStore } from '../../socket';
import { useChatStore } from '../../state';

export interface ViewerChatStart {
  title: string;
  prompt: string;
  owner: string;
  repo: string;
}

export interface UseViewerChatOptions {
  /** Navigation seam (default Expo Router's imperative `router.push`). */
  navigate?: (href: string) => void;
  /** Chat-id seam (default `chat-${Date.now()}`). */
  makeChatId?: () => string;
}

export interface UseViewerChat {
  /** Live socket present and connected — the `disabled={!connected}` gate. */
  connected: boolean;
  busy: boolean;
  /** Create the chat + navigate + send the prompt. Resolves true on success. */
  start: (args: ViewerChatStart) => Promise<boolean>;
}

export function useViewerChat(options: UseViewerChatOptions = {}): UseViewerChat {
  const navigate = options.navigate ?? ((href: string) => router.push(href));
  const makeChatId = options.makeChatId ?? (() => `chat-${Date.now()}`);
  const socket = useOptionalSocket();
  const connected = useSocketStore((s) => s.connected);
  const settings = useChatStore((s) => s.newChatSettings);
  const [busy, setBusy] = useState(false);

  const start = async ({ title, prompt, owner, repo }: ViewerChatStart): Promise<boolean> => {
    if (!socket || busy) return false;
    setBusy(true);
    try {
      const chatId = makeChatId();
      await socket.emitters.createChat({
        chatId,
        type: 'claude_code',
        title,
        owner,
        repo,
        model: settings.model,
        permissions: settings.permissions,
        agentSetupId: settings.agentSetupId,
      });
      // Order: navigate to the chat, close the viewer (caller does it on
      // `true`), then the prompt streams in.
      navigate(`/chat/${chatId}`);
      void socket.emitters.sendMessage({
        chatId,
        content: prompt,
        model: settings.model,
        permissions: settings.permissions,
        agentSetupId: settings.agentSetupId,
      });
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { connected: connected && !!socket, busy, start };
}
