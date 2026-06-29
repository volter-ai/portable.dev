/**
 * Feature Flags - Backend-only configuration
 *
 * IMPORTANT: This file is backend-only and reads from constants.
 * Clients should fetch feature flags from API endpoints, not import this file.
 *
 * This file imports constants.ts first to ensure .env is loaded before reading constants.
 * Backend code should import via: import { FEATURE_FLAGS } from '../config/featureFlags.js'
 */

// Import constants FIRST to ensure .env is loaded
import '@vgit2/shared/constants';

/**
 * Feature flags - centralized backend configuration
 * Backend-only - reads from process.env after .env is loaded
 *
 * Uses getters for lazy evaluation to support testing scenarios
 * where env vars are set after module import.
 */
export const FEATURE_FLAGS = {
  // MCP Server integrations (default: enabled)
  get ENABLE_PLAYWRIGHT_MCP() {
    return process.env.ENABLE_PLAYWRIGHT_MCP !== 'false';
  },

  // AI-powered task suggestions (default: disabled)
  get ENABLE_SUGGESTIONS() {
    return process.env.ENABLE_SUGGESTIONS === 'true';
  },
};
