/**
 * Transport-agnostic Socket.IO core (single source of truth for the wire
 * protocol). Consumed by the React Native (`packages/mobile`) client so client
 * and server stay byte-identical.
 *
 * - `events`        — event-name catalog + client→server payload & ack types
 * - `createSocket`  — configured Socket.IO client factory (platform opts injected)
 * - `emitters`      — named emit helpers (pure wire primitives)
 * - `consolidation` — message dedup + tool-block consolidation (pure)
 * - `e2eSocket`     — client-side E2E frame wrapper (portable.dev#13)
 */

export * from './events.js';
export * from './createSocket.js';
export * from './emitters.js';
export * from './consolidation.js';
export * from './e2eSocket.js';
