/**
 * Chat "unseen change" highlight — the orange row cue for a chat that CHANGED but the
 * mobile client hasn't opened since.
 *
 * Covers the persisted seen-marker store ({@link useChatSeenStore}: monotonic
 * `markSeen`, first-sight `noteBaseline`, `forget`), the {@link useChatUnseen} decision
 * hook (baseline-on-first-sight so a fresh list never lights up; glow only after a real
 * post-baseline change; cleared by opening), the {@link unseenGlowStyle} accent glow,
 * and the {@link ChatCardBody} orange dot.
 */

// MMKV backs the persisted seen-marker store (and the theme store ChatCardBody reads).
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string) => store.set(k, v),
    getString: (k: string) => store.get(k) ?? undefined,
    remove: (k: string) => store.delete(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

import { act, render, renderHook, screen } from '@testing-library/react-native';

import type { ChatListItem } from '@vgit2/shared/types';

import { ChatCardBody } from '../src/features/home/ChatCardBody';
import { useChatSeenStore } from '../src/features/chat/chatSeenStore';
import { unseenGlowStyle, useChatUnseen } from '../src/features/chat/useChatUnseen';
import type { Theme } from '../src/theme';

function makeChat(over: Partial<ChatListItem> = {}): ChatListItem {
  return {
    id: 'c1',
    type: 'claude_code',
    title: 'A chat',
    lastUpdated: 1_000,
    ...over,
  } as ChatListItem;
}

beforeEach(() => {
  act(() => useChatSeenStore.setState({ seen: {} }));
});

describe('useChatSeenStore', () => {
  it('markSeen only ever advances the marker (monotonic)', () => {
    act(() => useChatSeenStore.getState().markSeen('c1', 100));
    expect(useChatSeenStore.getState().seen.c1).toBe(100);
    // A later (larger) value advances it.
    act(() => useChatSeenStore.getState().markSeen('c1', 250));
    expect(useChatSeenStore.getState().seen.c1).toBe(250);
    // An older (smaller) value never rolls it back.
    act(() => useChatSeenStore.getState().markSeen('c1', 50));
    expect(useChatSeenStore.getState().seen.c1).toBe(250);
  });

  it('noteBaseline records a first-sight value but never overwrites an existing marker', () => {
    act(() => useChatSeenStore.getState().noteBaseline('c1', 500));
    expect(useChatSeenStore.getState().seen.c1).toBe(500);
    // Second sight (a larger current lastUpdated) must NOT reset the baseline — else a
    // real change since baseline could never be detected.
    act(() => useChatSeenStore.getState().noteBaseline('c1', 900));
    expect(useChatSeenStore.getState().seen.c1).toBe(500);
  });

  it('forget drops a chat marker (deleted chat cleanup)', () => {
    act(() => useChatSeenStore.getState().markSeen('c1', 100));
    act(() => useChatSeenStore.getState().forget('c1'));
    expect(useChatSeenStore.getState().seen.c1).toBeUndefined();
  });
});

describe('useChatUnseen', () => {
  it('a first-seen chat is NOT unseen and is baselined to its current lastUpdated', () => {
    const { result } = renderHook(() => useChatUnseen({ id: 'c2', lastUpdated: 500 }));
    // No glow on first sight...
    expect(result.current).toBe(false);
    // ...and the baseline effect recorded exactly its current value (so a later change glows).
    expect(useChatSeenStore.getState().seen.c2).toBe(500);
  });

  it('glows when the chat advanced past a previously-seen marker', () => {
    act(() => useChatSeenStore.getState().markSeen('c3', 100));
    const { result } = renderHook(() => useChatUnseen({ id: 'c3', lastUpdated: 200 }));
    expect(result.current).toBe(true);
  });

  it('stops glowing once the chat is marked seen up to its latest update', () => {
    act(() => useChatSeenStore.getState().markSeen('c4', 100));
    const { result, rerender } = renderHook(
      (props: { lastUpdated: number }) =>
        useChatUnseen({ id: 'c4', lastUpdated: props.lastUpdated }),
      { initialProps: { lastUpdated: 200 } }
    );
    expect(result.current).toBe(true);
    // Opening the chat marks it seen up to now → the row clears.
    act(() => useChatSeenStore.getState().markSeen('c4', 200));
    rerender({ lastUpdated: 200 });
    expect(result.current).toBe(false);
  });

  it('a chat with no lastUpdated never glows', () => {
    const { result } = renderHook(() => useChatUnseen({ id: 'c5', lastUpdated: undefined }));
    expect(result.current).toBe(false);
  });
});

describe('unseenGlowStyle', () => {
  it('is an orange (primary-accent) glow: tinted border + OPAQUE wash + colored shadow', () => {
    const theme = { colors: { primary: '#EB7B47', surface: '#FFFFFF' } } as unknown as Theme;
    const style = unseenGlowStyle(theme);
    expect(style.borderColor).toBe('#EB7B47');
    expect(style.shadowColor).toBe('#EB7B47');
    // The wash must be a fully-opaque #RRGGBB (primary blended INTO surface): a
    // translucent wash let the layers behind the card bleed through — the swipe
    // row's always-mounted action buttons tinted the row's right edge while the
    // text area sat over the page background, rendering a two-tone card.
    expect(String(style.backgroundColor)).toMatch(/^#[0-9a-fA-F]{6}$/);
    // ...and still a real wash: tinted away from the plain surface.
    expect(style.backgroundColor).not.toBe('#FFFFFF');
    expect(style.shadowRadius).toBeGreaterThan(0);
  });
});

describe('ChatCardBody unseen dot', () => {
  it('renders the orange dot only when the chat has an unseen change', () => {
    // Seen up to 100, but the list now shows lastUpdated 200 → unseen → dot present.
    act(() => useChatSeenStore.getState().markSeen('c6', 100));
    render(<ChatCardBody chat={makeChat({ id: 'c6', lastUpdated: 200 })} />);
    expect(screen.getByTestId('chat-unseen-c6')).toBeTruthy();
  });

  it('hides the dot for a first-seen chat (no retroactive glow)', () => {
    render(<ChatCardBody chat={makeChat({ id: 'c7', lastUpdated: 200 })} />);
    expect(screen.queryByTestId('chat-unseen-c7')).toBeNull();
  });
});
