/**
 * DataTransformer - Handles data transformation between database and JavaScript formats
 *
 * Converts between snake_case (database) and camelCase (JavaScript) conventions.
 */

export class DataTransformer {
  /**
   * Transform data for database storage
   */
  toDatabase(data: any): any {
    return this.camelToSnake(data);
  }

  /**
   * Transform data from database to JavaScript format
   */
  fromDatabase(data: any): any {
    return this.snakeToCamel(data);
  }

  /**
   * Convert snake_case to camelCase
   */
  snakeToCamel(data: any): any {
    if (data === null || data === undefined) {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.snakeToCamel(item));
    }

    if (typeof data === 'object') {
      const result: any = {};
      for (const key in data) {
        const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        result[camelKey] = this.snakeToCamel(data[key]);
      }
      return result;
    }

    return data;
  }

  /**
   * Convert camelCase to snake_case
   */
  camelToSnake(data: any): any {
    if (data === null || data === undefined) {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.camelToSnake(item));
    }

    if (typeof data === 'object') {
      const result: any = {};
      for (const key in data) {
        const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
        result[snakeKey] = this.camelToSnake(data[key]);
      }
      return result;
    }

    return data;
  }

  /**
   * Convert boolean fields to numbers for SQLite compatibility
   */
  booleanToNumber(value: boolean | number | null | undefined): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    return value ? 1 : 0;
  }

  /**
   * Transform chat data from database format
   */
  transformChatFromDb(chat: any): any {
    return {
      ...chat,
      hidden: this.booleanToNumber(chat.hidden),
      archived: this.booleanToNumber(chat.archived),
      saved: this.booleanToNumber(chat.saved),
      pinned: this.booleanToNumber(chat.pinned),
      agentSetupId: chat.agent_setup_id,
      parentChatId: chat.parent_chat_id,
      workflowRunId: chat.workflow_run_id,
      repoPath: chat.repo_path,
      repoFullName: chat.repo_full_name,
      sessionId: chat.session_id,
      forkSourceSessionId: chat.fork_source_session_id,
      systemPrompt: chat.system_prompt,
      playwrightDevice: chat.playwright_device,
      lastUpdated: chat.last_updated,
      createdAt: chat.created_at,
      lastReadMessageId: chat.last_read_message_id,
      linkedIssue: chat.linked_issue,
    };
  }

  /**
   * Transform chat data for database storage
   */
  transformChatToDb(chat: any): any {
    const result: any = {};

    // Map camelCase to snake_case
    if (chat.id !== undefined) result.id = chat.id;
    if (chat.userId !== undefined) result.user_id = chat.userId;
    if (chat.type !== undefined) result.type = chat.type;
    if (chat.title !== undefined) result.title = chat.title;
    if (chat.summary !== undefined) result.summary = chat.summary;
    if (chat.status !== undefined) result.status = chat.status;
    if (chat.hidden !== undefined) result.hidden = chat.hidden;
    if (chat.archived !== undefined) result.archived = chat.archived;
    if (chat.lastUpdated !== undefined) result.last_updated = chat.lastUpdated;
    if (chat.repoPath !== undefined) result.repo_path = chat.repoPath;
    if (chat.sessionId !== undefined) result.session_id = chat.sessionId;
    if (chat.forkSourceSessionId !== undefined)
      result.fork_source_session_id = chat.forkSourceSessionId;
    if (chat.systemPrompt !== undefined) result.system_prompt = chat.systemPrompt;
    if (chat.playwrightDevice !== undefined) result.playwright_device = chat.playwrightDevice;
    if (chat.model !== undefined) result.model = chat.model;
    if (chat.permissions !== undefined) result.permissions = chat.permissions;
    if (chat.agentSetupId !== undefined) result.agent_setup_id = chat.agentSetupId;
    if (chat.parentChatId !== undefined) result.parent_chat_id = chat.parentChatId;
    if (chat.workflowRunId !== undefined) result.workflow_run_id = chat.workflowRunId;
    if (chat.createdAt !== undefined) result.created_at = chat.createdAt;
    if (chat.lastReadMessageId !== undefined) result.last_read_message_id = chat.lastReadMessageId;
    if (chat.linkedIssue !== undefined) result.linked_issue = chat.linkedIssue;

    return result;
  }
}
