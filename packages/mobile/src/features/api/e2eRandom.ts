/**
 * CSPRNG seam for the E2E crypto core on React Native (portable.dev#13).
 *
 * Hermes has NO `global.crypto.getRandomValues`, so `@vgit2/shared/e2e`'s
 * injected `RandomBytes` is sourced from `expo-crypto` (already a dependency).
 * `getRandomBytes(n)` is synchronous and returns a fresh `Uint8Array`, matching
 * the `(n) => Uint8Array` shape the crypto core expects.
 */
import { getRandomBytes } from 'expo-crypto';

import type { RandomBytes } from '@vgit2/shared/e2e';

export const nativeRandomBytes: RandomBytes = (n: number): Uint8Array => getRandomBytes(n);
