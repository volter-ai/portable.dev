/**
 * Custom MCP Server for AskUserQuestion functionality
 *
 * This implements a custom ask_user tool that runs in our application's process,
 * allowing it to properly block execution until user answers arrive via Socket.IO.
 *
 * The native AskUserQuestion tool doesn't work in Claude Agent SDK because it
 * requires an interactive terminal (TTY) which isn't available in subprocess environments.
 *
 * References:
 * - https://github.com/oneryalcin/claude-ask-user-demo
 * - https://oneryalcin.medium.com/when-claude-cant-ask-building-interactive-tools-for-the-agent-sdk-64ccc89558fa
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { convertJsonSchemaToZod } from '@vgit2/shared/mcp';

import type { AskUserQuestion } from '@vgit2/shared/types/chat';

/**
 * Pending question request structure
 * Stores the promise resolve/reject functions to be called when answers arrive
 */
interface PendingQuestionRequest {
  questions: AskUserQuestion[];
  resolve: (answers: Record<string, string[]>) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

/**
 * In-memory storage for pending question requests
 * Maps requestId -> pending request data
 */
const pendingQuestions = new Map<string, PendingQuestionRequest>();

/**
 * Workaround for SDK MCP bug: Store questions by tool_use_id
 * When ClaudeService intercepts ask_user calls, it stores questions here
 * so the handler can retrieve them (since SDK doesn't pass parameters correctly)
 */
export const interceptedQuestions = new Map<string, { questions: any[]; requestId: string }>();

/**
 * Tool schema matching the native AskUserQuestion format
 * This ensures compatibility with Claude's expectations
 */
const ASK_USER_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      description: 'Array of questions to ask the user',
      items: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question text to display to the user',
          },
          header: {
            type: 'string',
            description: 'Short header/label for the question (max 12 chars)',
          },
          options: {
            type: 'array',
            description: 'Available answer options (2-4 options)',
            items: {
              type: 'object',
              properties: {
                label: {
                  type: 'string',
                  description: 'Option label shown to user',
                },
                description: {
                  type: 'string',
                  description: 'Explanation of what this option means',
                },
              },
              required: ['label', 'description'],
            },
            minItems: 2,
            maxItems: 4,
          },
          multiSelect: {
            type: 'boolean',
            description: 'Whether user can select multiple options',
          },
        },
        required: ['question', 'header', 'options', 'multiSelect'],
      },
      minItems: 1,
      maxItems: 4,
    },
  },
  required: ['questions'],
};

/**
 * Format user answers as human-readable text for Claude's context
 *
 * The tool's return value becomes part of Claude's conversation history,
 * so we format it in a clear, readable way that Claude can understand.
 */
function formatAnswersForClaude(
  questions: AskUserQuestion[],
  answers: Record<string, string[]>
): string {
  let text = 'User answered the following questions:\n\n';

  questions.forEach((question, index) => {
    const key = String(index);
    const selectedAnswers = answers[key] || [];

    text += `**${question.header}**\n`;
    text += `Q: ${question.question}\n`;
    text += `A: ${selectedAnswers.join(', ')}\n\n`;
  });

  return text;
}

/**
 * MCP tool handler for ask_user
 *
 * This is the core implementation that:
 * 1. Generates a unique request ID
 * 2. Notifies the client to show the question UI
 * 3. BLOCKS execution until answers arrive (via Promise await)
 * 4. Formats answers as text for Claude's context
 * 5. Returns MCP-compliant response
 */
async function askUserToolHandler(
  args: any,
  context: any
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  // SDK MCP tools might pass actual tool arguments in different places
  // Try multiple sources for the questions parameter
  let questions = args?.questions || args?.input?.questions || context?.questions;

  // If not found, check if args itself is the questions array
  if (!questions && Array.isArray(args)) {
    questions = args;
  }

  // WORKAROUND: Check interceptedQuestions Map (populated by ClaudeService intercept)
  // Try multiple possible locations for the tool use ID
  const toolUseId = args?._meta?.['claudecode/toolUseId'] || context?.toolUseId;
  let requestId: string | undefined;

  if (!questions && toolUseId) {
    const intercepted = interceptedQuestions.get(toolUseId);
    if (intercepted) {
      questions = intercepted.questions;
      requestId = intercepted.requestId;
      // Clean up after retrieval
      interceptedQuestions.delete(toolUseId);
    }
  }

  // If still no questions, try matching by any key in the Map (last resort)
  if (!questions && interceptedQuestions.size > 0) {
    const availableKeys = Array.from(interceptedQuestions.keys());
    if (availableKeys.length > 0) {
      const key = availableKeys[0];
      const intercepted = interceptedQuestions.get(key);
      if (intercepted) {
        questions = intercepted.questions;
        requestId = intercepted.requestId;
        interceptedQuestions.delete(key);
      }
    }
  }

  // Validate questions
  if (!questions || !Array.isArray(questions) || questions.length === 0) {
    const errorMsg =
      'Invalid or missing questions parameter. SDK MCP tool handler did not receive questions data.';
    console.error(`[AskUserMcpServer] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  // Generate requestId if not already set by intercept
  const finalRequestId =
    requestId || `ask-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  console.log(`[AskUserMcpServer] Tool called with requestId: ${finalRequestId}`);
  console.log(`[AskUserMcpServer] Validated ${questions.length} questions`);

  // Notify the client via callback (provided by ClaudeService)
  // Only call if intercept didn't already send questions
  if (context.onQuestionsReady && !requestId) {
    await context.onQuestionsReady(finalRequestId, questions);
  }

  // Create promise that blocks until answers arrive
  const answersPromise = new Promise<Record<string, string[]>>((resolve, reject) => {
    pendingQuestions.set(finalRequestId, {
      questions,
      resolve,
      reject,
      timestamp: Date.now(),
    });

    console.log(`[AskUserMcpServer] Created pending request, waiting for user answers...`);

    // Timeout after 5 minutes (same as other permission requests)
    setTimeout(
      () => {
        const pending = pendingQuestions.get(finalRequestId);
        if (pending) {
          console.warn(`[AskUserMcpServer] Request ${finalRequestId} timed out after 5 minutes`);
          pendingQuestions.delete(finalRequestId);
          reject(new Error('Question timed out - user did not answer within 5 minutes'));
        }
      },
      5 * 60 * 1000
    );
  });

  // BLOCK HERE until user submits answers via Socket.IO
  let answers: Record<string, string[]>;
  try {
    answers = await answersPromise;
    console.log(`[AskUserMcpServer] Received answers for requestId: ${finalRequestId}`, answers);
  } catch (error: any) {
    console.error(`[AskUserMcpServer] Error waiting for answers:`, error);
    throw error;
  }

  // Format answers as human-readable text for Claude's context
  const formattedText = formatAnswersForClaude(questions, answers);

  console.log(`[AskUserMcpServer] Returning formatted answers to Claude:\n${formattedText}`);

  // Return MCP-compliant response
  // The tool's output becomes part of Claude's conversation context
  return {
    content: [
      {
        type: 'text' as const,
        text: formattedText,
      },
    ],
  };
}

/**
 * Public API to submit answers from Socket.IO handler
 *
 * Called by SocketIOService when user submits answers via answer_user_question event.
 * This resolves the pending promise and unblocks the tool handler.
 *
 * @param requestId - Unique request ID generated by tool handler
 * @param answers - User's answers (question index -> selected option labels)
 * @returns true if request was found and resolved, false otherwise
 */
export function submitAnswersToMcp(requestId: string, answers: Record<string, string[]>): boolean {
  const pending = pendingQuestions.get(requestId);

  if (!pending) {
    console.warn(`[AskUserMcpServer] No pending questions found for requestId: ${requestId}`);
    return false;
  }

  console.log(`[AskUserMcpServer] Submitting answers for requestId: ${requestId}`);
  pendingQuestions.delete(requestId);
  pending.resolve(answers);
  return true;
}

/**
 * Create and configure the Ask User MCP server
 *
 * This creates an SDK MCP server with our custom ask_user tool.
 * The server is registered with ClaudeService and made available to Claude.
 *
 * @param contextCallbacks - Callbacks from ClaudeService (e.g., onQuestionsReady)
 * @returns Configured MCP server instance
 */
export function createAskUserMcpServer(contextCallbacks: {
  onQuestionsReady?: (requestId: string, questions: AskUserQuestion[]) => Promise<void>;
}) {
  console.log(`[AskUserMcpServer] Creating MCP server with custom ask_user tool`);

  return createSdkMcpServer({
    name: 'user',
    tools: [
      // SDK 0.3.x validates `inputSchema` and REQUIRES a Zod schema / raw Zod shape —
      // passing the raw JSON Schema object directly now THROWS at server creation
      // ("inputSchema must be a Zod schema or raw shape"). Build the tool via the
      // tool() helper with the JSON Schema converted to a Zod shape, mirroring the
      // other MCP servers (StandardMcpServer etc.). The handler still tolerates
      // missing args via the interception fallback in StreamHandler.
      tool(
        'ask_user',
        `Ask the user multiple-choice questions and get their answers.

Example usage:
{
  "questions": [
    {
      "question": "What framework should we use?",
      "header": "Framework",
      "multiSelect": false,
      "options": [
        {
          "label": "React",
          "description": "Modern UI library with virtual DOM"
        },
        {
          "label": "Vue",
          "description": "Progressive framework with template syntax"
        }
      ]
    }
  ]
}

The user can select from provided options or choose "Other" to provide custom text.`,
        convertJsonSchemaToZod(ASK_USER_SCHEMA) as any,
        // SDK MCP servers pass tool input as first parameter
        (params: any, context: any) =>
          askUserToolHandler(params, { ...context, ...contextCallbacks })
      ),
    ],
    // ask_user must be available from turn 1 (Claude may ask a clarifying question
    // immediately) and must not be deferred behind tool search. SDK 0.3.142+
    // connects MCP servers in the background by default.
    alwaysLoad: true,
  });
}
