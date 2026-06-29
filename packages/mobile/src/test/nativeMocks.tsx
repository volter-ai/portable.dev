import type { StyleProp, ViewStyle } from 'react-native';

/**
 * Shared jest.mock factory functions for common native modules used by the
 * file-viewer and related integration tests.
 *
 * Usage in test files:
 *
 *   jest.mock('react-native-mmkv', () =>
 *     require('../src/test/nativeMocks').mmkvMockFactory());
 *
 * Each factory returns the module shape jest.mock expects.  Factories that
 * wrap jest.fn() create fresh spy instances per test file (one factory call
 * per file at hoist time), so jest.clearAllMocks() properly resets them in
 * beforeEach.
 */

export function mmkvMockFactory() {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string) => store.set(k, String(v)),
    getString: (k: string) => store.get(k),
    remove: (k: string) => store.delete(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
}

export function secureStoreMockFactory() {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

export function netInfoMockFactory() {
  return {
    __esModule: true,
    default: { addEventListener: jest.fn(() => () => {}) },
  };
}

export function clipboardMockFactory() {
  return { setStringAsync: jest.fn(async () => true) };
}

export function webBrowserMockFactory() {
  return { openBrowserAsync: jest.fn(async () => ({})) };
}

export function markdownDisplayMockFactory() {
  // require('react-native') is valid inside a jest.mock factory require chain.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native') as typeof import('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children: string }) => <Text>{children}</Text>,
  };
}

export function pdfMockFactory() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native') as typeof import('react-native');
  return {
    __esModule: true,
    default: ({ source }: { source: { uri: string } }) => (
      <Text testID="pdf-source">{source?.uri}</Text>
    ),
  };
}

export function expoVideoMockFactory() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native') as typeof import('react-native');
  return {
    useVideoPlayer: (_source: unknown, setup?: (p: unknown) => void) => {
      const player = {
        loop: false,
        play: jest.fn(),
        addListener: (_e: string, _cb: unknown) => ({ remove: () => {} }),
      };
      setup?.(player);
      return player;
    },
    VideoView: ({ style, testID }: { style?: StyleProp<ViewStyle>; testID?: string }) =>
      React.createElement(View, { style, testID }),
  };
}

/** Simple stub for expo-audio used by screens that import it transitively. */
export function expoAudioSimpleMockFactory() {
  return {
    useAudioPlayer: () => ({ play: jest.fn(), pause: jest.fn(), seekTo: jest.fn(async () => {}) }),
    useAudioPlayerStatus: () => ({ playing: false, currentTime: 0, duration: 0, isLoaded: true }),
  };
}

/**
 * Stub for `expo-speech-recognition` (the on-device native STT module VoiceInput
 * lazy-`require`s). Grants permission and records start/stop/abort; `__emitResult`
 * pushes a recognition result into the last `result` listener so a test can drive the
 * live transcription. Use when a test RENDERS a real `VoiceInput` and taps the mic.
 */
export function speechRecognitionMockFactory() {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const ExpoSpeechRecognitionModule = {
    requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
    supportsOnDeviceRecognition: jest.fn(() => true),
    start: jest.fn(),
    stop: jest.fn(),
    abort: jest.fn(),
    addListener: jest.fn((event: string, cb: (e: unknown) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
      return {
        remove: () =>
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((l) => l !== cb)
          ),
      };
    }),
    __emitResult: (transcript: string, isFinal: boolean) => {
      for (const cb of listeners.get('result') ?? []) cb({ results: [{ transcript }], isFinal });
    },
  };
  return { __esModule: true, ExpoSpeechRecognitionModule };
}
