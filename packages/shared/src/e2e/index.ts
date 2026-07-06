/**
 * @vgit2/shared/e2e — end-to-end encryption core (portable.dev#13).
 *
 * Pure, runtime-portable crypto shared by the phone (Hermes/RN), the api and
 * the launcher (Bun/Node). Transport wiring lives in the consuming packages;
 * this module is framework-free: no env reads, no Buffer, injected randomness.
 */
export {
  E2E_KEY_BYTES,
  E2E_NONCE_BYTES,
  E2eDecryptError,
  decodeBase64,
  encodeBase64,
  openEnvelope,
  sealEnvelope,
} from './envelope.js';
export type { E2eEnvelope, RandomBytes } from './envelope.js';

export {
  E2E_PSK_BYTES,
  E2eAuthError,
  completeHandshake,
  createHandshakeInit,
  generatePsk,
  respondToHandshake,
} from './handshake.js';
export type {
  E2eHandshakeInit,
  E2eHandshakeResponse,
  E2eHandshakeState,
  E2eSession,
  E2eSessionKeys,
} from './handshake.js';

export { b64ToText, openJson, sealJson, textToB64 } from './wire.js';
export type { E2eInnerRequest, E2eInnerResponse, E2eTunnelPayload } from './wire.js';

export {
  isFrameEnvelope,
  isReservedSocketEvent,
  openFrameArgs,
  sealFrameArgs,
} from './socketFrame.js';
export type { E2eFrameEnvelope } from './socketFrame.js';
