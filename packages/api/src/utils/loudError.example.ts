/**
 * Example usage of the loudError utility
 *
 * This file shows how to use loudError for different scenarios
 */

import { loudError, loudWarn } from './loudError.js';

// Example 1: Critical error with full context
function exampleCriticalError() {
  try {
    throw new Error('Database connection failed');
  } catch (err) {
    loudError({
      title: 'Database Connection Failed',
      severity: 'critical',
      context: {
        host: 'localhost:5432',
        database: 'vgit2',
        user: 'admin'
      },
      error: err as Error,
      suggestions: [
        'Check if PostgreSQL is running',
        'Verify connection credentials in .env',
        'Check network connectivity'
      ]
    });
  }
}

// Example 2: Error with details
function exampleErrorWithDetails() {
  loudError({
    title: 'API Request Failed',
    severity: 'error',
    context: {
      endpoint: '/api/chats/123',
      method: 'GET'
    },
    details: {
      statusCode: 404,
      responseTime: '125ms',
      retries: 3
    },
    suggestions: [
      'Verify the chat ID exists',
      'Check user permissions'
    ]
  });
}

// Example 3: Warning (less severe)
function exampleWarning() {
  loudWarn({
    title: 'Cache Miss',
    context: {
      key: 'user:123:profile',
      ttl: '300s'
    },
    details: {
      attemptedAt: new Date().toISOString(),
      fallbackUsed: true
    }
  });
}

// Example 4: Simple error with just message
function exampleSimpleError() {
  loudError({
    title: 'Configuration Missing',
    severity: 'critical',
    error: 'ANTHROPIC_API_KEY not found in environment',
    suggestions: [
      'Set ANTHROPIC_API_KEY in your .env file',
      'Copy .env.example to .env and fill in values'
    ]
  });
}
