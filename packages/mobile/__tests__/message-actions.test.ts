/**
 * AI follow-up action-button dispatch.
 *
 * Pure unit tests for `dispatchMessageAction`, the framework-free core behind the
 * `ActionsBlock` chip taps. Covers the exact branch table:
 *   - archive (`type:'archive'` OR the `__archive_chat__` prompt) → send;
 *   - `actionType:'prefill_input'` → prefill;
 *   - `actionType:'send_message'` → send;
 *   - no actionType → ignored (NO DEFAULTS), logged via console.error.
 *
 * `messageActions.ts` imports only the `MessageAction` TYPE (Babel-erased), so no
 * native-module mocks are needed — import the module file directly.
 */

import type { MessageAction } from '@vgit2/shared/types';

import {
  ARCHIVE_CHAT_PROMPT,
  dispatchMessageAction,
  type MessageActionHandlers,
} from '../src/features/chat/messageActions';

function makeHandlers(): { handlers: MessageActionHandlers; send: jest.Mock; prefill: jest.Mock } {
  const send = jest.fn();
  const prefill = jest.fn();
  return { handlers: { send, prefill }, send, prefill };
}

describe('dispatchMessageAction', () => {
  it("type:'archive' → sends the prompt (the backend archive handler), never prefill", () => {
    const { handlers, send, prefill } = makeHandlers();
    const action: MessageAction = {
      id: 'a',
      label: 'Archive',
      prompt: ARCHIVE_CHAT_PROMPT,
      type: 'archive',
    };

    dispatchMessageAction(action, handlers);

    expect(send).toHaveBeenCalledWith(ARCHIVE_CHAT_PROMPT);
    expect(prefill).not.toHaveBeenCalled();
  });

  it('the __archive_chat__ prompt → sends, even with actionType present', () => {
    const { handlers, send, prefill } = makeHandlers();
    // The magic prompt takes precedence over a (stray) actionType.
    const action: MessageAction = {
      id: 'a',
      label: 'Archive',
      prompt: ARCHIVE_CHAT_PROMPT,
      actionType: 'prefill_input',
    };

    dispatchMessageAction(action, handlers);

    expect(send).toHaveBeenCalledWith(ARCHIVE_CHAT_PROMPT);
    expect(prefill).not.toHaveBeenCalled();
  });

  it("actionType:'prefill_input' → pre-fills the composer, does not send", () => {
    const { handlers, send, prefill } = makeHandlers();
    const action: MessageAction = {
      id: 'a',
      label: 'Refine',
      prompt: 'Add error handling to ',
      actionType: 'prefill_input',
    };

    dispatchMessageAction(action, handlers);

    expect(prefill).toHaveBeenCalledWith('Add error handling to ');
    expect(send).not.toHaveBeenCalled();
  });

  it("actionType:'send_message' → sends immediately, no prefill", () => {
    const { handlers, send, prefill } = makeHandlers();
    const action: MessageAction = {
      id: 'a',
      label: 'Start fix',
      prompt: 'Fix the failing test',
      actionType: 'send_message',
    };

    dispatchMessageAction(action, handlers);

    expect(send).toHaveBeenCalledWith('Fix the failing test');
    expect(prefill).not.toHaveBeenCalled();
  });

  it('no actionType → ignored (NO DEFAULTS), logged once', () => {
    const { handlers, send, prefill } = makeHandlers();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const action: MessageAction = { id: 'a', label: 'Mystery', prompt: 'do something' };

    dispatchMessageAction(action, handlers);

    expect(send).not.toHaveBeenCalled();
    expect(prefill).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
