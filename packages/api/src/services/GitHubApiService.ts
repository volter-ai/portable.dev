/**
 * GitHubApiService - Re-export from modular structure
 *
 * This file maintains backward compatibility while the actual implementation
 * has been refactored into a modular directory structure at ./GitHubApiService/
 *
 * The service has been split into:
 * - GitHubApiService/index.ts - Main service class with dependency injection
 * - GitHubApiService/handlers/ - Specialized handlers for different GitHub API domains
 * - GitHubApiService/utils/ - Shared utility functions
 * - GitHubApiService/types.ts - TypeScript type definitions
 */
export { GitHubApiService, GitHubConnectionError } from './GitHubApiService/index.js';
