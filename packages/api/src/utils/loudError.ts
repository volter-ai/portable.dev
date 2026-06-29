/**
 * Loud Error Utility - Makes errors impossible to miss in logs
 *
 * Creates highly visible error messages with consistent formatting
 */

export type ErrorSeverity = 'critical' | 'error' | 'warning' | 'info';

interface LoudErrorOptions {
  title: string;
  severity?: ErrorSeverity;
  details?: Record<string, any>;
  context?: Record<string, any>;
  suggestions?: string[];
  error?: Error | string;
}

const SEVERITY_CONFIG = {
  critical: {
    emoji: '🚨',
    border: '=',
    color: '\x1b[31m', // Red
  },
  error: {
    emoji: '💥',
    border: '▓',
    color: '\x1b[31m', // Red
  },
  warning: {
    emoji: '⚠️',
    border: '─',
    color: '\x1b[33m', // Yellow
  },
  info: {
    emoji: 'ℹ️',
    border: '·',
    color: '\x1b[36m', // Cyan
  },
} as const;

const RESET_COLOR = '\x1b[0m';
const BORDER_WIDTH = 80;

/**
 * Log a loud error message that's impossible to miss
 *
 * @example
 * loudError({
 *   title: 'ACTION EXTRACTION FAILED',
 *   severity: 'critical',
 *   context: { chatId: 'chat-123', userId: 'user@example.com' },
 *   details: { message: 'No auth token', stage: 'initialization' },
 *   suggestions: [
 *     'Check the local credential configuration',
 *     'Check JWT token is being passed'
 *   ],
 *   error: err
 * });
 */
export function loudError(options: LoudErrorOptions): void {
  const severity = options.severity || 'error';
  const config = SEVERITY_CONFIG[severity];

  const border = config.border.repeat(BORDER_WIDTH);
  const title = `${config.emoji}  ${options.title.toUpperCase()}`;

  // Start with newline and border
  console.error(`\n${config.color}${border}`);
  console.error(title);
  console.error(border);

  // Context (chatId, userId, etc)
  if (options.context && Object.keys(options.context).length > 0) {
    console.error('');
    for (const [key, value] of Object.entries(options.context)) {
      console.error(`${key}: ${value}`);
    }
  }

  // Details (specific error info)
  if (options.details && Object.keys(options.details).length > 0) {
    console.error('');
    for (const [key, value] of Object.entries(options.details)) {
      if (typeof value === 'object') {
        console.error(`${key}: ${JSON.stringify(value, null, 2)}`);
      } else {
        console.error(`${key}: ${value}`);
      }
    }
  }

  // Error object
  if (options.error) {
    console.error('');
    if (typeof options.error === 'string') {
      console.error(`Error: ${options.error}`);
    } else {
      console.error(`Error: ${options.error.message}`);
      if (options.error.stack) {
        console.error(`Stack: ${options.error.stack}`);
      }
    }
  }

  // Suggestions
  if (options.suggestions && options.suggestions.length > 0) {
    console.error('');
    console.error('Possible solutions:');
    options.suggestions.forEach((suggestion) => {
      console.error(`  • ${suggestion}`);
    });
  }

  // Close with border
  console.error(border);
  console.error(RESET_COLOR); // Reset terminal color
}

/**
 * Log a loud warning (less severe than error)
 */
export function loudWarn(options: Omit<LoudErrorOptions, 'severity'>): void {
  loudError({ ...options, severity: 'warning' });
}

/**
 * Log a loud info message
 */
export function loudInfo(options: Omit<LoudErrorOptions, 'severity'>): void {
  loudError({ ...options, severity: 'info' });
}
