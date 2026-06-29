/**
 * Voice settings — strategy picker + custom phrases (the cog modal).
 *
 * Covers the strategy store + resolver, the `VoiceSettingsModal` (strategy selection +
 * phrase add/remove over a mock-gateway `/api/voice/phrases`), and the `VoiceInput` cog
 * (cancels the in-progress dictation + opens the modal).
 */

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

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    getItemAsync: async (k: string) => (store.has(k) ? store.get(k)! : null),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import {
  DEFAULT_VOICE_LANGUAGE,
  DEFAULT_VOICE_STRATEGY,
  VOICE_LANGUAGES,
  VOICE_STRATEGIES,
  VoiceInput,
  VoiceSettingsModal,
  getDefaultVoiceStrategy,
  resolveStartOptions,
  resolveVoiceLanguage,
  resolveVoiceStrategy,
  shouldAutoRestart,
  useVoiceSettingsStore,
  type NativeSpeechRecognizer,
  type SpeechRecognizerCallbacks,
} from '../src/features/chat/voice';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

const secureStore = (jest.requireMock('expo-secure-store') as { __store: Map<string, string> })
  .__store;
const SANDBOX_BASE = 'https://sandbox.portable.test';
const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const onlineNetInfo: NetInfoLike = { addEventListener: () => () => {} };

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

function Providers({
  gateway,
  qc,
  children,
}: {
  gateway: MockGateway;
  qc: QueryClient;
  children: React.ReactNode;
}) {
  return (
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <ApiProvider client={buildClient(gateway)} queryClient={qc} netInfo={onlineNetInfo}>
        {children as never}
      </ApiProvider>
    </SafeAreaProvider>
  );
}

describe('voice strategies', () => {
  it('resolves known ids and falls back to the per-platform default', () => {
    expect(resolveVoiceStrategy('cloud').id).toBe('cloud');
    expect(resolveVoiceStrategy('continuous').onDevice).toBe(true);
    expect(resolveVoiceStrategy('cloud').onDevice).toBe(false);
    expect(resolveVoiceStrategy(undefined).id).toBe(DEFAULT_VOICE_STRATEGY);
    expect(resolveVoiceStrategy('bogus').id).toBe(DEFAULT_VOICE_STRATEGY);
  });

  it('defaults per platform: iOS → continuous, Android → dictation', () => {
    expect(getDefaultVoiceStrategy('ios')).toBe('continuous');
    expect(getDefaultVoiceStrategy('android')).toBe('dictation');
  });

  it('no strategy label/description leaks a platform name (Apple compliance)', () => {
    // An Apple reviewer must never see "Android"/"Google Play" in the voice settings UI.
    for (const s of Object.values(VOICE_STRATEGIES)) {
      expect(`${s.label} ${s.description}`).not.toMatch(/android|google play|play store/i);
    }
  });

  it('store updates the strategy', () => {
    act(() => useVoiceSettingsStore.setState({ strategyId: 'dictation' }));
    expect(useVoiceSettingsStore.getState().strategyId).toBe('dictation');
    act(() => useVoiceSettingsStore.getState().setStrategyId('cloud'));
    expect(useVoiceSettingsStore.getState().strategyId).toBe('cloud');
  });
});

describe('resolveStartOptions (per-platform start payload)', () => {
  it('omits androidIntentOptions on iOS and maps the strategy flags', () => {
    const opts = resolveStartOptions(VOICE_STRATEGIES.continuous, ['Redis'], 'ios', 2500);
    expect(opts.continuous).toBe(true);
    expect(opts.requiresOnDeviceRecognition).toBe(true); // continuous is on-device
    expect(opts.contextualStrings).toEqual(['Redis']);
    expect(opts.androidIntentOptions).toBeUndefined();
    expect(opts.iosTaskHint).toBe('dictation');
    expect(opts.lang).toBe('en-US'); // English by default
  });

  it('passes the chosen language tag as lang (default en-US — English untouched)', () => {
    expect(resolveStartOptions(VOICE_STRATEGIES.dictation, [], 'ios', 2500).lang).toBe('en-US');
    expect(resolveStartOptions(VOICE_STRATEGIES.dictation, [], 'ios', 2500, 'pt-BR').lang).toBe(
      'pt-BR'
    );
  });

  it('includes the Android silence tuning on Android', () => {
    const opts = resolveStartOptions(VOICE_STRATEGIES.dictation, [], 'android', 2500);
    expect(opts.continuous).toBe(false);
    expect(opts.androidIntentOptions).toEqual({
      EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 2500,
      EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 2500,
    });
  });

  it('the cloud strategy is off-device', () => {
    const opts = resolveStartOptions(VOICE_STRATEGIES.cloud, [], 'ios', 2500);
    expect(opts.requiresOnDeviceRecognition).toBe(false);
    expect(opts.continuous).toBe(true);
  });
});

describe('voice languages', () => {
  it('defaults to English and resolves known/unknown/undefined tags', () => {
    expect(DEFAULT_VOICE_LANGUAGE).toBe('en-US');
    expect(VOICE_LANGUAGES.some((l) => l.tag === 'pt-BR')).toBe(true);
    expect(resolveVoiceLanguage('pt-BR')).toBe('pt-BR');
    expect(resolveVoiceLanguage('xx-YY')).toBe('en-US');
    expect(resolveVoiceLanguage(undefined)).toBe('en-US');
  });
});

describe('shouldAutoRestart (the iOS bug gate)', () => {
  const base = { manualStop: false, autoRestart: true, silentRestarts: 0, maxSilentRestarts: 8 };

  it('NEVER auto-restarts on iOS (the AVAudioSession-reactivation bug)', () => {
    expect(shouldAutoRestart({ ...base, platformOS: 'ios' })).toBe(false);
  });

  it('auto-restarts an Android dictation session under the silent cap', () => {
    expect(shouldAutoRestart({ ...base, platformOS: 'android' })).toBe(true);
  });

  it('stops on manual stop, non-restart strategies, and the silent cap (Android)', () => {
    expect(shouldAutoRestart({ ...base, platformOS: 'android', manualStop: true })).toBe(false);
    expect(shouldAutoRestart({ ...base, platformOS: 'android', autoRestart: false })).toBe(false);
    expect(shouldAutoRestart({ ...base, platformOS: 'android', silentRestarts: 8 })).toBe(false);
  });
});

describe('VoiceSettingsModal', () => {
  let gateway: MockGateway;
  let qc: QueryClient;
  let phrases: string[];

  beforeEach(() => {
    secureStore.clear();
    secureStore.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.set(AUTH_TOKEN_KEY, 'authtoken-abc');
    act(() => useVoiceSettingsStore.setState({ strategyId: 'dictation', languageTag: 'en-US' }));

    phrases = ['Redis', 'GraphQL'];
    gateway = createMockGateway();
    gateway.on('GET', `${SANDBOX_BASE}/api/voice/phrases`, () => ({
      body: { phrases, version: 1 },
    }));
    gateway.on('POST', `${SANDBOX_BASE}/api/voice/phrases`, (req) => {
      phrases = [...phrases, String((req.body as { phrase: string }).phrase)];
      return { body: { phrases, version: 2 } };
    });
    gateway.on('DELETE', `${SANDBOX_BASE}/api/voice/phrases`, (req) => {
      phrases = phrases.filter((p) => p !== (req.body as { phrase: string }).phrase);
      return { body: { phrases, version: 3 } };
    });

    qc = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    qc.clear();
    onlineManager.setOnline(true);
  });

  it('renders the strategies, selects one, lists phrases, adds + removes', async () => {
    render(
      <Providers gateway={gateway} qc={qc}>
        <VoiceSettingsModal visible onClose={() => {}} />
      </Providers>
    );

    // The three strategies render; selecting cloud updates the store.
    expect(screen.getByTestId('voice-strategy-dictation')).toBeTruthy();
    expect(screen.getByTestId('voice-strategy-continuous')).toBeTruthy();
    expect(screen.getByTestId('voice-strategy-cloud')).toBeTruthy();
    fireEvent.press(screen.getByTestId('voice-strategy-cloud'));
    expect(useVoiceSettingsStore.getState().strategyId).toBe('cloud');

    // Phrases load from the PC.
    await waitFor(() => expect(screen.getByTestId('voice-phrase-Redis')).toBeTruthy(), {
      timeout: 5000,
    });
    expect(screen.getByTestId('voice-phrase-GraphQL')).toBeTruthy();

    // Add a phrase → POST → it appears (cache busted). `fireEvent` flushes the input's
    // re-render so the Add button is enabled before the press.
    fireEvent.changeText(screen.getByTestId('voice-phrase-input'), 'Playwright');
    fireEvent.press(screen.getByTestId('voice-phrase-add'));
    await waitFor(() => expect(screen.getByTestId('voice-phrase-Playwright')).toBeTruthy(), {
      timeout: 5000,
    });
    const addReq = gateway.requests.find(
      (r) => r.method === 'POST' && r.url === `${SANDBOX_BASE}/api/voice/phrases`
    );
    expect((addReq!.body as { phrase: string }).phrase).toBe('Playwright');

    // Remove a phrase → DELETE → it disappears.
    fireEvent.press(screen.getByTestId('voice-phrase-remove-Redis'));
    await waitFor(() => expect(screen.queryByTestId('voice-phrase-Redis')).toBeNull(), {
      timeout: 5000,
    });
  }, 15000);

  it('language picker is collapsed (shows the selected language) and switches language', async () => {
    render(
      <Providers gateway={gateway} qc={qc}>
        <VoiceSettingsModal visible onClose={() => {}} />
      </Providers>
    );
    // Collapsed by default → shows English, the option list is hidden (compact).
    expect(screen.getByTestId('voice-language-current')).toHaveTextContent('English (US)');
    expect(screen.queryByTestId('voice-language-pt-BR')).toBeNull();
    expect(useVoiceSettingsStore.getState().languageTag).toBe('en-US'); // English default untouched

    // Expand → options appear → pick Português → store updates + collapses back.
    fireEvent.press(screen.getByTestId('voice-language-toggle'));
    expect(screen.getByTestId('voice-language-pt-BR')).toBeTruthy();
    fireEvent.press(screen.getByTestId('voice-language-pt-BR'));
    expect(useVoiceSettingsStore.getState().languageTag).toBe('pt-BR');
    expect(screen.queryByTestId('voice-language-pt-BR')).toBeNull(); // collapsed after pick
    expect(screen.getByTestId('voice-language-current')).toHaveTextContent('Português (Brasil)');

    // Flush the background phrases query so it doesn't leak an act() warning.
    await waitFor(() => expect(screen.getByTestId('voice-phrase-Redis')).toBeTruthy(), {
      timeout: 5000,
    });
  }, 15000);
});

describe('VoiceInput cog', () => {
  function makeFakeRecognizer() {
    const state = { callbacks: null as SpeechRecognizerCallbacks | null, abortCalls: 0 };
    const recognizer: NativeSpeechRecognizer = {
      requestPermission: async () => true,
      start: async (cb) => {
        state.callbacks = cb;
      },
      stop: async () => {},
      abort: async () => {
        state.abortCalls += 1;
      },
    };
    const useRecognizer = () => {
      const [level] = useState(0);
      return { recognizer, level };
    };
    return { useRecognizer, state };
  }

  it('the cog cancels the recording and opens the settings modal', async () => {
    const fake = makeFakeRecognizer();
    const gateway = createMockGateway();
    gateway.on('GET', `${SANDBOX_BASE}/api/voice/phrases`, () => ({
      body: { phrases: [], version: 1 },
    }));
    secureStore.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.set(AUTH_TOKEN_KEY, 'authtoken-abc');
    const qc = createQueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <Providers gateway={gateway} qc={qc}>
        <VoiceInput useRecognizer={fake.useRecognizer} onTranscription={() => {}} />
      </Providers>
    );

    // Start recording, then tap the cog.
    await act(async () => {
      fireEvent.press(screen.getByTestId('voice-input-mic'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('voice-input-settings')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('voice-input-settings'));
      await Promise.resolve();
    });

    expect(fake.state.abortCalls).toBe(1); // recording cancelled
    expect(screen.getByTestId('voice-settings-modal')).toBeTruthy(); // modal opened
    qc.clear();
    onlineManager.setOnline(true);
  });
});

describe('VoiceInput on-device fallback note', () => {
  function fallbackRecognizer(onDeviceFallback?: boolean) {
    const recognizer: NativeSpeechRecognizer = {
      requestPermission: async () => true,
      start: async () => {},
      stop: async () => {},
      abort: async () => {},
    };
    return () => ({ recognizer, level: 0, onDeviceFallback });
  }

  async function startRecording() {
    await act(async () => {
      fireEvent.press(screen.getByTestId('voice-input-mic'));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('warns that audio leaves the device when an on-device strategy fell back to cloud', async () => {
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <VoiceInput useRecognizer={fallbackRecognizer(true)} onTranscription={() => {}} />
      </SafeAreaProvider>
    );
    await startRecording();
    expect(screen.getByTestId('voice-cloud-fallback-note')).toBeTruthy();
  });

  it('shows no note when on-device recognition is available', async () => {
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <VoiceInput useRecognizer={fallbackRecognizer(false)} onTranscription={() => {}} />
      </SafeAreaProvider>
    );
    await startRecording();
    expect(screen.queryByTestId('voice-cloud-fallback-note')).toBeNull();
  });
});
