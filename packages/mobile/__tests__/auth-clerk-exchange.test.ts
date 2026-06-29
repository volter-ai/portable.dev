/**
 * Exchange Clerk session for a Portable authToken (`/clerk-exchange`).
 *
 * Mocks the gateway HTTP (via the shared `createMockGateway` harness) so
 * `POST /auth/mobile/react-native/clerk-exchange` returns
 * `{ authToken, userId, username, email }`, and mocks
 * `expo-secure-store` with an in-memory keychain. Asserts the exchange flow:
 *   1. persists the minted `authToken` to expo-secure-store (NEVER AsyncStorage),
 *   2. returns the non-secret identity `{ userId, username, email }`,
 *   3. sends the Clerk session token in the body with `credentials: 'omit'`
 *      (no cookies), per the gateway contract.
 */

// In-memory mock keychain for expo-secure-store (the ONLY persistence the flow uses).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

import * as SecureStore from 'expo-secure-store';

import { exchangeClerkSession } from '../src/features/auth/exchangeClerkSession';
import { AUTH_TOKEN_KEY, getAuthToken } from '../src/features/auth/secureAuthStore';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

import type { MobileRnClerkExchangeResponse } from '@vgit2/shared/types';

interface SecureStoreMock {
  __store: Map<string, string>;
  setItemAsync: jest.Mock;
  getItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
}

const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

describe('Clerk → Portable authToken exchange', () => {
  let gateway: MockGateway;
  let client: GatewayClient;

  beforeEach(() => {
    jest.clearAllMocks();
    secureStore.__store.clear();
    gateway = createMockGateway();
    client = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  });

  it('persists authToken to expo-secure-store and returns the non-secret identity', async () => {
    const exchanged: MobileRnClerkExchangeResponse = {
      authToken: 'portable-jwt-xyz',
      userId: 'clerk_user_42',
      username: 'octocat',
      email: 'octocat@portable.test',
    };
    gateway.onRn('POST', '/clerk-exchange', () => ({ body: exchanged }));

    const result = await exchangeClerkSession('clerk_session_token_abc', client);

    // (2) identity returned, authToken NOT returned.
    expect(result).toEqual({
      userId: 'clerk_user_42',
      username: 'octocat',
      email: 'octocat@portable.test',
    });
    expect(result).not.toHaveProperty('authToken');

    // (1) authToken persisted to expo-secure-store under the canonical key.
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(AUTH_TOKEN_KEY, 'portable-jwt-xyz');
    expect(secureStore.__store.get(AUTH_TOKEN_KEY)).toBe('portable-jwt-xyz');
    await expect(getAuthToken()).resolves.toBe('portable-jwt-xyz');
  });

  it('sends the Clerk session token in the body with no cookies (credentials: omit)', async () => {
    await exchangeClerkSession('clerk_session_token_abc', client);

    const req = gateway.requests.find((r) => r.path.endsWith('/clerk-exchange'));
    expect(req).toBeDefined();
    expect(req?.method).toBe('POST');
    expect(req?.body).toEqual({ clerkSessionToken: 'clerk_session_token_abc' });
    // Cookies are never sent — the exchange is Bearer/body only.
    expect(req?.credentials).toBe('omit');
    expect(req?.headers.Cookie ?? req?.headers.cookie).toBeUndefined();
  });

  it('does not persist any token when the gateway rejects the session (no secure-store write)', async () => {
    gateway.onRn('POST', '/clerk-exchange', () => ({
      status: 401,
      body: { error: 'Invalid session' },
    }));

    await expect(exchangeClerkSession('bad_token', client)).rejects.toThrow('Invalid session');

    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(secureStore.__store.size).toBe(0);
  });
});
