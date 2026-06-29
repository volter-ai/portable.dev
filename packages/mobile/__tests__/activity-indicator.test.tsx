/**
 * Activity indicator — unit + integration tests.
 *
 * Covers the platform-agnostic reconciler (start/update/stop + dedup), the pure
 * derive helpers (running-set + tool-label humanization), the iOS Live Activity
 * backend (over a fake native module), backend resolution, and the
 * `ActivityIndicatorSync` wiring against the live `chatMessagesStore`. The Android
 * ongoing-notification backend was REMOVED (it spammed the phone with a
 * per-second notification + vibration during long runs); Android now resolves to
 * the shared no-op. No native modules are loaded (every seam is injected).
 * Device-only acceptance (a real Live Activity on a physical device) is deferred.
 */

import { render, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

import { useChatMessagesStore } from '../src/features/chat/chatMessagesStore';
import { useChatChromeStore } from '../src/features/chat/chrome/chatChromeStore';
import {
  ActivityIndicatorSync,
  createActivityIndicatorService,
  createIosLiveActivityBackend,
  deriveActivityIndicators,
  humanizeToolLabel,
  lastToolName,
  noopActivityBackend,
  resolveActivityBackend,
  type ActivityBackend,
  type ActivityIndicatorSyncDeps,
  type ActivityInfo,
} from '../src/features/activity-indicator';
import type { MobileChatMessage } from '../src/features/chat/chatMessagesStore';

function recordingBackend(): ActivityBackend & {
  starts: ActivityInfo[];
  updates: ActivityInfo[];
  stops: string[];
} {
  const starts: ActivityInfo[] = [];
  const updates: ActivityInfo[] = [];
  const stops: string[] = [];
  return {
    starts,
    updates,
    stops,
    start: (i) => starts.push(i),
    update: (i) => updates.push(i),
    stop: (id) => stops.push(id),
  };
}

const info = (over: Partial<ActivityInfo> = {}): ActivityInfo => ({
  chatId: 'c1',
  title: 'My chat',
  repoName: 'acme/widget',
  lastToolLabel: 'Running a command',
  ...over,
});

describe('createActivityIndicatorService', () => {
  it('starts a new chat, dedups an unchanged snapshot, updates on change, stops on removal', () => {
    const backend = recordingBackend();
    const svc = createActivityIndicatorService({ backend });

    svc.reconcile([info()]);
    expect(backend.starts).toHaveLength(1);
    expect(backend.starts[0]).toEqual(info());

    // Identical snapshot → no backend call (dedup).
    svc.reconcile([info()]);
    expect(backend.starts).toHaveLength(1);
    expect(backend.updates).toHaveLength(0);

    // Changed caption → update, not start.
    svc.reconcile([info({ lastToolLabel: 'Reading files' })]);
    expect(backend.updates).toHaveLength(1);
    expect(backend.updates[0].lastToolLabel).toBe('Reading files');

    // Dropped from the running set → stop.
    svc.reconcile([]);
    expect(backend.stops).toEqual(['c1']);
  });

  it('stopAll stops every active indicator', () => {
    const backend = recordingBackend();
    const svc = createActivityIndicatorService({ backend });
    svc.reconcile([info({ chatId: 'a' }), info({ chatId: 'b' })]);
    expect(backend.starts).toHaveLength(2);
    svc.stopAll();
    expect(backend.stops.sort()).toEqual(['a', 'b']);
  });

  it('swallows a throwing backend (never breaks the app)', () => {
    const throwing: ActivityBackend = {
      start() {
        throw new Error('boom');
      },
      update() {
        throw new Error('boom');
      },
      stop() {
        throw new Error('boom');
      },
    };
    const svc = createActivityIndicatorService({ backend: throwing });
    expect(() => svc.reconcile([info()])).not.toThrow();
    expect(() => svc.reconcile([])).not.toThrow();
  });
});

describe('derive helpers', () => {
  it('humanizeToolLabel maps known tools, falls back, and handles undefined', () => {
    expect(humanizeToolLabel('Bash')).toBe('Running a command');
    expect(humanizeToolLabel('Read')).toBe('Reading files');
    expect(humanizeToolLabel('Task')).toBe('Delegating to a sub-agent');
    expect(humanizeToolLabel('mcp__playwright__browser_click')).toBe('Using the browser');
    expect(humanizeToolLabel('mcp__standard__create_tunnel')).toBe('Using a tool');
    expect(humanizeToolLabel('SomeCustomTool')).toBe('SomeCustomTool');
    expect(humanizeToolLabel(undefined)).toBe('Working…');
  });

  it('lastToolName finds the most recent tool_use across messages', () => {
    const messages: MobileChatMessage[] = [
      { role: 'assistant', blocks: [{ type: 'tool_use', id: 't1', toolName: 'Read' }] },
      {
        role: 'assistant',
        blocks: [
          { type: 'text', content: 'hi' },
          { type: 'tool_use', id: 't2', toolName: 'Bash' },
          { type: 'text', content: 'done' },
        ],
      },
    ];
    expect(lastToolName(messages)).toBe('Bash');
    expect(lastToolName([{ role: 'user', content: 'hello' }])).toBeUndefined();
  });

  it('deriveActivityIndicators only includes running/compressing chats', () => {
    const resolveMeta = (chatId: string) => ({ title: `T:${chatId}`, repoName: `o/${chatId}` });
    const out = deriveActivityIndicators(
      {
        statuses: {
          run: 'running',
          comp: 'compressing',
          done: 'completed',
          err: 'error',
          idle: 'idle',
        },
        messages: {
          run: [{ role: 'assistant', blocks: [{ type: 'tool_use', id: 'x', toolName: 'Edit' }] }],
          comp: [],
        },
      },
      resolveMeta
    );
    const ids = out.map((i) => i.chatId).sort();
    expect(ids).toEqual(['comp', 'run']);
    const run = out.find((i) => i.chatId === 'run')!;
    expect(run).toEqual({
      chatId: 'run',
      title: 'T:run',
      repoName: 'o/run',
      lastToolLabel: 'Editing files',
    });
    const comp = out.find((i) => i.chatId === 'comp')!;
    expect(comp.lastToolLabel).toBe('Working…'); // no tool yet
  });
});

describe('createIosLiveActivityBackend', () => {
  it('drives the native module on start/update/stop', () => {
    const mod = {
      areActivitiesEnabled: jest.fn(() => true),
      startActivity: jest.fn(async () => true),
      updateActivity: jest.fn(async () => undefined),
      endActivity: jest.fn(async () => undefined),
    };
    const backend = createIosLiveActivityBackend({ resolveModule: () => mod });

    backend.start(info());
    expect(mod.startActivity).toHaveBeenCalledWith(
      'c1',
      'acme/widget',
      'My chat',
      'Running a command'
    );

    backend.update(info({ lastToolLabel: 'Reading files' }));
    expect(mod.updateActivity).toHaveBeenCalledWith('c1', 'Reading files', true);

    backend.stop('c1');
    expect(mod.endActivity).toHaveBeenCalledWith('c1');
  });

  it('is a silent no-op when the native module is absent (Android / Expo Go / iOS < 16.2)', () => {
    const backend = createIosLiveActivityBackend({ resolveModule: () => null });
    expect(() => {
      backend.start(info());
      backend.update(info());
      backend.stop('c1');
    }).not.toThrow();
  });
});

describe('resolveActivityBackend', () => {
  it('maps iOS to the Live Activity backend; Android/web/unknown → the shared no-op', () => {
    // The Android ongoing-notification backend was removed (it re-rendered
    // the notification every second to tick the elapsed counter, spamming the phone
    // with constant notifications + vibration during long runs). iOS is unaffected —
    // ActivityKit renders the elapsed timer natively. Only iOS keeps a real backend.
    expect(resolveActivityBackend('android')).toBe(noopActivityBackend);
    expect(resolveActivityBackend('web')).toBe(noopActivityBackend);

    const ios = resolveActivityBackend('ios');
    expect(ios).not.toBe(noopActivityBackend);
    expect(typeof ios.start).toBe('function');
    expect(typeof ios.update).toBe('function');
    expect(typeof ios.stop).toBe('function');
  });
});

describe('ActivityIndicatorSync', () => {
  beforeEach(() => {
    act(() => {
      useChatMessagesStore.getState().reset();
      useChatChromeStore.getState().reset();
    });
  });

  function mountSync(deps: ActivityIndicatorSyncDeps) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <ActivityIndicatorSync deps={deps} />
      </QueryClientProvider>
    );
  }

  it('reconciles the running-chat set into the service and stops all on unmount', () => {
    const reconcile = jest.fn();
    const stopAll = jest.fn();
    const resolveMeta = (chatId: string) => ({ title: `Title ${chatId}`, repoName: 'acme/widget' });

    const view = mountSync({ service: { reconcile, stopAll }, resolveMeta });

    // Initial mount → empty running set.
    expect(reconcile).toHaveBeenLastCalledWith([]);

    // A chat starts running + runs a tool.
    act(() => {
      useChatMessagesStore.getState().markRunStarted('chat-1');
      useChatMessagesStore.getState().appendBlock('chat-1', {
        type: 'tool_use',
        id: 'tu1',
        blockId: 'b1',
        toolName: 'Bash',
      });
    });

    expect(reconcile).toHaveBeenLastCalledWith([
      {
        chatId: 'chat-1',
        title: 'Title chat-1',
        repoName: 'acme/widget',
        lastToolLabel: 'Running a command',
      },
    ]);

    // The run completes → empty set again.
    act(() => {
      useChatMessagesStore.getState().setStatus('chat-1', 'completed');
    });
    expect(reconcile).toHaveBeenLastCalledWith([]);

    // Unmount tears every indicator down.
    view.unmount();
    expect(stopAll).toHaveBeenCalledTimes(1);
  });

  it('wires the injected backend through the real service (start → stop)', () => {
    const backend = recordingBackend();
    const resolveMeta = (chatId: string) => ({ title: 'T', repoName: 'o/r' });
    mountSync({ backend, resolveMeta });

    act(() => {
      useChatMessagesStore.getState().markRunStarted('chat-9');
    });
    expect(backend.starts.map((s) => s.chatId)).toEqual(['chat-9']);

    act(() => {
      useChatMessagesStore.getState().setStatus('chat-9', 'error');
    });
    expect(backend.stops).toEqual(['chat-9']);
  });
});
