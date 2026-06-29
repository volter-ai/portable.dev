import { randomUUID } from 'crypto';

import { getGeminiActionExtractionPrompt } from '../../../prompts/actionExtraction.js';
import { loudError, loudWarn } from '../../../utils/loudError.js';

import type { LocalAiHelper } from '../../ai/LocalAiHelper.js';
import type { HandlerDependencies } from '../types.js';
import type { WebSocket } from 'ws';

/**
 * ActionHandler - Manages action extraction from assistant messages
 * Responsibilities:
 * - Extract suggested follow-up actions from assistant responses
 * - Local-first: run a one-shot Claude (Haiku) call on the user's OWN Anthropic
 *   credential (LocalAiHelper)
 * - Send extracted actions to the client
 * - Buffer actions for persistence
 */
export class ActionHandler {
  private chatService: any;
  private socketIOService?: any;
  private localAiHelper?: LocalAiHelper;

  constructor(dependencies: HandlerDependencies) {
    this.chatService = dependencies.chatService;
    this.socketIOService = dependencies.socketIOService;
    this.localAiHelper = dependencies.localAiHelper;
  }

  /**
   * Extract actions from the last assistant message and send to the client
   * @param userId - User ID
   * @param chatId - Chat ID
   * @param ws - WebSocket connection
   * @param authToken - JWT auth token
   */
  async extractAndSendActions(
    userId: string,
    chatId: string,
    ws: WebSocket,
    authToken?: string
  ): Promise<void> {
    console.log(`[ActionHandler] 🔍 extractAndSendActions called for chat ${chatId}`);

    if (!authToken) {
      loudWarn({
        title: 'No Auth Token Provided',
        context: { chatId, userId },
        suggestions: ['This will cause RLS to block database access'],
      });
    }

    try {
      // Get all buffered messages for this chat
      const messages = await this.chatService.getMessages(chatId, authToken);

      if (!messages || messages.length === 0) {
        loudWarn({
          title: 'No Messages Found for Action Extraction',
          context: { chatId },
          suggestions: ['This is likely a race condition - messages not persisted yet'],
        });
        return;
      }

      // Find the most recent assistant response by collecting claude_code_block messages
      // Work backwards from the end to collect only the most recent turn's blocks
      const recentBlocks: any[] = [];

      // Start from the end (most recent) and collect claude_code_blocks
      // Stop when we hit a user_message or a non-idle status update
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];

        if (msg.type === 'claude_code_block') {
          recentBlocks.unshift(msg.data); // Add to front to maintain chronological order
        } else if (msg.type === 'user_message') {
          // Found the user message that started this turn - we have all the blocks
          break;
        } else if (msg.type === 'chat_status_update' && msg.data?.status !== 'idle') {
          // Found a previous status update (running, etc.) - stop here
          break;
        }
        // Skip idle status updates - they mark the end of a turn but we want the blocks before them
      }

      if (recentBlocks.length === 0) {
        loudWarn({
          title: 'No Claude Code Blocks Found',
          context: { chatId },
          details: { messagesChecked: messages.length },
        });
        return;
      }

      console.log(
        `[ActionHandler] ✓ Found ${recentBlocks.length} recent blocks for action extraction`
      );

      // Extract text content from text blocks only
      // ClaudeCodeBlock uses `content` field for text, not `text`
      const textContent = recentBlocks
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.content || block.text || '')
        .join('\n');

      if (!textContent || textContent.trim().length === 0) {
        loudWarn({
          title: 'No Text Content in Blocks',
          details: {
            blocksFound: recentBlocks.length,
            blockTypes: recentBlocks.map((b: any) => b.type).join(', '),
          },
        });
        return;
      }

      // Extract follow-up actions via the user's own local Anthropic credential
      const actions = await this.extractActions(textContent);

      if (actions.length === 0) {
        console.log(`[ActionHandler] No actions extracted from message`);
        return;
      }

      // Find the last TEXT block that was analyzed for action extraction
      // Actions are attached to the specific text block they were extracted from
      // This creates a semantic relationship (like tool_use -> tool_result)
      const textBlocks = recentBlocks.filter((block: any) => block.type === 'text');
      const lastTextBlock = textBlocks[textBlocks.length - 1];
      const sourceBlockId = lastTextBlock?.blockId;

      if (!sourceBlockId) {
        console.log(
          `[ActionHandler] No blockId found on source text block, actions will render at end`
        );
      } else {
        console.log(`[ActionHandler] Actions extracted from block: ${sourceBlockId}`);
      }

      // Send actions block to the client
      const actionsBlock = {
        type: 'actions',
        blockId: randomUUID(), // Unique identifier for the actions block itself
        actions,
        sourceBlockId: sourceBlockId, // The text block these actions were extracted from (like tool_use_id)
      };

      const streamMessage = {
        type: 'claude_code_stream',
        chat_id: chatId,
        tool_use_id: chatId,
        blocks: [actionsBlock],
      };

      ws.send(JSON.stringify(streamMessage));

      // Also emit via Socket.IO for multi-device sync
      if (this.socketIOService) {
        this.socketIOService.broadcastToRoom(chatId, 'claude:stream', {
          chatId,
          block: actionsBlock,
        });
      }

      // Buffer the actions block for persistence
      await this.chatService.bufferMessage(
        userId,
        chatId,
        'claude_code_block',
        actionsBlock,
        authToken
      );

      console.log(`[ActionHandler] ✓ Sent ${actions.length} actions to frontend`);
    } catch (error: any) {
      loudError({
        title: 'Unexpected Error in extractAndSendActions',
        severity: 'error',
        context: { chatId },
        error,
      });
      // Don't rethrow - don't disrupt the conversation
    }
  }

  /**
   * Extract suggested follow-up actions from the assistant's last message.
   *
   * Local-first: runs on the user's OWN Anthropic credential (Haiku) via LocalAiHelper.
   * Action chips are non-critical, so this skips silently (no loud
   * error on every turn) when no local credential is configured.
   *
   * @param textContent - Combined text from the last assistant message
   * @returns Array of MessageAction objects or empty array if extraction is unavailable/fails
   */
  private async extractActions(
    textContent: string
  ): Promise<Array<{ id: string; label: string; prompt: string }>> {
    if (!textContent || textContent.trim().length === 0) {
      return []; // Empty input is valid - just no actions to extract
    }

    const aiHelper = this.localAiHelper;
    if (!aiHelper || !aiHelper.isAvailable()) {
      console.warn('[ActionHandler] No local Anthropic credential — skipping action extraction');
      return [];
    }

    return this.extractActionsWithLocalAi(textContent, aiHelper);
  }

  /**
   * Extract suggested actions via a one-shot Claude (Haiku) call on the user's own
   * Anthropic credential.
   * @param textContent - Combined text from the last assistant message
   * @param aiHelper - the resolved local AI helper
   * @returns Array of MessageAction objects or empty array if extraction fails
   */
  private async extractActionsWithLocalAi(
    textContent: string,
    aiHelper: LocalAiHelper
  ): Promise<Array<{ id: string; label: string; prompt: string }>> {
    try {
      console.log(
        `[ActionHandler] Extracting follow-up actions from text (${textContent.length} chars) via local Anthropic credential (Haiku)...`
      );

      const prompt = getGeminiActionExtractionPrompt(textContent);

      const content = await aiHelper.complete(prompt, {
        temperature: 0.3,
        maxTokens: 1024,
      });

      console.log(
        '[ActionHandler] Extracted content from model (first 500 chars):',
        content.substring(0, 500)
      );

      if (!content) {
        // Non-critical — empty model response just means no action chips this turn.
        console.warn('[ActionHandler] Empty model response — no actions extracted');
        return [];
      }

      // Parse the JSON response
      let parsedResult: any;
      try {
        // Try to extract JSON if wrapped in markdown code blocks
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          parsedResult = JSON.parse(jsonMatch[1]);
        } else {
          parsedResult = JSON.parse(content);
        }
      } catch (parseError: any) {
        loudWarn({
          title: 'Failed to Parse Gemini JSON Response',
          details: {
            parseError: (parseError as Error).message,
            rawResponse: content.substring(0, 1000),
          },
        });
        return [];
      }

      const { reasoning, actions } = parsedResult;

      console.log(`[ActionHandler] Gemini reasoning:`, reasoning);

      if (!Array.isArray(actions)) {
        loudWarn({
          title: 'Invalid Actions Format',
          details: {
            expected: 'array',
            got: typeof actions,
            value: JSON.stringify(actions),
          },
        });
        return [];
      }

      // Add unique IDs and validate
      const validActions = actions
        .filter((action: any) => {
          if (!action.label || !action.prompt) {
            loudWarn({
              title: 'Rejecting Action - Missing Required Fields',
              details: {
                action: JSON.stringify(action),
                required: 'label, prompt',
              },
            });
            return false;
          }
          // Quote must be non-empty string
          if (typeof action.quote !== 'string' || action.quote.trim().length === 0) {
            loudWarn({
              title: 'Rejecting Action - Invalid Quote Field',
              details: {
                quoteType: typeof action.quote,
                quoteValue: JSON.stringify(action.quote),
                action: JSON.stringify(action),
              },
            });
            return false;
          }
          return true;
        })
        .slice(0, 3) // Max 3 actions
        .map((action: any, index: number) => {
          const mappedAction: any = {
            id: `action-${Date.now()}-${index}`,
            label: action.label,
            prompt: action.prompt,
          };

          // Include optional fields if present
          if (action.icon) {
            mappedAction.icon = action.icon;
          }
          if (action.type) {
            mappedAction.type = action.type;
          }
          if (action.actionType) {
            mappedAction.actionType = action.actionType;
          }

          // Include quote for debugging (not sent to the client)
          if (action.quote) {
            mappedAction.quote = action.quote;
          }

          return mappedAction;
        });

      console.log(`[ActionHandler] ✅ Extracted ${validActions.length} follow-up actions`);
      if (validActions.length > 0) {
        console.log(`[ActionHandler] Action labels:`, validActions.map((a) => a.label).join(', '));
      }
      return validActions;
    } catch (error: any) {
      // Action chips are non-critical — degrade to none rather than loud-erroring on every
      // turn (mirrors SuggestionsService / ChatAnalysisService). A failed one-shot AI call
      // (network / rate-limit / credential rejection) must not disrupt the conversation.
      console.error(
        '[ActionHandler] Local Anthropic action extraction failed, returning no actions:',
        error
      );
      return [];
    }
  }
}
