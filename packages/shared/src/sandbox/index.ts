/**
 * Framework-free sandbox-lifecycle primitives used by the RN
 * (`packages/mobile`) client for consistent thresholds against the remote
 * backend.
 *
 * - `healthMonitor` — the 5s/90s health-poll accumulator
 */

export * from './healthMonitor.js';
