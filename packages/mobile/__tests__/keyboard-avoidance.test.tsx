/**
 * regression guard — active-chat keyboard avoidance (both platforms).
 *
 * Mounts ActiveChatScreen and asserts the root KeyboardAvoidingView
 * (testID="active-chat") has a DEFINED behavior prop on BOTH iOS and Android.
 *
 * BEFORE fix: RN's built-in KAV with behavior=undefined on Android → Android test FAILS.
 * AFTER fix: react-native-keyboard-controller's KAV with behavior="padding" on
 *            both platforms → both tests PASS.
 */

// ── react-native-keyboard-controller: native module — use the built-in Jest mock ──
jest.mock('react-native-keyboard-controller', () =>
  require('react-native-keyboard-controller/jest')
);

// ── expo-router: provide chatId param + stub router.back ──────────────────────
jest.mock('expo-router', () => ({
  __esModule: true,
  useLocalSearchParams: jest.fn(() => ({ chatId: 'test-chat-1' })),
  useRouter: jest.fn(() => ({ back: jest.fn() })),
}));

// ── Native modules required by transitive imports ─────────────────────────────
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  return {
    createMMKV: () => ({
      set: (k: string, v: string) => store.set(k, v),
      getString: (k: string) => store.get(k) ?? undefined,
      remove: (k: string) => store.delete(k),
      contains: (k: string) => store.has(k),
      clearAll: () => store.clear(),
    }),
    MMKV: class {},
  };
});
jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async () => {}),
  getItemAsync: jest.fn(async () => null),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));
jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});
jest.mock('expo-audio', () => require('../src/test/mockExpoAudio').createExpoAudioMock());
jest.mock('react-native-markdown-display', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children?: unknown }) => <Text>{children}</Text>,
  };
});

// ── Feature-module stubs — return safe minimal data ──────────────────────────
jest.mock('../src/features/api/hooks', () => ({
  useAgentSetups: jest.fn(() => ({ data: [] })),
  // FollowUpComposer calls useChatCommands() for the `/` slash-command picker.
  useChatCommands: jest.fn(() => ({ data: undefined, isLoading: false })),
}));
jest.mock('../src/features/api/relayUrlStore', () => ({
  getRelayUrl: jest.fn(async () => null),
}));
jest.mock('../src/features/socket/useOfflineMessageQueue', () => ({
  useOfflineMessageQueue: jest.fn(() => ({ send: jest.fn(), flush: jest.fn() })),
}));
jest.mock('../src/features/socket/SocketProvider', () => ({
  useOptionalSocket: jest.fn(() => null),
}));
jest.mock('../src/features/home/LinkedIssueBadge', () => ({ LinkedIssueBadge: () => null }));
jest.mock('../src/features/chat/agentInfo', () => ({
  getAgentInfo: jest.fn(() => ({ name: 'Claude', color: '#6366f1' })),
}));
jest.mock('../src/features/chat/chatMessagesStore', () => ({
  useChatMessagesStore: jest.fn(() => []),
}));
jest.mock('../src/features/chat/chrome/ChatChrome', () => ({ ChatChrome: () => null }));
jest.mock('../src/features/chat/chrome/useChatLinkedIssue', () => ({
  useChatLinkedIssue: jest.fn(() => null),
}));
jest.mock('../src/features/chat/chrome/useChatRepoPath', () => ({
  useChatRepoPath: jest.fn(() => null),
}));
jest.mock('../src/features/chat/FollowUpComposer', () => {
  const React = require('react');
  return {
    FollowUpComposer: React.forwardRef(() => null),
  };
});
jest.mock('../src/features/chat/messageActions', () => ({
  dispatchMessageAction: jest.fn(),
}));
jest.mock('../src/features/chat/LinkedIssueViewerHost', () => ({
  useLinkedIssueViewer: jest.fn(() => ({ open: jest.fn(), element: null })),
}));
jest.mock('../src/features/chat/interactions', () => {
  const React = require('react');
  return {
    ActiveChatInteractions: () => null,
    ChatInteractionProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    // ActiveChatScreen reads the pending-ask flag to gate the list's auto-scroll
    // suppression (issue #10). No prompt in this suite → always false.
    useInteractionStore: (selector: (s: { askPrompts: Record<string, unknown> }) => unknown) =>
      selector({ askPrompts: {} }),
  };
});
jest.mock('../src/features/chat/MessageList', () => ({ MessageList: () => null }));
jest.mock('../src/features/chat/runtime/ChatRuntimeBubble', () => ({
  ChatRuntimeBubble: () => null,
}));
jest.mock('../src/features/chat/runtime/useChatRuntimePreview', () => ({
  useChatRuntimePreview: jest.fn(() => null),
}));
jest.mock('../src/features/chat/useChatComposer', () => ({
  DEFAULT_AGENT_SETUP: null,
}));
jest.mock('../src/features/chat/useChatSettings', () => ({
  useChatSettings: jest.fn(() => ({
    settings: {
      model: 'claude-sonnet-4-6',
      permissions: 'default',
      agentSetupId: null,
    },
    loading: false,
    update: jest.fn(),
  })),
}));
jest.mock('../src/features/chat/useChatStream', () => ({
  useChatStream: jest.fn(() => ({
    messages: [],
    status: 'idle',
    error: null,
    isWorking: false,
    markRead: jest.fn(),
    hasMore: false,
    isLoadingMore: false,
    loadMore: jest.fn(),
  })),
}));
jest.mock('../src/theme', () => ({
  useAppTheme: jest.fn(() => ({
    theme: {
      colors: {
        background: '#000000',
        text: '#ffffff',
        borderLight: '#333333',
        primary: '#6366f1',
      },
    },
  })),
  Icon: () => null,
}));

import React from 'react';
import { KeyboardAvoidingView as RN_KAV, Platform } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ActiveChatScreen } from '../src/features/chat/ActiveChatScreen';

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function setPlatformOS(os: 'ios' | 'android') {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true, writable: true });
}

function renderScreen() {
  return render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <ActiveChatScreen />
    </SafeAreaProvider>
  );
}

describe('active-chat keyboard avoidance', () => {
  const originalOS = Platform.OS;

  afterEach(() => {
    setPlatformOS(originalOS as 'ios' | 'android');
  });

  it('iOS: KeyboardAvoidingView mounts with defined behavior', () => {
    setPlatformOS('ios');
    renderScreen();
    const kav = screen.getByTestId('active-chat');
    expect(kav.props.behavior).toBeDefined();
  });

  it('Android: KeyboardAvoidingView mounts with defined behavior (not a no-op)', () => {
    setPlatformOS('android');
    renderScreen();
    const kav = screen.getByTestId('active-chat');
    // Before fix: RN's KAV with behavior=undefined → this assertion FAILS.
    // After fix: keyboard-controller's KAV with behavior="padding" → PASSES.
    expect(kav.props.behavior).toBeDefined();
  });

  it('component identity: keyboard-controller KAV is mounted, not react-native own KAV', () => {
    setPlatformOS('ios');
    renderScreen();
    const kav = screen.getByTestId('active-chat');
    // The keyboard-controller jest mock maps KeyboardAvoidingView → react-native View
    // (a different object identity from react-native's own KAV class component).
    // If someone silently reverts to RN's own KAV, kav.type becomes the class (or
    // getByTestId throws on the duplicate testID that RN KAV's render() passes to
    // its inner View) — either way this assertion fails, catching the silent revert.
    expect(kav.type).not.toBe(RN_KAV);
  });
});
