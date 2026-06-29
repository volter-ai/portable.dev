/**
 * AI Style settings page (`/settings/ai-style`) — web `AIStyleSection` parity.
 *
 * Pure store page (NO HTTP → no ApiProvider/mock gateway needed). Mount
 * `AiStyleScreen` under SafeAreaProvider with the in-memory MMKV mock and
 * assert:
 *   1. one OptionButton per shared `AI_STYLES` entry (exact shared label +
 *      description strings) + the header copy; default selection = professional;
 *   2. selecting a style writes `chatStore.aiStyle` (and the MMKV
 *      `portable.chat` blob) and the re-render reflects it;
 *   3. the custom-instructions input renders ONLY for 'custom';
 *   4. the custom prompt persists on BLUR (endEditing → store + MMKV blob),
 *      never per keystroke;
 *   5. the custom input is seeded from the persisted prompt.
 */

// ── Hoisted mocks (must precede the SUT import) ──────────────────────────────

// In-memory MMKV — backs BOTH the chat slice under test and useAppTheme's themeStore.
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string) => store.set(k, String(v)),
    getString: (k: string) => store.get(k),
    remove: (k: string) => store.delete(k),
    contains: (k: string) => store.has(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

// Inert in-memory keychain (defensive — nothing in this graph should write secrets).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    getItemAsync: async (k: string) => (store.has(k) ? store.get(k)! : null),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});

jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn(() => () => {}),
  fetch: jest.fn(async () => ({ isConnected: true })),
}));

import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AI_STYLES, DEFAULT_AI_STYLE, type AIStyleMode } from '@vgit2/shared/aiStyles';

import {
  AiStyleScreen,
  AI_STYLE_HEADER_COPY,
} from '../src/features/settings/sections/ai-style/AiStyleScreen';
import { CHAT_PERSIST_KEY, useChatStore } from '../src/features/state/chatStore';

const mmkvStore = (jest.requireMock('react-native-mmkv') as { __store: Map<string, string> })
  .__store;

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const ALL_STYLE_IDS = Object.keys(AI_STYLES) as AIStyleMode[];

function renderAiStyle() {
  render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <AiStyleScreen />
    </SafeAreaProvider>
  );
}

/** Persist writes are effectively synchronous (MMKV adapter), but yield a tick defensively. */
async function flushPersist() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function persistedChatState(): { aiStyle: string; customAiStylePrompt: string } {
  const raw = mmkvStore.get(CHAT_PERSIST_KEY);
  expect(raw).toBeDefined();
  return (JSON.parse(raw!) as { state: { aiStyle: string; customAiStylePrompt: string } }).state;
}

describe('settings — AI Style page', () => {
  beforeEach(() => {
    // Reset the slice back to defaults, then drop the persisted blob so each
    // test asserts only its OWN writes.
    useChatStore.setState({ aiStyle: DEFAULT_AI_STYLE, customAiStylePrompt: '' });
    mmkvStore.clear();
  });

  it('renders the header copy + one option per shared style (exact strings), default = professional', () => {
    renderAiStyle();

    expect(screen.getByText(AI_STYLE_HEADER_COPY)).toBeTruthy();
    expect(screen.getByTestId('settings-ai-style-selected')).toHaveTextContent(DEFAULT_AI_STYLE);

    for (const id of ALL_STYLE_IDS) {
      const option = screen.getByTestId(`settings-ai-style-option-${id}`);
      expect(within(option).getByText(AI_STYLES[id].label)).toBeTruthy();
      expect(within(option).getByText(AI_STYLES[id].description)).toBeTruthy();
    }

    // Default is professional, so the custom editor is hidden.
    expect(screen.queryByTestId('settings-ai-style-custom-input')).toBeNull();
  });

  it('selecting a style writes the store + the MMKV blob, and the re-render reflects it', async () => {
    renderAiStyle();

    fireEvent.press(screen.getByTestId('settings-ai-style-option-zen'));
    await flushPersist();

    expect(useChatStore.getState().aiStyle).toBe('zen');
    expect(screen.getByTestId('settings-ai-style-selected')).toHaveTextContent('zen');
    expect(persistedChatState().aiStyle).toBe('zen');
  });

  it('shows the custom-instructions input only while aiStyle === custom', () => {
    renderAiStyle();

    expect(screen.queryByTestId('settings-ai-style-custom-input')).toBeNull();

    fireEvent.press(screen.getByTestId('settings-ai-style-option-custom'));
    expect(screen.getByTestId('settings-ai-style-custom-input')).toBeTruthy();
    expect(screen.getByText('Your custom style will be applied to all new messages')).toBeTruthy();

    fireEvent.press(screen.getByTestId('settings-ai-style-option-professional'));
    expect(screen.queryByTestId('settings-ai-style-custom-input')).toBeNull();
  });

  it('persists the custom prompt on blur (not per keystroke) to the store + MMKV blob', async () => {
    renderAiStyle();

    fireEvent.press(screen.getByTestId('settings-ai-style-option-custom'));
    const input = screen.getByTestId('settings-ai-style-custom-input');

    fireEvent.changeText(input, 'Answer everything as a haiku.');
    // Web parity: typing only edits the temp draft — nothing persisted yet.
    expect(useChatStore.getState().customAiStylePrompt).toBe('');

    fireEvent(input, 'endEditing');
    await flushPersist();

    expect(useChatStore.getState().customAiStylePrompt).toBe('Answer everything as a haiku.');
    expect(persistedChatState().customAiStylePrompt).toBe('Answer everything as a haiku.');
  });

  it('seeds the custom input from the persisted prompt', () => {
    useChatStore.setState({ aiStyle: 'custom', customAiStylePrompt: 'Be brief.' });
    renderAiStyle();

    expect(screen.getByTestId('settings-ai-style-custom-input').props.value).toBe('Be brief.');
  });
});
