/**
 * Voice input — local-first on-device dictation (POC).
 *
 * Speech→text runs entirely ON-DEVICE (native STT); the recognized transcript is
 * inserted directly — there is NO server correction round-trip. These tests inject a
 * FAKE recognizer (no `expo-speech-recognition`, no audio, no network) and verify:
 *
 *   1. tapping the mic requests permission and starts recognition;
 *   2. interim results render as the live "…" buffer; volume drives the waveform;
 *   3. final segments accumulate, and stop assembles + inserts the full transcript;
 *   4. permission-denied (no recognition) + the `useNativeDictation` ViewModel cases.
 */

// VoiceInput/Waveform consume useAppTheme → themeStore → MMKV. Mock it (in-memory).
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

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import {
  VoiceInput,
  useNativeDictation,
  volumeToLevel,
  type NativeSpeechRecognizer,
  type SpeechRecognizerCallbacks,
} from '../src/features/chat/voice';

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/**
 * A fake recognizer + controller. The `useRecognizer` hook holds the waveform `level`
 * (driven by `emitVolume`); `emitResult` pushes interim/final results into the bound
 * ViewModel callbacks. No native module, no audio.
 */
function makeFakeRecognizer(granted = true) {
  const state = {
    callbacks: null as SpeechRecognizerCallbacks | null,
    setLevel: (_n: number) => {},
    permissionRequests: 0,
    startCalls: 0,
    stopCalls: 0,
    abortCalls: 0,
    granted,
  };

  const recognizer: NativeSpeechRecognizer = {
    requestPermission: async () => {
      state.permissionRequests += 1;
      return state.granted;
    },
    start: async (callbacks) => {
      state.callbacks = callbacks;
      state.startCalls += 1;
    },
    stop: async () => {
      state.stopCalls += 1;
    },
    abort: async () => {
      state.abortCalls += 1;
    },
  };

  const useRecognizer = () => {
    const [level, setLevel] = useState(0);
    state.setLevel = setLevel;
    return { recognizer, level };
  };

  return {
    useRecognizer,
    state,
    emitResult: (transcript: string, isFinal: boolean) =>
      act(() => state.callbacks?.onResult({ transcript, isFinal })),
    emitVolume: (raw: number) =>
      act(() => {
        const lvl = volumeToLevel(raw);
        state.setLevel(lvl);
        state.callbacks?.onVolume?.(lvl);
      }),
  };
}

/** Harness: a TextInput whose value VoiceInput appends transcriptions to. */
function VoiceHarness({
  fake,
  onPermissionDenied,
}: {
  fake: ReturnType<typeof makeFakeRecognizer>;
  onPermissionDenied?: () => void;
}) {
  const [text, setText] = useState('');
  return (
    <>
      <TextInput testID="harness-input" value={text} onChangeText={setText} />
      <VoiceInput
        useRecognizer={fake.useRecognizer}
        onTranscription={(t) => setText((prev) => (prev ? `${prev} ${t}` : t))}
        onPermissionDenied={onPermissionDenied}
      />
    </>
  );
}

function mount(fake: ReturnType<typeof makeFakeRecognizer>, onPermissionDenied?: () => void) {
  render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <VoiceHarness fake={fake} onPermissionDenied={onPermissionDenied} />
    </SafeAreaProvider>
  );
}

function barHeight(index: number): number {
  const style = screen.getByTestId(`voice-waveform-bar-${index}`).props.style as Array<
    Record<string, unknown>
  >;
  const heightLayer = style.find((s) => s && typeof s.height === 'number');
  return (heightLayer?.height as number) ?? 0;
}

describe('VoiceInput — on-device dictation', () => {
  it('requests permission, streams interim "…" text, and inserts the assembled transcript on stop', async () => {
    const fake = makeFakeRecognizer();
    mount(fake);

    // Idle.
    expect(screen.getByTestId('voice-input-mic')).toBeTruthy();
    expect(screen.queryByTestId('voice-waveform')).toBeNull();

    // Tap mic → permission + start.
    await act(async () => {
      fireEvent.press(screen.getByTestId('voice-input-mic'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fake.state.permissionRequests).toBe(1);
    expect(fake.state.startCalls).toBe(1);
    expect(screen.getByTestId('voice-input-recording')).toBeTruthy();
    expect(screen.getByTestId('voice-live-placeholder')).toBeTruthy();

    // Interim result → live pending buffer with a trailing ellipsis.
    fake.emitResult('check the redis', false);
    expect(screen.getByTestId('voice-live-text')).toHaveTextContent('check the redis…');

    // Volume drives the waveform.
    const quiet = barHeight(12);
    fake.emitVolume(8);
    expect(barHeight(12)).toBeGreaterThan(quiet);

    // Finalize the first utterance, then a second one accumulates.
    fake.emitResult('Check the Redis connection.', true);
    fake.emitResult('Run the Playwright tests.', true);
    expect(screen.getByTestId('voice-live-text')).toHaveTextContent(
      'Check the Redis connection. Run the Playwright tests.'
    );

    // Stop → the full transcript is inserted; no network involved.
    await act(async () => {
      fireEvent.press(screen.getByTestId('voice-input-stop'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('harness-input').props.value).toBe(
      'Check the Redis connection. Run the Playwright tests.'
    );
    expect(fake.state.stopCalls).toBe(1);
    expect(screen.getByTestId('voice-input-mic')).toBeTruthy();
    expect(screen.queryByTestId('voice-input-recording')).toBeNull();
  });

  it('shows the existing composer text dimmed ahead of the live transcript', async () => {
    const fake = makeFakeRecognizer();
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <VoiceInput
          useRecognizer={fake.useRecognizer}
          onTranscription={() => {}}
          existingText="already typed"
        />
      </SafeAreaProvider>
    );

    await act(async () => {
      fireEvent.press(screen.getByTestId('voice-input-mic'));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The existing text is shown as a prefix even before any speech…
    expect(screen.getByTestId('voice-existing-text')).toHaveTextContent('already typed');
    // …and the live transcript renders alongside it (not replacing it).
    fake.emitResult('and more', false);
    expect(screen.getByTestId('voice-existing-text')).toHaveTextContent('already typed');
    expect(screen.getByTestId('voice-live-text')).toHaveTextContent('and more…');
  });

  it('does not start recognition when permission is denied', async () => {
    const onPermissionDenied = jest.fn();
    const fake = makeFakeRecognizer(false);
    mount(fake, onPermissionDenied);

    await act(async () => {
      fireEvent.press(screen.getByTestId('voice-input-mic'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fake.state.permissionRequests).toBe(1);
    expect(onPermissionDenied).toHaveBeenCalledTimes(1);
    expect(fake.state.startCalls).toBe(0);
    expect(screen.queryByTestId('voice-input-recording')).toBeNull();
    expect(screen.getByTestId('voice-input-mic')).toBeTruthy();
  });
});

describe('useNativeDictation — ViewModel', () => {
  function fakeRecognizer(granted = true) {
    let cb: SpeechRecognizerCallbacks | null = null;
    const r = {
      requestPermission: jest.fn(async () => granted),
      start: jest.fn(async (callbacks: SpeechRecognizerCallbacks) => {
        cb = callbacks;
      }),
      stop: jest.fn(async () => {}),
      abort: jest.fn(async () => {}),
    };
    return {
      recognizer: r as unknown as NativeSpeechRecognizer,
      emit: (t: string, f: boolean) => cb?.onResult({ transcript: t, isFinal: f }),
      endUtterance: () => cb?.onUtteranceEnd?.(),
    };
  }

  it('preserves a paused utterance (no final) via the utterance-end flush', async () => {
    const { recognizer, emit, endUtterance } = fakeRecognizer();
    const onTranscription = jest.fn();
    const { result } = renderHook(() => useNativeDictation({ recognizer, onTranscription }));

    await act(async () => {
      await result.current.start();
    });
    // First utterance arrives only as a PARTIAL (no isFinal), then a pause ends it.
    act(() => emit('hello world', false));
    act(() => endUtterance()); // pause → must commit 'hello world', not lose it
    // Next utterance overwrites the pending buffer — but the first was already committed.
    act(() => emit('foo bar', false));
    await act(async () => {
      await result.current.stop();
    });

    expect(onTranscription).toHaveBeenCalledWith('hello world foo bar');
  });

  it('does NOT duplicate when iOS delivers cumulative results across an isFinal', async () => {
    // iOS SFSpeechRecognizer keeps results CUMULATIVE within a session — each result is
    // the WHOLE transcript so far, including AFTER an isFinal. The old "append every final"
    // logic re-added everything ("rewrites the whole thing"). It must REPLACE instead.
    const { recognizer, emit } = fakeRecognizer();
    const onTranscription = jest.fn();
    const { result } = renderHook(() => useNativeDictation({ recognizer, onTranscription }));

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      emit('check the', false); // interim
      emit('check the redis', false); // interim grows
      emit('check the redis connection.', true); // final (cumulative)
      emit('check the redis connection. run the tests.', true); // iOS: STILL cumulative
    });
    await act(async () => {
      await result.current.stop();
    });

    expect(onTranscription).toHaveBeenCalledWith('check the redis connection. run the tests.');
  });

  it('accumulates reset chunks within ONE session (no final, no end — real Samsung trace)', async () => {
    // The on-device engine streams partials that GROW within a chunk, then RESET to just
    // the NEW words after a pause — with NO isFinal and NO `end` for the whole session.
    // (Verified on a Samsung S25: "Hello!" → "Hello, hello." → " World." → " Hello!".)
    // Each reset must COMMIT the prior chunk, not replace it (the data-loss bug).
    const { recognizer, emit } = fakeRecognizer();
    const onTranscription = jest.fn();
    const { result } = renderHook(() => useNativeDictation({ recognizer, onTranscription }));

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      emit('Hello', false); // chunk 1 grows…
      emit('Hello hello', false);
      emit('World', false); // ← reset to new words (NOT cumulative) → commit "Hello hello"
      emit('World how are you', false); // chunk 2 grows…
      emit('I am fine', false); // ← reset → commit "World how are you"
    });
    await act(async () => {
      await result.current.stop();
    });

    expect(onTranscription).toHaveBeenCalledWith('Hello hello World how are you I am fine');
  });

  it('keeps independent Android segments across an utterance boundary', async () => {
    // Android segmented continuous: a fresh final, then a pause/end, then a NEW independent
    // segment — both must survive (this is the path the long-press multi-sentence case hits).
    const { recognizer, emit, endUtterance } = fakeRecognizer();
    const onTranscription = jest.fn();
    const { result } = renderHook(() => useNativeDictation({ recognizer, onTranscription }));

    await act(async () => {
      await result.current.start();
    });
    act(() => emit('first sentence.', true));
    act(() => endUtterance()); // pause → segment boundary, auto-restart
    act(() => emit('second sentence.', true));
    await act(async () => {
      await result.current.stop();
    });

    expect(onTranscription).toHaveBeenCalledWith('first sentence. second sentence.');
  });

  it('does NOT double a segment when a trailing/echo result re-states it after an utterance-end flush', async () => {
    // The "doubled text" bug: on Android `dictation`, a pause fires `end` (→ utterance-end
    // flush commits the segment + clears pending) and THEN the just-ended session delivers a
    // trailing final — or the auto-restarted session echoes its first partial — that merely
    // RE-STATES the segment we just committed. With `pending` empty, the naive accumulator
    // wrote that echo straight back into `pending`, so committed + pending rendered the phrase
    // TWICE (and, non-consecutively, inserted it twice).
    const { recognizer, emit, endUtterance } = fakeRecognizer();
    const onTranscription = jest.fn();
    const { result } = renderHook(() => useNativeDictation({ recognizer, onTranscription }));

    await act(async () => {
      await result.current.start();
    });
    act(() => emit('first sentence.', true));
    act(() => endUtterance()); // pause → commit 'first sentence.', clear pending, (auto-restart)
    // ECHO of the just-committed segment (late final / restart partial) — must NOT double it.
    act(() => emit('first sentence.', true));
    expect(result.current.liveText).toBe('first sentence.'); // display shows it ONCE
    // A genuinely new utterance still accumulates normally.
    act(() => emit('second sentence.', true));
    await act(async () => {
      await result.current.stop();
    });

    expect(onTranscription).toHaveBeenCalledWith('first sentence. second sentence.');
  });

  it('absorbs a cumulative echo that EXTENDS the just-committed segment across the flush', async () => {
    // A softer echo: after the flush, the restarted session re-delivers the committed words
    // PLUS more ("first sentence." → "first sentence. and more"). The extension must refine the
    // segment in place, not append a second copy of "first sentence.".
    const { recognizer, emit, endUtterance } = fakeRecognizer();
    const onTranscription = jest.fn();
    const { result } = renderHook(() => useNativeDictation({ recognizer, onTranscription }));

    await act(async () => {
      await result.current.start();
    });
    act(() => emit('first sentence.', true));
    act(() => endUtterance());
    act(() => emit('first sentence. and more', true)); // echo + extension
    await act(async () => {
      await result.current.stop();
    });

    expect(onTranscription).toHaveBeenCalledWith('first sentence. and more');
  });

  it('absorbs a late final that is cumulative over MULTIPLE committed segments', async () => {
    // The real doubling trace (Samsung `dictation`): partials RESET at pauses (committing
    // chunks along the way), then the engine delivers a late final that is CUMULATIVE over
    // the WHOLE session — re-stating SEVERAL committed segments, not just the last one. The
    // old guard compared only the LAST segment, so the multi-segment echo appended and the
    // entire block rendered/inserted twice.
    const { recognizer, emit, endUtterance } = fakeRecognizer();
    const onTranscription = jest.fn();
    const { result } = renderHook(() => useNativeDictation({ recognizer, onTranscription }));

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      emit('hello there', false); // chunk 1 grows…
      emit('general kenobi', false); // ← reset → commit 'hello there'
    });
    act(() => endUtterance()); // pause → commit 'general kenobi', pending empty
    // Late final = the WHOLE session so far (spans BOTH committed segments).
    act(() => emit('hello there general kenobi', true));
    expect(result.current.liveText).toBe('hello there general kenobi'); // shown ONCE
    act(() => emit('second sentence.', true));
    await act(async () => {
      await result.current.stop();
    });

    expect(onTranscription).toHaveBeenCalledWith('hello there general kenobi second sentence.');
  });

  it('absorbs a cumulative echo whose committed tail was cut MID-WORD by the flush', async () => {
    // The flush can commit a partial truncated mid-word ("…the text evalu"); the late final
    // then completes it ("…the text evaluates"). A word-boundary-only comparison misses the
    // restatement and the phrase doubles.
    const { recognizer, emit, endUtterance } = fakeRecognizer();
    const onTranscription = jest.fn();
    const { result } = renderHook(() => useNativeDictation({ recognizer, onTranscription }));

    await act(async () => {
      await result.current.start();
    });
    act(() => emit('when the text evalu', false)); // partial, cut mid-word
    act(() => endUtterance()); // flush commits the truncated partial
    act(() => emit('when the text evaluates, and continues', true)); // echo completes the word
    await act(async () => {
      await result.current.stop();
    });

    expect(onTranscription).toHaveBeenCalledWith('when the text evaluates, and continues');
  });

  it('absorbs a session-cumulative final while a pending chunk is still in progress', async () => {
    // No `end` at all: partials reset (committing chunk 1), chunk 2 is still PENDING when the
    // engine emits a final cumulative over the whole session (chunk 1 + chunk 2). The old guard
    // only ran with `pending` empty, so the final appended and both chunks doubled.
    const { recognizer, emit } = fakeRecognizer();
    const onTranscription = jest.fn();
    const { result } = renderHook(() => useNativeDictation({ recognizer, onTranscription }));

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      emit('certain segments repeat', false); // chunk 1 grows…
      emit('at sentence breaks', false); // ← reset → commit 'certain segments repeat'
      emit('certain segments repeat at sentence breaks', true); // cumulative final (spans both)
    });
    await act(async () => {
      await result.current.stop();
    });

    expect(onTranscription).toHaveBeenCalledWith('certain segments repeat at sentence breaks');
  });

  it('does NOT treat a shared single-word prefix as an echo ("go" vs "google")', async () => {
    // The truncation tolerance must stay word-boundary-safe for a SINGLE-word segment: a new
    // utterance that begins with a longer word sharing the prefix is genuine new speech.
    const { recognizer, emit, endUtterance } = fakeRecognizer();
    const onTranscription = jest.fn();
    const { result } = renderHook(() => useNativeDictation({ recognizer, onTranscription }));

    await act(async () => {
      await result.current.start();
    });
    act(() => emit('go', true));
    act(() => endUtterance());
    act(() => emit('google it', false));
    await act(async () => {
      await result.current.stop();
    });

    expect(onTranscription).toHaveBeenCalledWith('go google it');
  });

  it('assembles multiple finalized utterances in order on stop', async () => {
    const { recognizer, emit } = fakeRecognizer();
    const onTranscription = jest.fn();
    const { result } = renderHook(() => useNativeDictation({ recognizer, onTranscription }));

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      emit('first sentence.', true);
      emit('second sentence.', true);
    });
    await act(async () => {
      await result.current.stop();
    });

    expect(onTranscription).toHaveBeenCalledWith('first sentence. second sentence.');
  });

  it('finalizes the trailing interim on stop even without a final result', async () => {
    const { recognizer, emit } = fakeRecognizer();
    const onTranscription = jest.fn();
    const { result } = renderHook(() => useNativeDictation({ recognizer, onTranscription }));

    await act(async () => {
      await result.current.start();
    });
    act(() => emit('trailing words', false)); // interim only — never finalized
    await act(async () => {
      await result.current.stop();
    });

    expect(onTranscription).toHaveBeenCalledWith('trailing words');
  });

  it('does not insert anything when permission is denied', async () => {
    const { recognizer } = fakeRecognizer(false);
    const onPermissionDenied = jest.fn();
    const onTranscription = jest.fn();
    const { result } = renderHook(() =>
      useNativeDictation({ recognizer, onTranscription, onPermissionDenied })
    );

    await act(async () => {
      await result.current.start();
    });

    expect(onPermissionDenied).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('idle');
    expect(onTranscription).not.toHaveBeenCalled();
  });

  it('cancel discards the dictation (abort, no insertion)', async () => {
    const { recognizer, emit } = fakeRecognizer();
    const onTranscription = jest.fn();
    const { result } = renderHook(() => useNativeDictation({ recognizer, onTranscription }));

    await act(async () => {
      await result.current.start();
    });
    act(() => emit('discard me', true));
    await act(async () => {
      await result.current.cancel();
    });

    expect(recognizer.abort).toHaveBeenCalledTimes(1);
    expect(onTranscription).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');
  });
});

describe('volumeToLevel', () => {
  it('maps the recognizer volume range to 0..1', () => {
    expect(volumeToLevel(-2)).toBe(0);
    expect(volumeToLevel(10)).toBe(1);
    expect(volumeToLevel(4)).toBeCloseTo(0.5, 5);
    expect(volumeToLevel(-100)).toBe(0); // clamped
    expect(volumeToLevel(NaN)).toBe(0);
  });
});
