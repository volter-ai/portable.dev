/**
 * useTunnelRepair — lazy dead-tunnel repair hook.
 *
 * Verifies the safety-critical behavior: it posts a port-scoped repair, reflects
 * the result status, is BOUNDED + de-duped (a persistently-dead tunnel can never
 * loop), and degrades to a no-op with no ApiProvider. A fake `client` is injected
 * so the test never touches the gateway/network graph.
 */

import { renderHook, act } from '@testing-library/react-native';
import type { ReactNode } from 'react';

// Minimal mocks for the ApiProvider import graph (we inject a fake client, so the
// default gateway client is never built — these just satisfy module-scope imports).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: async (k: string) => store.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const inst = {
    set: (k: string, v: string) => store.set(k, v),
    getString: (k: string) => store.get(k),
    remove: (k: string) => store.delete(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => inst, MMKV: class {} };
});
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: () => () => {} },
  addEventListener: () => () => {},
}));

import { ApiProvider } from '../src/features/api/ApiProvider';
import { useTunnelRepair } from '../src/features/chat/runtime/useTunnelRepair';

const tunnel = {
  port: 5173,
  url: 'https://dead.trycloudflare.com',
  name: 'app',
  createdAt: 1,
  createdByChatId: 'c1',
  createdByRepoPath: 'owner/repo',
  main: true,
};

function wrapperWith(post: jest.Mock) {
  const client = { post } as never;
  return ({ children }: { children: ReactNode }) => (
    <ApiProvider client={client}>{children}</ApiProvider>
  );
}

describe('useTunnelRepair', () => {
  it('posts a port-scoped repair and reports repaired', async () => {
    const post = jest.fn().mockResolvedValue({
      status: 'repaired',
      port: 5173,
      url: 'https://fresh.trycloudflare.com',
    });
    const { result } = renderHook(() => useTunnelRepair(), { wrapper: wrapperWith(post) });

    let res: unknown;
    await act(async () => {
      res = await result.current.repair(tunnel);
    });

    expect(post).toHaveBeenCalledWith('/api/tunnels/repair', {
      port: 5173,
      chatId: 'c1',
      repoPath: 'owner/repo',
      name: 'app',
      main: true,
    });
    expect(res).toEqual({ status: 'repaired', port: 5173, url: 'https://fresh.trycloudflare.com' });
    expect(result.current.status).toBe('idle');
  });

  it('reflects dev_server_down', async () => {
    const post = jest.fn().mockResolvedValue({ status: 'dev_server_down', port: 5173 });
    const { result } = renderHook(() => useTunnelRepair(), { wrapper: wrapperWith(post) });

    await act(async () => {
      await result.current.repair(tunnel);
    });

    expect(result.current.status).toBe('dev_server_down');
  });

  it('is BOUNDED: a second repair for the SAME url does not re-post (no loop)', async () => {
    const post = jest
      .fn()
      .mockResolvedValue({ status: 'repaired', port: 5173, url: 'https://x.trycloudflare.com' });
    const { result } = renderHook(() => useTunnelRepair(), { wrapper: wrapperWith(post) });

    await act(async () => {
      await result.current.repair(tunnel);
    });
    await act(async () => {
      await result.current.repair(tunnel); // same dead url
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('failed');
  });

  it('degrades to a no-op (never throws) with no ApiProvider', async () => {
    const { result } = renderHook(() => useTunnelRepair());

    let res: unknown;
    await act(async () => {
      res = await result.current.repair(tunnel);
    });

    expect(res).toBeNull();
  });
});
