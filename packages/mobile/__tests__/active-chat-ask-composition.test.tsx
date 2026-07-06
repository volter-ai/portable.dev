/**
 * Screen-level composition guard for issue #10.
 *
 * Mounts the REAL `ActiveChatScreen` with the REAL `MessageList` + REAL
 * `ActiveChatInteractions` (only the heavy leaf deps are stubbed) and a seeded
 * ask-user prompt, then asserts the prompt (questions + shared Submit) renders as
 * a DESCENDANT of the transcript FlatList — i.e. inside the one scroller.
 *
 * This is the guard the unit tests can't be: chat-interactions mounts its own
 * probe (it hand-wires `footer=`), and keyboard-avoidance null-mocks both
 * MessageList and ActiveChatInteractions. Reverting ActiveChatScreen's `footer`
 * wiring to a fixed sibling (the pre-fix layout that broke reaching Submit) would
 * leave those green; it turns THIS test red — the ask prompt would no longer be
 * inside `message-list`.
 */

// ── Native modules the real MessageList / theme graph touch ───────────────────
jest.mock('react-native-keyboard-controller', () =>
  require('react-native-keyboard-controller/jest')
);
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
jest.mock('react-native-markdown-display', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children?: unknown }) => <Text>{children}</Text>,
  };
});
jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async () => {}),
  getItemAsync: jest.fn(async () => null),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

// ── expo-router: chatId param + stub router ───────────────────────────────────
jest.mock('expo-router', () => ({
  __esModule: true,
  useLocalSearchParams: jest.fn(() => ({ chatId: 'chat-compose-1' })),
  useRouter: jest.fn(() => ({ back: jest.fn(), replace: jest.fn() })),
}));

// ── Heavy leaf deps of ActiveChatScreen — stubbed; MessageList + interactions
//    are DELIBERATELY left real (this test's whole point). ──────────────────────
jest.mock('../src/features/api/hooks', () => ({
  useAgentSetups: jest.fn(() => ({ data: { agentSetups: [] } })),
}));
jest.mock('../src/features/api/relayUrlStore', () => ({ getRelayUrl: jest.fn(async () => null) }));
jest.mock('../src/features/socket/useOfflineMessageQueue', () => ({
  useOfflineMessageQueue: jest.fn(() => ({ send: jest.fn(), flush: jest.fn() })),
}));
jest.mock('../src/features/socket/SocketProvider', () => ({
  useOptionalSocket: jest.fn(() => null),
}));
jest.mock('../src/features/home/LinkedIssueBadge', () => ({ LinkedIssueBadge: () => null }));
jest.mock('../src/features/chat/chrome/ChatChrome', () => ({ ChatChrome: () => null }));
jest.mock('../src/features/chat/chrome/useChatLinkedIssue', () => ({
  useChatLinkedIssue: jest.fn(() => null),
}));
jest.mock('../src/features/chat/chrome/useChatRepoPath', () => ({
  useChatRepoPath: jest.fn(() => null),
}));
jest.mock('../src/features/chat/FollowUpComposer', () => {
  const React = require('react');
  return { FollowUpComposer: React.forwardRef(() => null) };
});
jest.mock('../src/features/chat/LinkedIssueViewerHost', () => ({
  useLinkedIssueViewer: jest.fn(() => ({ open: jest.fn(), element: null })),
}));
jest.mock('../src/features/chat/RunningOnPcBadge', () => ({ RunningOnPcBadge: () => null }));
jest.mock('../src/features/chat/RunningOnPcBanner', () => ({ RunningOnPcBanner: () => null }));
jest.mock('../src/features/chat/useRunningOnPc', () => ({
  useRunningOnPc: jest.fn(() => ({ onPc: false, runningOnPc: false })),
}));
jest.mock('../src/features/chat/runtime/ChatRuntimeBubble', () => ({
  ChatRuntimeBubble: () => null,
}));
jest.mock('../src/features/chat/runtime/useChatRuntimePreview', () => ({
  useChatRuntimePreview: jest.fn(() => null),
}));
jest.mock('../src/features/chat/useChatComposer', () => ({ DEFAULT_AGENT_SETUP: null }));
jest.mock('../src/features/chat/useChatSettings', () => ({
  useChatSettings: jest.fn(() => ({
    settings: { model: 'opus', permissions: 'default', agentSetupId: null },
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

import { act, render, screen, within } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ActiveChatScreen } from '../src/features/chat/ActiveChatScreen';
import { useInteractionStore } from '../src/features/chat';

const CHAT_ID = 'chat-compose-1';
const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function renderScreen() {
  return render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <ActiveChatScreen />
    </SafeAreaProvider>
  );
}

describe('ActiveChatScreen ask-prompt composition (issue #10)', () => {
  afterEach(() => {
    act(() => useInteractionStore.getState().reset());
  });

  it('renders the ask prompt (questions + shared Submit) INSIDE the transcript scroller', () => {
    // Seed an active ask prompt for this chat before mounting the screen.
    act(() =>
      useInteractionStore.getState().setAskPrompt({
        chatId: CHAT_ID,
        requestId: 'req-compose',
        questions: [
          {
            question: 'Which framework?',
            header: 'FW',
            multiSelect: false,
            options: [
              { label: 'Expo', description: 'RN' },
              { label: 'Flutter', description: 'Dart' },
            ],
          },
        ],
      })
    );

    renderScreen();

    // The whole prompt is a descendant of the FlatList (scrollable content) — NOT a
    // sibling below it. A revert to the pre-fix sibling layout makes these queries fail.
    const list = within(screen.getByTestId('message-list'));
    expect(list.getByTestId('ask-user-question')).toBeTruthy();
    expect(list.getByTestId('ask-question-submit')).toBeTruthy();
  });

  it('renders no ask prompt inside the list when none is pending', () => {
    renderScreen();
    const list = within(screen.getByTestId('message-list'));
    expect(list.queryByTestId('ask-user-question')).toBeNull();
  });
});
