/**
 * Voice input modes — the shared trailing send↔voice button
 * (`tasks/prd-voice-input-modes.md`).
 *
 * Unit-level coverage of `InputActionButton` (the send↔voice primary glyph + the small
 * secondary badge, the per-mode tap dispatch, the long-press toggle, and the disabled-send
 * gate) plus a render check for the redrawn `gear` cog — no native modules, no providers
 * beyond the theme (MMKV-backed `themeStore`). The transient auto-revert behavior is
 * exercised end-to-end in `chat-composer.test.tsx`.
 */

// useAppTheme → themeStore → MMKV. Mock it (in-memory).
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string) => store.set(k, String(v)),
    getString: (k: string) => store.get(k),
    remove: (k: string) => store.delete(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { InputActionButton } from '../src/features/chat/composer';
import { Icon } from '../src/theme';

describe('InputActionButton', () => {
  function renderButton(overrides: Partial<React.ComponentProps<typeof InputActionButton>> = {}) {
    const onSend = jest.fn();
    const onStartVoice = jest.fn();
    const onToggleMode = jest.fn();
    render(
      <InputActionButton
        mode="send"
        canSend
        onSend={onSend}
        onStartVoice={onStartVoice}
        onToggleMode={onToggleMode}
        sendTestID="x-send"
        voiceTestID="x-voice"
        {...overrides}
      />
    );
    return { onSend, onStartVoice, onToggleMode };
  }

  it('send mode: renders the send button + a mic badge; tap sends', () => {
    const { onSend, onStartVoice } = renderButton({ mode: 'send' });
    expect(screen.getByTestId('x-send')).toBeTruthy();
    expect(screen.getByTestId('x-send-badge')).toBeTruthy(); // the small voice badge
    expect(screen.queryByTestId('x-voice')).toBeNull();

    fireEvent.press(screen.getByTestId('x-send'));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onStartVoice).not.toHaveBeenCalled();
  });

  it('voice mode: renders the voice button + a send badge; tap starts voice', () => {
    const { onSend, onStartVoice } = renderButton({ mode: 'voice' });
    expect(screen.getByTestId('x-voice')).toBeTruthy();
    expect(screen.getByTestId('x-voice-badge')).toBeTruthy();
    expect(screen.queryByTestId('x-send')).toBeNull();

    fireEvent.press(screen.getByTestId('x-voice'));
    expect(onStartVoice).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('long-press toggles the mode', () => {
    const { onToggleMode } = renderButton({ mode: 'send' });
    fireEvent(screen.getByTestId('x-send'), 'longPress');
    expect(onToggleMode).toHaveBeenCalledTimes(1);
  });

  it('a blocked send (canSend false) does not fire onSend', () => {
    const { onSend } = renderButton({ mode: 'send', canSend: false });
    fireEvent.press(screen.getByTestId('x-send'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('omitting the badge (empty state) renders no secondary glyph', () => {
    renderButton({ mode: 'voice', showBadge: false, onToggleMode: undefined });
    expect(screen.getByTestId('x-voice')).toBeTruthy();
    expect(screen.queryByTestId('x-voice-badge')).toBeNull();
  });
});

describe('gear icon', () => {
  it('renders (the voice-settings cog)', () => {
    render(
      <Text testID="gear-host">
        <Icon name="gear" size={18} />
      </Text>
    );
    expect(screen.getByTestId('gear-host')).toBeTruthy();
  });
});
