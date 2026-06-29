/**
 * Test Message Fixtures
 * Factory functions for creating test message data
 */

import type { BufferedMessage, ChatMessage, ContentBlock } from '@vgit2/shared/types';

/**
 * Create a BufferedMessage with sensible defaults
 */
export function createBufferedMessage(overrides: Partial<BufferedMessage> = {}): BufferedMessage {
  return {
    id: 1,
    type: 'user_message',
    data: { content: 'Test message' },
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Create a ChatMessage with sensible defaults
 */
export function createChatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `msg-${Date.now()}`,
    role: 'user',
    content: 'Test message',
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Create a ContentBlock with sensible defaults
 */
export function createContentBlock(overrides: Partial<ContentBlock> = {}): ContentBlock {
  return {
    type: 'text',
    blockId: `block-${Date.now()}`,
    text: 'Test text block',
    ...overrides,
  };
}

// Predefined test messages for common scenarios

export const testMessages = {
  /**
   * Simple user text message
   */
  userMessage: (content: string): BufferedMessage => createBufferedMessage({
    type: 'user_message',
    data: { content },
  }),

  /**
   * Simple assistant text message
   */
  assistantMessage: (content: string): BufferedMessage => createBufferedMessage({
    type: 'assistant',
    data: {
      blocks: [
        {
          type: 'text',
          text: content,
        },
      ],
    },
  }),

  /**
   * Assistant message with multiple blocks
   */
  assistantWithBlocks: (blocks: ContentBlock[]): BufferedMessage => createBufferedMessage({
    type: 'assistant',
    data: { blocks },
  }),

  /**
   * Chat status update message
   */
  statusUpdate: (status: string, message: string): BufferedMessage => createBufferedMessage({
    type: 'chat_status_update',
    data: { status, message },
  }),

  /**
   * Conversation with multiple messages
   */
  conversation: (exchanges: Array<{ user: string; assistant: string }>): BufferedMessage[] => {
    const messages: BufferedMessage[] = [];
    let id = 1;

    for (const exchange of exchanges) {
      messages.push(createBufferedMessage({
        id: id++,
        type: 'user_message',
        data: { content: exchange.user },
        timestamp: Date.now() + id * 1000,
      }));

      messages.push(createBufferedMessage({
        id: id++,
        type: 'assistant',
        data: {
          blocks: [{ type: 'text', text: exchange.assistant }],
        },
        timestamp: Date.now() + id * 1000,
      }));
    }

    return messages;
  },
};

// Content blocks for testing

export const testBlocks = {
  /**
   * Text block
   */
  textBlock: (text: string): ContentBlock => createContentBlock({
    type: 'text',
    text,
  }),

  /**
   * Bash tool use block
   */
  bashToolBlock: (command: string, description?: string): ContentBlock => createContentBlock({
    type: 'tool_use',
    toolName: 'bash',
    name: 'bash',
    id: `bash-${Date.now()}`,
    toolInput: {
      command,
      description: description || 'Execute bash command',
    },
  }),

  /**
   * Bash tool result block
   */
  bashResultBlock: (output: string, isError: boolean = false): ContentBlock => createContentBlock({
    type: 'tool_result',
    id: `bash-result-${Date.now()}`,
    content: output,
    is_error: isError,
  }),

  /**
   * Read file tool use block
   */
  readToolBlock: (filePath: string): ContentBlock => createContentBlock({
    type: 'tool_use',
    toolName: 'read',
    name: 'read',
    id: `read-${Date.now()}`,
    toolInput: { file_path: filePath },
  }),

  /**
   * Write file tool use block
   */
  writeToolBlock: (filePath: string, content: string): ContentBlock => createContentBlock({
    type: 'tool_use',
    toolName: 'write',
    name: 'write',
    id: `write-${Date.now()}`,
    toolInput: {
      file_path: filePath,
      content,
    },
  }),

  /**
   * Edit file tool use block
   */
  editToolBlock: (filePath: string, oldString: string, newString: string): ContentBlock => createContentBlock({
    type: 'tool_use',
    toolName: 'edit',
    name: 'edit',
    id: `edit-${Date.now()}`,
    toolInput: {
      file_path: filePath,
      old_string: oldString,
      new_string: newString,
    },
  }),

  /**
   * GitHub tool use block
   */
  githubToolBlock: (toolName: string, input: any): ContentBlock => createContentBlock({
    type: 'tool_use',
    toolName,
    name: toolName,
    id: `github-${Date.now()}`,
    toolInput: input,
  }),

  /**
   * Image block
   */
  imageBlock: (dataUrl: string): ContentBlock => createContentBlock({
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: dataUrl,
    },
  }),

  /**
   * Video block
   */
  videoBlock: (url: string): ContentBlock => createContentBlock({
    type: 'video',
    source: url,
  }),

  /**
   * Tool use block needing permission
   */
  permissionRequiredBlock: (toolName: string, input: any): ContentBlock => createContentBlock({
    type: 'tool_use',
    toolName,
    name: toolName,
    id: `permission-${Date.now()}`,
    toolInput: input,
    needsPermission: true,
    permissionRequestId: `perm-${Date.now()}`,
    permissionApproved: false,
  }),

  /**
   * Actions block with suggested actions
   */
  actionsBlock: (actions: Array<{ label: string; prompt: string }>): ContentBlock => createContentBlock({
    type: 'actions',
    actions: actions.map((action, i) => ({
      id: `action-${i}-${Date.now()}`,
      label: action.label,
      prompt: action.prompt,
      actionType: 'send_message' as const,
    })),
  }),

  /**
   * Ask user question block
   */
  askUserQuestionBlock: (question: string, options: string[]): ContentBlock => createContentBlock({
    type: 'ask_user_question',
    askUserQuestionData: {
      questions: [
        {
          question,
          header: 'Choose',
          options: options.map(opt => ({ label: opt, description: opt })),
          multiSelect: false,
        },
      ],
      requestId: `question-${Date.now()}`,
      answered: false,
    },
  }),

  /**
   * Multiple text blocks (for testing accumulation)
   */
  multipleTextBlocks: (texts: string[]): ContentBlock[] => {
    return texts.map(text => testBlocks.textBlock(text));
  },

  /**
   * Complete assistant response with mixed blocks
   */
  mixedBlocks: (): ContentBlock[] => [
    testBlocks.textBlock('Let me help you with that.'),
    testBlocks.bashToolBlock('ls -la', 'List files'),
    testBlocks.bashResultBlock('file1.txt\nfile2.txt\n'),
    testBlocks.textBlock('I found two files in the directory.'),
  ],
};
