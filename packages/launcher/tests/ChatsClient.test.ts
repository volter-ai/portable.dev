/**
 * ChatsClient + startChatsWatch tests. The fetch impl + timers are injected so no
 * real HTTP / intervals run.
 */
import { describe, expect, it } from 'bun:test';

import { ChatsClient, startChatsWatch, type ChatSummary } from '../src/ChatsClient.js';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('ChatsClient.listRecent', () => {
  it('maps + sorts the /api/chats response (newest first, Bearer auth)', async () => {
    let calledUrl = '';
    let authHeader = '';
    const client = new ChatsClient({
      apiBaseUrl: 'http://127.0.0.1:4200/',
      token: 'jwt-abc',
      fetchImpl: async (url, init) => {
        calledUrl = url;
        authHeader = (init?.headers as Record<string, string>)?.Authorization ?? '';
        return jsonResponse({
          chats: [
            { id: 'old', title: 'Old', lastUpdated: '2026-06-27T09:00:00.000Z' },
            {
              id: 'new',
              title: '',
              firstMessagePreview: 'Newest preview',
              repoFullName: 'me/app',
              lastUpdated: '2026-06-27T11:00:00.000Z',
            },
          ],
        });
      },
    });

    const chats = await client.listRecent(10);

    expect(calledUrl).toBe(
      'http://127.0.0.1:4200/api/chats?archived=false&source=portable&previews=false&limit=10'
    );
    expect(authHeader).toBe('Bearer jwt-abc');
    // Newest first; empty title falls back to the first-message preview.
    expect(chats.map((c) => c.id)).toEqual(['new', 'old']);
    expect(chats[0]).toMatchObject({ title: 'Newest preview', repoFullName: 'me/app' });
  });

  it('normalizes a numeric (epoch ms) lastUpdated to an ISO string', async () => {
    const ms = Date.parse('2026-06-27T11:00:00.000Z');
    const client = new ChatsClient({
      apiBaseUrl: 'http://127.0.0.1:4200',
      token: 't',
      fetchImpl: async () => jsonResponse({ chats: [{ id: 'c', title: 'X', lastUpdated: ms }] }),
    });
    const chats = await client.listRecent();
    expect(chats[0].lastUpdated).toBe('2026-06-27T11:00:00.000Z');
  });

  it('throws on a non-OK response', async () => {
    const client = new ChatsClient({
      apiBaseUrl: 'http://127.0.0.1:4200',
      token: 't',
      fetchImpl: async () => jsonResponse({}, false, 500),
    });
    await expect(client.listRecent()).rejects.toThrow('HTTP 500');
  });
});

describe('ChatsClient.archive', () => {
  it('POSTs the archive route with {archived:true}', async () => {
    let method = '';
    let url = '';
    let body = '';
    const client = new ChatsClient({
      apiBaseUrl: 'http://127.0.0.1:4200',
      token: 't',
      fetchImpl: async (u, init) => {
        url = u;
        method = init?.method ?? '';
        body = (init?.body as string) ?? '';
        return jsonResponse({ success: true });
      },
    });

    await client.archive('chat-1');
    expect(method).toBe('POST');
    expect(url).toBe('http://127.0.0.1:4200/api/chats/chat-1/archive');
    expect(JSON.parse(body)).toEqual({ archived: true });
  });
});

function manualTimer() {
  let cb: (() => void) | null = null;
  return {
    setIntervalImpl: ((fn: () => void) => {
      cb = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as NonNullable<Parameters<typeof startChatsWatch>[2]>['setIntervalImpl'],
    clearIntervalImpl: (() => {}) as NonNullable<
      Parameters<typeof startChatsWatch>[2]
    >['clearIntervalImpl'],
    tick: () => cb?.(),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('startChatsWatch', () => {
  it('emits the initial list + on change, and dedupes', async () => {
    let list: ChatSummary[] = [];
    const t = manualTimer();
    const emits: ChatSummary[][] = [];

    startChatsWatch(
      () => Promise.resolve(list),
      (c) => emits.push(c),
      {
        setIntervalImpl: t.setIntervalImpl,
        clearIntervalImpl: t.clearIntervalImpl,
      }
    );

    await flush();
    expect(emits).toHaveLength(1); // initial (empty)

    t.tick();
    await flush();
    expect(emits).toHaveLength(1); // no change → no emit

    list = [{ id: 'c1', title: 'Hi' }];
    t.tick();
    await flush();
    expect(emits).toHaveLength(2);
    expect(emits[1]).toHaveLength(1);

    t.tick();
    await flush();
    expect(emits).toHaveLength(2); // same set → no emit
  });

  it('never overlaps loads (a tick while in-flight is ignored)', async () => {
    let active = 0;
    let maxConcurrent = 0;
    let release: (() => void) | null = null;
    const t = manualTimer();

    const load = () =>
      new Promise<ChatSummary[]>((resolve) => {
        active++;
        maxConcurrent = Math.max(maxConcurrent, active);
        release = () => {
          active--;
          resolve([]);
        };
      });

    startChatsWatch(load, () => {}, {
      setIntervalImpl: t.setIntervalImpl,
      clearIntervalImpl: t.clearIntervalImpl,
    });

    // Initial load is in-flight; extra ticks must NOT start concurrent loads.
    t.tick();
    t.tick();
    expect(maxConcurrent).toBe(1);

    release!();
    await flush();
  });
});
