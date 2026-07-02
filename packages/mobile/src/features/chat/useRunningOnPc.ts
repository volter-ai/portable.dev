/**
 * useRunningOnPc — is this chat's Claude Code session live in a TERMINAL on the
 * PC right now? (rev12 cross-surface presence, PRD D55.)
 *
 * Joins the chat id against the `user:runtime_state` claudeSessions entries
 * with `origin: 'terminal'` — a terminal session's `chatId` is its Claude Code
 * session id, which is also the discovered chat's id, so plain id equality is
 * the join. Api-spawned sessions (`origin` absent/'portable') never match: the
 * chat's own run state already covers those.
 *
 * Imported BY FILE (not a barrel) by the chat-card body and the active-chat
 * header, mirroring the socketStore convention.
 */
import { useRuntimeStore } from '../state/runtimeStore';

import type { RuntimeClaudeSessionPayload } from '@vgit2/shared/types';

/** The chat's live terminal session, or null when none. */
export function useTerminalSession(chatId: string): RuntimeClaudeSessionPayload | null {
  return useRuntimeStore(
    (s) => s.claudeSessions.find((c) => c.origin === 'terminal' && c.chatId === chatId) ?? null
  );
}

export interface RunningOnPc {
  /** A live terminal session exists for this chat. */
  onPc: boolean;
  /** …and a turn is actively in flight there. */
  runningOnPc: boolean;
}

export function useRunningOnPc(chatId: string): RunningOnPc {
  const session = useTerminalSession(chatId);
  return {
    onPc: session !== null,
    runningOnPc: session?.status === 'running',
  };
}
