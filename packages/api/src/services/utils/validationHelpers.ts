/**
 * Validation Utilities for Chat Operations
 *
 * Centralized validation logic to eliminate code duplication across handlers.
 */

/**
 * Validate chat ID
 * Rejects undefined, null, and string representations of these values
 */
export function validateChatId(chatId: string): { valid: boolean; error?: string } {
  if (!chatId || chatId === "undefined" || chatId === "null") {
    return { valid: false, error: "Invalid chat ID" };
  }
  return { valid: true };
}

/**
 * Validate chat creation data
 * Ensures all required fields are present and valid
 */
export function validateChatCreationData(data: {
  chatId: string;
  title: string;
  owner: string;
  repo: string;
  model?: string;
  permissions?: string;
  agentSetupId?: string;
}): { valid: boolean; error?: string } {
  // Validate chatId
  const chatIdValidation = validateChatId(data.chatId);
  if (!chatIdValidation.valid) {
    return chatIdValidation;
  }

  // Validate title
  if (!data.title || data.title.trim().length === 0) {
    return { valid: false, error: "Title is required" };
  }

  // Validate owner and repo
  if (!data.owner || data.owner.trim().length === 0) {
    return { valid: false, error: "Owner is required" };
  }

  if (!data.repo || data.repo.trim().length === 0) {
    return { valid: false, error: "Repo is required" };
  }

  // Validate model (required for chat directory visibility)
  if (!data.model) {
    return { valid: false, error: "Model is required" };
  }

  // Validate permissions (required for chat directory visibility)
  if (!data.permissions) {
    return { valid: false, error: "Permissions are required" };
  }

  // Validate agent setup ID (required for chat directory visibility)
  if (!data.agentSetupId) {
    return { valid: false, error: "Agent setup ID is required" };
  }

  return { valid: true };
}

/**
 * Validate message data
 * Ensures chatId and content are present
 */
export function validateMessageData(data: {
  chatId: string;
  content: string;
}): { valid: boolean; error?: string } {
  // Validate chatId
  const chatIdValidation = validateChatId(data.chatId);
  if (!chatIdValidation.valid) {
    return chatIdValidation;
  }

  // Content can be empty (for file-only messages)
  return { valid: true };
}
