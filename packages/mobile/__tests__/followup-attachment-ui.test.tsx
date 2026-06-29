/**
 * Follow-up attachment UI rendering tests.
 *
 *   F1-a: MessageList renders an Image thumbnail for each `localFileUri` on a
 *         user message (`testID="user-attachment-{index}-{i}"`).
 *   F1-c: FollowUpComposer wires AttachmentBar.onChange → onSend(content, attachments)
 *         → clear(); and isUploading guard blocks send while any upload is in flight.
 */

// F1-a: block-renderer TextBlock imports react-native-markdown-display (ESM, fails
// under Jest). Mock it so rendering MessageList never loads the real parser.
jest.mock('react-native-markdown-display', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children?: unknown }) => <Text>{children}</Text>,
  };
});

// F1-c: FollowUpComposer embeds VoiceInput which imports expo-audio.
jest.mock('expo-audio', () => require('../src/test/mockExpoAudio').createExpoAudioMock());

// useAppTheme → themeStore → state/storage → react-native-mmkv (nitro native module).
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string) => store.set(k, String(v)),
    getString: (k: string) => (store.has(k) ? store.get(k) : undefined),
    remove: (k: string) => {
      store.delete(k);
    },
    contains: (k: string) => store.has(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

// state/storage also imports expo-secure-store.
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    getItemAsync: async (k: string) => (store.has(k) ? store.get(k)! : null),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});

// F1-c: control the attachment state surfaced by AttachmentBar without driving the
// full expo-image-picker + upload stack. Variable starts with 'mock' so Babel's
// jest-hoist transform allows the reference inside jest.mock().
const mockUseAttachments = jest.fn();
jest.mock('../src/features/chat/attachments/useAttachments', () => ({
  ATTACHMENT_SOURCE_LABELS: { library: 'Photo Library', document: 'Files', camera: 'Camera' },
  useAttachments: (...args: unknown[]) => mockUseAttachments(...args),
}));

// F1-c: AttachmentBar and VoiceInput call useApi() — mock it to avoid needing a
// real ApiProvider with TanStack Query + SecureStore bootstrap.
jest.mock('../src/features/api/ApiProvider', () => ({
  useApi: () => ({}),
}));

// F1-c: FollowUpComposer calls useAgentSetups() for the agent selector; VoiceInput's
// recognizer calls useVoicePhrases() for the on-device biasing vocabulary.
jest.mock('../src/features/api/hooks', () => ({
  useAgentSetups: () => ({ data: { agentSetups: [] }, isLoading: false }),
  useVoicePhrases: () => ({ data: undefined, isLoading: false }),
  // FollowUpComposer calls useChatCommands() for the `/` slash-command picker.
  useChatCommands: () => ({ data: undefined, isLoading: false }),
  // UploadFileResponse is a type-only export — no runtime value needed.
}));

import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { MobileChatMessage } from '../src/features/chat/chatMessagesStore';
import { FollowUpComposer } from '../src/features/chat/FollowUpComposer';
import type { UploadedAttachment } from '../src/features/chat/attachments';
import { MessageList } from '../src/features/chat/MessageList';
import { DEFAULT_NEW_CHAT_SETTINGS } from '../src/features/state/chatStore';

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const TEST_ATTACHMENT: UploadedAttachment = {
  id: 'a-1',
  file: {
    uri: 'file:///test.jpg',
    name: 'test.jpg',
    mimeType: 'image/jpeg',
    source: 'library',
  },
  response: {
    fileName: 'srv-1.jpg',
    originalName: 'test.jpg',
    path: 'uploads/srv-1.jpg',
    absolutePath: '/workspace/uploads/srv-1.jpg',
    mimeType: 'image/jpeg',
    size: 12345,
  },
};

// ---------------------------------------------------------------------------
// F1-a — MessageList thumbnail render
// ---------------------------------------------------------------------------

describe('F1-a — MessageList thumbnail render', () => {
  it('user message with localFileUris renders an Image with the expected testID', () => {
    const messages: MobileChatMessage[] = [
      { role: 'user', content: 'see image', localFileUris: ['file:///test.jpg'] },
    ];
    render(<MessageList messages={messages} />);
    // testID pattern: `user-attachment-{listIndex}-{uriIndex}` (MessageList.tsx)
    expect(screen.getByTestId('user-attachment-0-0')).toBeTruthy();
  });

  it('user message without localFileUris renders no thumbnail', () => {
    const messages: MobileChatMessage[] = [{ role: 'user', content: 'text only' }];
    render(<MessageList messages={messages} />);
    expect(screen.queryByTestId('user-attachment-0-0')).toBeNull();
  });

  it('second localFileUri in the same message gets index 1', () => {
    const messages: MobileChatMessage[] = [
      {
        role: 'user',
        content: 'two images',
        localFileUris: ['file:///a.jpg', 'file:///b.jpg'],
      },
    ];
    render(<MessageList messages={messages} />);
    expect(screen.getByTestId('user-attachment-0-0')).toBeTruthy();
    expect(screen.getByTestId('user-attachment-0-1')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// F1-c — FollowUpComposer onChange → onSend → clear (+ F2 isUploading guard)
// ---------------------------------------------------------------------------

describe('F1-c — FollowUpComposer onChange → onSend → clear', () => {
  const mockClear = jest.fn();

  /** Build the minimal useAttachments return value the test needs. */
  function makeAttachState(opts?: { isUploading?: boolean }) {
    const uploading = opts?.isUploading ?? false;
    return {
      items: [{ ...TEST_ATTACHMENT, status: uploading ? 'uploading' : 'done' }],
      // onChange fires with uploaded (non-empty only when done)
      uploaded: uploading ? [] : [TEST_ATTACHMENT],
      isUploading: uploading,
      clear: mockClear,
      remove: jest.fn(),
      addFromLibrary: jest.fn(),
      addFromDocuments: jest.fn(),
      addFromCamera: jest.fn(),
      addFile: jest.fn(),
    };
  }

  beforeEach(() => {
    mockClear.mockClear();
    mockUseAttachments.mockReturnValue(makeAttachState());
  });

  it('onChange fires on mount → onSend receives text + attachments → clear is called', async () => {
    const onSend = jest.fn();
    render(
      <FollowUpComposer
        chatId="chat-1"
        settings={DEFAULT_NEW_CHAT_SETTINGS}
        onUpdateSettings={jest.fn()}
        onSend={onSend}
      />
    );
    // Flush AttachmentBar's useEffect (onChange + onItemCountChange fire after render).
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.changeText(screen.getByTestId('active-chat-composer-input'), 'what is this?');
    fireEvent.press(screen.getByTestId('active-chat-send'));

    expect(onSend).toHaveBeenCalledWith('what is this?', [TEST_ATTACHMENT]);
    expect(mockClear).toHaveBeenCalled();
  });

  it('isUploading guard (F2): send is blocked while an attachment is still uploading', async () => {
    mockUseAttachments.mockReturnValue(makeAttachState({ isUploading: true }));
    const onSend = jest.fn();
    render(
      <FollowUpComposer
        chatId="chat-1"
        settings={DEFAULT_NEW_CHAT_SETTINGS}
        onUpdateSettings={jest.fn()}
        onSend={onSend}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.changeText(screen.getByTestId('active-chat-composer-input'), 'hello');
    fireEvent.press(screen.getByTestId('active-chat-send'));

    expect(onSend).not.toHaveBeenCalled();
  });

  it('text-only send (no attachments) still calls onSend without attachments arg', async () => {
    // No items in the bar → uploaded is empty → handleSend passes undefined
    mockUseAttachments.mockReturnValue({
      items: [],
      uploaded: [],
      isUploading: false,
      clear: mockClear,
      remove: jest.fn(),
      addFromLibrary: jest.fn(),
      addFromDocuments: jest.fn(),
      addFromCamera: jest.fn(),
      addFile: jest.fn(),
    });
    const onSend = jest.fn();
    render(
      <FollowUpComposer
        chatId="chat-1"
        settings={DEFAULT_NEW_CHAT_SETTINGS}
        onUpdateSettings={jest.fn()}
        onSend={onSend}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.changeText(screen.getByTestId('active-chat-composer-input'), 'just text');
    fireEvent.press(screen.getByTestId('active-chat-send'));

    expect(onSend).toHaveBeenCalledWith('just text', undefined);
    expect(mockClear).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stop lives in the control row; the mic slot is ALWAYS the mic↔send
//   control (same pattern as the home composer). While a run is processing the
//   trailing slot still shows the mic (empty) / Send (typed) so the user can
//   dictate/compose the next message mid-run, and exactly one `active-chat-stop`
//   stays reachable in the control row the whole time. (Supersedes the earlier behaviour, which
//   hijacked the mic slot with a prominent Stop when the input was empty.)
// ---------------------------------------------------------------------------

describe('Stop in control row, mic slot stays mic↔send while processing', () => {
  /** Empty attachment bar so the mic↔send↔stop slot is what's exercised. */
  beforeEach(() => {
    mockUseAttachments.mockReturnValue({
      items: [],
      uploaded: [],
      isUploading: false,
      clear: jest.fn(),
      remove: jest.fn(),
      addFromLibrary: jest.fn(),
      addFromDocuments: jest.fn(),
      addFromCamera: jest.fn(),
      addFile: jest.fn(),
    });
  });

  function renderComposer(extra: {
    status?: 'running' | 'idle' | 'interrupting';
    onStop?: jest.Mock;
  }) {
    return render(
      <FollowUpComposer
        chatId="chat-1"
        settings={DEFAULT_NEW_CHAT_SETTINGS}
        onUpdateSettings={jest.fn()}
        onSend={jest.fn()}
        status={extra.status}
        onStop={extra.onStop}
      />
    );
  }

  it('running + empty input → mic stays in the slot, Stop reachable in the control row; press calls onStop', async () => {
    const onStop = jest.fn();
    renderComposer({ status: 'running', onStop });
    await act(async () => {
      await Promise.resolve();
    });

    // The mic↔send slot is forced into voice mode (mic) — NOT replaced by Stop —
    // so the user can dictate the next message while the run is still processing.
    expect(screen.getByTestId('active-chat-voice')).toBeTruthy();
    expect(screen.queryByTestId('active-chat-send')).toBeNull();

    // The (single) Stop lives in the control row and is reachable the whole time.
    expect(screen.getByTestId('active-chat-stop')).toBeTruthy();
    fireEvent.press(screen.getByTestId('active-chat-stop'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('running + typed text → Send shows and a single Stop stays reachable (control row)', async () => {
    renderComposer({ status: 'running', onStop: jest.fn() });
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.changeText(screen.getByTestId('active-chat-composer-input'), 'follow-up');

    expect(screen.getByTestId('active-chat-send')).toBeTruthy();
    // getByTestId (singular) proves there is exactly ONE stop on screen.
    expect(screen.getByTestId('active-chat-stop')).toBeTruthy();
    expect(screen.queryByTestId('voice-input-mic')).toBeNull();
  });

  it('idle (not processing) + empty input → mic shows, no Stop', async () => {
    renderComposer({ status: 'idle' });
    await act(async () => {
      await Promise.resolve();
    });

    // The empty trailing slot is the shared InputActionButton forced into voice mode.
    expect(screen.getByTestId('active-chat-voice')).toBeTruthy();
    expect(screen.queryByTestId('active-chat-stop')).toBeNull();
  });

  it('interrupting → Stop is disabled and does not re-fire onStop', async () => {
    const onStop = jest.fn();
    renderComposer({ status: 'interrupting', onStop });
    await act(async () => {
      await Promise.resolve();
    });

    const stop = screen.getByTestId('active-chat-stop');
    expect(stop.props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(stop);
    expect(onStop).not.toHaveBeenCalled();
  });
});
