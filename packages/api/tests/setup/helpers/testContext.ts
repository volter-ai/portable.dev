/**
 * TestContextBuilder - Fluent builder for ExecutionContext
 *
 * Simplifies creation of ExecutionContext objects for testing.
 * Provides sensible defaults and allows selective overrides.
 *
 * Usage:
 *   const context = new TestContextBuilder()
 *     .withUserId('alice@example.com')
 *     .withChatId('test-chat-123')
 *     .build();
 *
 *   // With custom emitter
 *   const emitter = new TestEmitter();
 *   const context = new TestContextBuilder()
 *     .withEmitter(emitter)
 *     .build();
 */

import type { ExecutionContext } from '../../../src/services/types/ExecutionContext.js';
import { TestEmitter } from './TestEmitter.js';

export class TestContextBuilder {
  private context: Partial<ExecutionContext> = {
    userId: 'test@example.com',
    username: 'testuser',
    chatId: 'test-chat-id',
    authToken: 'test-auth-token',
  };

  /**
   * Set the user ID (email)
   */
  withUserId(userId: string): this {
    this.context.userId = userId;
    return this;
  }

  /**
   * Set the GitHub username
   */
  withUsername(username: string): this {
    this.context.username = username;
    return this;
  }

  /**
   * Set the chat ID
   */
  withChatId(chatId: string): this {
    this.context.chatId = chatId;
    return this;
  }

  /**
   * Set the GitHub OAuth token
   */
  withGitHubToken(token: string): this {
    this.context.githubToken = token;
    return this;
  }

  /**
   * Set the auth token (JWT)
   */
  withAuthToken(token: string): this {
    this.context.authToken = token;
    return this;
  }

  /**
   * Set the Google Drive OAuth token
   */
  withGoogleDriveToken(token: string): this {
    this.context.googleDriveToken = token;
    return this;
  }

  /**
   * Set the Google OAuth refresh token
   */
  withGoogleRefreshToken(token: string): this {
    this.context.googleRefreshToken = token;
    return this;
  }

  /**
   * Set the Slack OAuth token
   */
  withSlackToken(token: string): this {
    this.context.slackToken = token;
    return this;
  }

  /**
   * Set the output emitter
   */
  withEmitter(emitter: TestEmitter): this {
    this.context.emitter = emitter;
    return this;
  }

  /**
   * Build the ExecutionContext
   * Auto-creates a TestEmitter if not provided
   */
  build(): ExecutionContext {
    if (!this.context.emitter) {
      this.context.emitter = new TestEmitter();
    }

    // Validate required fields
    if (!this.context.userId) {
      throw new Error('TestContextBuilder: userId is required');
    }
    if (!this.context.username) {
      throw new Error('TestContextBuilder: username is required');
    }
    if (!this.context.chatId) {
      throw new Error('TestContextBuilder: chatId is required');
    }
    if (!this.context.authToken) {
      throw new Error('TestContextBuilder: authToken is required');
    }

    return this.context as ExecutionContext;
  }

  /**
   * Reset to default values
   */
  reset(): this {
    this.context = {
      userId: 'test@example.com',
      username: 'testuser',
      chatId: 'test-chat-id',
      authToken: 'test-auth-token',
    };
    return this;
  }
}
