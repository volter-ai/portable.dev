/**
 * In-chat runtime preview. Three layers:
 *
 *   1. `selectChatTunnel` / `isTunnelLive` pure units — strict chat/repo scoping
 *      + the main→live→recent priority.
 *   2. `ChatRuntimeBubble` — visibility (live tunnel only), platform-gated tap
 *      (iOS → system browser, NO embed; Android → in-app navigable WebView
 *      overlay), the overlay controls, and the drag gesture.
 *
 * Mounted directly (no `renderRouter`), so the bare `react-native-reanimated`
 * moduleNameMapper stub applies (no expo-router self-mock load-order dance). The
 * `useAppTheme` → themeStore import graph needs the mmkv mock; the bubble's
 * platform/openExternal/WebView seams are injected so no native browser/WebView
 * module ever loads.
 */

// useAppTheme → themeStore → react-native-mmkv (the documented theme-graph rule).
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

import { fireEvent, render, screen } from '@testing-library/react-native';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { State } from 'react-native-gesture-handler';
import type { ComponentType, ReactNode } from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { TunnelData } from '@vgit2/shared/types';

import { ChatRuntimeBubble } from '../src/features/chat/runtime/ChatRuntimeBubble';
import { isTunnelLive, selectChatTunnel } from '../src/features/chat/runtime/useChatRuntimePreview';
import type { WebViewLike } from '../src/features/runtime/SandboxWebView';

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const FakeWebView: ComponentType<WebViewLike> = ({ source, testID }) => (
  <Text testID={testID}>{source.uri}</Text>
);

const TUNNEL: TunnelData = {
  port: 3000,
  url: 'https://abc.trycloudflare.com',
  name: 'dev',
  createdAt: 10,
  active: true,
  createdByChatId: 'chat-1',
  createdByRepoPath: '~/claude-workspace/acme/widget',
};

function renderBubble(node: ReactNode) {
  // `as never` bridges the React 18 (SafeAreaProvider's bundled types) ↔ React 19
  // ReactNode mismatch (the documented bigint/ReactPortal drift).
  return render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>{node as never}</SafeAreaProvider>
  );
}

describe('selectChatTunnel / isTunnelLive', () => {
  it('returns null when there are no tunnels', () => {
    expect(selectChatTunnel([], 'chat-1', '~/p')).toBeNull();
  });

  it('prefers a chat-scoped tunnel over a repo-scoped one', () => {
    const repoOnly: TunnelData = { ...TUNNEL, port: 4000, createdByChatId: 'other', name: 'repo' };
    const chatOwned: TunnelData = { ...TUNNEL, port: 3000, name: 'chat' };
    const picked = selectChatTunnel(
      [repoOnly, chatOwned],
      'chat-1',
      '~/claude-workspace/acme/widget'
    );
    expect(picked?.name).toBe('chat');
  });

  it('falls back to the repo-scoped tunnel when no chat match exists', () => {
    const repoOnly: TunnelData = { ...TUNNEL, createdByChatId: 'someone-else', name: 'repo' };
    const picked = selectChatTunnel([repoOnly], 'chat-1', '~/claude-workspace/acme/widget');
    expect(picked?.name).toBe('repo');
  });

  it('never returns an unrelated (unscoped) tunnel', () => {
    const unrelated: TunnelData = {
      port: 9999,
      url: 'https://other.run',
      name: 'other',
      createdAt: 99,
      createdByChatId: 'chat-2',
      createdByRepoPath: '~/claude-workspace/x/y',
    };
    expect(selectChatTunnel([unrelated], 'chat-1', '~/claude-workspace/acme/widget')).toBeNull();
  });

  it('prefers main, then live, then most recent among chat matches', () => {
    const old: TunnelData = { ...TUNNEL, port: 3000, createdAt: 1, name: 'old' };
    const newer: TunnelData = { ...TUNNEL, port: 3001, createdAt: 5, name: 'newer' };
    const main: TunnelData = { ...TUNNEL, port: 3002, createdAt: 2, name: 'main', main: true };
    expect(selectChatTunnel([old, newer, main], 'chat-1')?.name).toBe('main');
    expect(selectChatTunnel([old, newer], 'chat-1')?.name).toBe('newer');
  });

  it('treats only an explicit active:false as not-live', () => {
    expect(isTunnelLive({ ...TUNNEL, active: true })).toBe(true);
    expect(isTunnelLive({ ...TUNNEL, active: undefined })).toBe(true);
    expect(isTunnelLive({ ...TUNNEL, active: false })).toBe(false);
  });
});

describe('ChatRuntimeBubble', () => {
  it('renders nothing when there is no tunnel', () => {
    renderBubble(<ChatRuntimeBubble tunnel={null} platform="android" />);
    expect(screen.queryByTestId('chat-runtime-bubble')).toBeNull();
  });

  it('renders the floating bubble when a live tunnel exists', () => {
    renderBubble(<ChatRuntimeBubble tunnel={TUNNEL} platform="android" />);
    expect(screen.getByTestId('chat-runtime-bubble')).toBeTruthy();
  });

  it('on iOS, tapping opens the system browser and NEVER embeds a WebView', () => {
    const openExternal = jest.fn();
    renderBubble(
      <ChatRuntimeBubble
        tunnel={TUNNEL}
        platform="ios"
        openExternal={openExternal}
        WebViewComponent={FakeWebView}
      />
    );

    fireEvent.press(screen.getByTestId('chat-runtime-bubble'));

    expect(openExternal).toHaveBeenCalledWith('https://abc.trycloudflare.com');
    // No embedded preview is ever mounted on iOS.
    expect(screen.queryByTestId('chat-runtime-preview-overlay')).toBeNull();
    expect(screen.queryByTestId('chat-runtime-preview-webview')).toBeNull();
  });

  it('on Android, tapping opens an in-app navigable WebView preview', () => {
    renderBubble(
      <ChatRuntimeBubble tunnel={TUNNEL} platform="android" WebViewComponent={FakeWebView} />
    );

    // Hidden until the bubble is tapped.
    expect(screen.queryByTestId('chat-runtime-preview-overlay')).toBeNull();

    fireEvent.press(screen.getByTestId('chat-runtime-bubble'));

    expect(screen.getByTestId('chat-runtime-preview-overlay')).toBeTruthy();
    expect(screen.getByTestId('chat-runtime-preview-webview')).toHaveTextContent(
      'https://abc.trycloudflare.com'
    );
  });

  it('Android preview: close hides it, open-in-browser uses the system browser', () => {
    const openExternal = jest.fn();
    renderBubble(
      <ChatRuntimeBubble
        tunnel={TUNNEL}
        platform="android"
        openExternal={openExternal}
        WebViewComponent={FakeWebView}
      />
    );

    fireEvent.press(screen.getByTestId('chat-runtime-bubble'));
    expect(screen.getByTestId('chat-runtime-preview-webview')).toBeTruthy();

    // The in-overlay "open in browser" still defers to the system browser.
    fireEvent.press(screen.getByTestId('chat-runtime-preview-open'));
    expect(openExternal).toHaveBeenCalledWith('https://abc.trycloudflare.com');

    // Reload keeps the embed mounted; close removes the overlay.
    fireEvent.press(screen.getByTestId('chat-runtime-preview-reload'));
    expect(screen.getByTestId('chat-runtime-preview-webview')).toBeTruthy();

    fireEvent.press(screen.getByTestId('chat-runtime-preview-close'));
    expect(screen.queryByTestId('chat-runtime-preview-overlay')).toBeNull();
  });

  it('can be dragged and still taps afterward', () => {
    renderBubble(
      <ChatRuntimeBubble tunnel={TUNNEL} platform="android" WebViewComponent={FakeWebView} />
    );

    // Drag the bubble (the pan gesture must not crash / consume the later tap).
    fireGestureHandler(getByGestureTestId('chat-runtime-bubble-pan'), [
      { state: State.BEGAN, translationX: 0, translationY: 0 },
      { state: State.ACTIVE, translationX: -120, translationY: 200 },
      { state: State.END, translationX: -120, translationY: 200 },
    ]);

    expect(screen.getByTestId('chat-runtime-bubble')).toBeTruthy();
    fireEvent.press(screen.getByTestId('chat-runtime-bubble'));
    expect(screen.getByTestId('chat-runtime-preview-overlay')).toBeTruthy();
  });
});
