/**
 * resolveDataPathToken — the relay data-path credential funnel.
 *
 * Imports the FILE (not the pc-connect barrel) so the themed PcConnectGate graph
 * (useAppTheme → themeStore → MMKV) never loads — only `expo-secure-store` needs
 * an in-memory mock.
 */

const mockSecureStore: Record<string, string> = {};

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async (k: string, v: string) => {
    mockSecureStore[k] = v;
  }),
  getItemAsync: jest.fn(async (k: string) => mockSecureStore[k] ?? null),
  deleteItemAsync: jest.fn(async (k: string) => {
    delete mockSecureStore[k];
  }),
}));

import { resolveDataPathToken } from '../src/features/pc-connect/dataPathToken';
import { CONNECTED_PC_KEY } from '../src/features/pc-connect/connectedPcStore';
import { DEVICE_TOKEN_KEY_PREFIX } from '../src/features/pc-connect/deviceTokenStore';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';

describe('resolveDataPathToken', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockSecureStore)) delete mockSecureStore[k];
  });

  it('returns the connected PC device token when a PC is linked', async () => {
    mockSecureStore[CONNECTED_PC_KEY] = 'pc_abc';
    mockSecureStore[`${DEVICE_TOKEN_KEY_PREFIX}pc_abc`] = 'device-token-xyz';
    // The legacy authToken is present but MUST be ignored for a connected PC.
    mockSecureStore[AUTH_TOKEN_KEY] = 'legacy-portable-jwt';

    expect(await resolveDataPathToken()).toBe('device-token-xyz');
  });

  it('returns null for a connected PC with no device token (never leaks the legacy authToken to the relay)', async () => {
    mockSecureStore[CONNECTED_PC_KEY] = 'pc_no_token';
    mockSecureStore[AUTH_TOKEN_KEY] = 'legacy-portable-jwt';

    expect(await resolveDataPathToken()).toBeNull();
  });

  it('falls back to the legacy Portable authToken when no PC is connected', async () => {
    mockSecureStore[AUTH_TOKEN_KEY] = 'legacy-portable-jwt';

    expect(await resolveDataPathToken()).toBe('legacy-portable-jwt');
  });

  it('returns null when neither a connected PC nor a legacy authToken exists', async () => {
    expect(await resolveDataPathToken()).toBeNull();
  });
});
