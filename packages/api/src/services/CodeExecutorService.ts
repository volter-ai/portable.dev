import * as constants from '@vgit2/shared/constants';

/**
 * Base class for executing TypeScript code with pre-configured API clients and context.
 *
 * This abstract class provides a generic framework for executing user-provided TypeScript
 * code with timeout protection, error handling, and service-specific context setup.
 *
 * Subclasses must implement:
 * - setupContext: Create service-specific context (API clients, auth, etc.)
 * - wrapCode: Optionally modify code before execution
 * - validateResult: Optionally validate execution results
 *
 * Example usage:
 * ```typescript
 * class SlackCodeExecutor extends CodeExecutorService<SlackContext, SlackResult> {
 *   protected async setupContext(params) {
 *     const slack = new WebClient(params.userToken);
 *     return { slack, context: { userId, chatId, emitEvent }, require, console };
 *   }
 *   protected wrapCode(code, context) { return code; }
 *   protected validateResult(result) { }
 * }
 * ```
 */
export abstract class CodeExecutorService<TContext = any, TResult = any> {
  /**
   * Timeout for code execution in milliseconds (default: 30 seconds)
   * Protects against infinite loops and long-running operations
   */
  protected timeout: number = 30000;

  /**
   * Setup service-specific execution context.
   * This method is called before code execution to prepare the environment.
   *
   * @param params - Execution parameters (auth tokens, user info, etc.)
   * @returns Service-specific context object
   *
   * Example:
   * ```typescript
   * protected async setupContext(params) {
   *   const client = new ApiClient(params.token);
   *   return {
   *     client,
   *     context: { userId: params.userId, chatId: params.chatId },
   *     require,
   *     console
   *   };
   * }
   * ```
   */
  protected abstract setupContext(params: any): Promise<TContext>;

  /**
   * Optionally wrap or modify code before execution.
   * This method can add boilerplate, ensure return statements, etc.
   *
   * @param code - User-provided TypeScript code
   * @param context - Execution context from setupContext
   * @returns Modified code string
   *
   * Example:
   * ```typescript
   * protected wrapCode(code: string, context: TContext): string {
   *   // Ensure code returns a value
   *   return code.trim().endsWith(';') ? code : `return (${code});`;
   * }
   * ```
   */
  protected abstract wrapCode(code: string, context: TContext): string;

  /**
   * Optionally validate execution results.
   * This method can check result shape, required fields, etc.
   * Throw an error if validation fails.
   *
   * @param result - Execution result
   *
   * Example:
   * ```typescript
   * protected validateResult(result: any): void {
   *   if (result && typeof result.ok === 'boolean' && !result.ok) {
   *     throw new Error(result.error || 'API call failed');
   *   }
   * }
   * ```
   */
  protected abstract validateResult(result: any): void;

  /**
   * Execute TypeScript code with pre-configured context.
   *
   * Main entry point for code execution. This method:
   * 1. Sets up service-specific context
   * 2. Wraps/modifies code as needed
   * 3. Executes code with timeout protection
   * 4. Validates results
   * 5. Returns formatted success/error response
   *
   * @param params - Execution parameters
   * @param params.code - TypeScript code to execute
   * @param params.description - Optional human-readable description
   * @returns Execution result with success flag, result/error, and description
   *
   * Example:
   * ```typescript
   * const result = await executor.execute({
   *   code: 'return await client.sendMessage({ channel: "#general", text: "Hello!" })',
   *   description: 'Send greeting message',
   *   userToken: 'xoxb-...',
   *   userId: 'U12345',
   *   chatId: 'chat-abc'
   * });
   *
   * if (result.success) {
   *   console.log('Result:', result.result);
   * } else {
   *   console.error('Error:', result.error);
   * }
   * ```
   */
  public async execute(params: {
    code: string;
    description?: string;
    [key: string]: any;
  }): Promise<TResult> {
    try {
      // Step 1: Setup service-specific context (API clients, auth, etc.)
      const context = await this.setupContext(params);

      // Step 2: Wrap/modify code if needed (add boilerplate, ensure return, etc.)
      const wrappedCode = this.wrapCode(params.code, context);

      // Step 3: Execute code with timeout protection
      const result = await this.executeWithTimeout(wrappedCode, context);

      // Step 4: Validate result (check shape, required fields, etc.)
      this.validateResult(result);

      // Step 5: Return success response
      return {
        success: true,
        result,
        description: params.description
      } as TResult;

    } catch (error: any) {
      // Return formatted error response
      return this.formatError(error);
    }
  }

  /**
   * Execute code with timeout protection.
   * Uses Promise.race to enforce maximum execution time.
   *
   * @param code - Wrapped TypeScript code
   * @param context - Execution context
   * @returns Execution result
   * @throws TimeoutError if execution exceeds timeout
   */
  private async executeWithTimeout(code: string, context: TContext): Promise<any> {
    return Promise.race([
      this.executeCode(code, context),
      this.createTimeout()
    ]);
  }

  /**
   * Execute TypeScript code using AsyncFunction.
   *
   * This method uses AsyncFunction to execute user code with provided context.
   * Context keys become function parameters, allowing code to access them directly.
   *
   * Security note: AsyncFunction provides similar isolation to eval() but with
   * cleaner syntax. Code executes in user's authenticated context with same
   * trust model as existing GitHub tools.
   *
   * @param code - Wrapped TypeScript code
   * @param context - Execution context (keys become function parameters)
   * @returns Execution result
   *
   * Example:
   * ```typescript
   * // Context: { slack, context, require, console }
   * // Code: "return await slack.chat.postMessage({ channel: '#general', text: 'Hi' })"
   * // Creates: new AsyncFunction('slack', 'context', 'require', 'console', code)
   * // Calls: fn(slackClient, contextObj, require, console)
   * ```
   */
  private async executeCode(code: string, context: TContext): Promise<any> {
    // Get AsyncFunction constructor (supports async/await natively)
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

    // Extract context keys and values
    // Example: { slack, context, require, console } → ['slack', 'context', 'require', 'console']
    const contextKeys = Object.keys(context as object);
    const contextValues = Object.values(context as object);

    // Create async function with context as parameters
    // Example: new AsyncFunction('slack', 'context', 'require', 'console', code)
    const fn = new AsyncFunction(...contextKeys, code);

    // Execute with context values
    // Example: fn(slackClient, contextObj, require, console)
    return await fn(...contextValues);
  }

  /**
   * Create timeout promise that rejects after configured duration.
   * Used in Promise.race to enforce maximum execution time.
   *
   * @returns Promise that rejects with TimeoutError
   */
  private createTimeout(): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`Code execution timeout (${this.timeout}ms)`)),
        this.timeout
      );
    });
  }

  /**
   * Format error for consistent error responses.
   * Includes error type, message, and stack trace (in development mode only).
   *
   * @param error - Error object
   * @returns Formatted error response
   */
  private formatError(error: any): TResult {
    return {
      success: false,
      error: {
        type: error.name || 'RuntimeError',
        message: error.message || 'Unknown error',
        // Only include stack trace in development mode (security)
        stack: constants.NODE_ENV === 'development' ? error.stack : undefined
      }
    } as TResult;
  }
}
