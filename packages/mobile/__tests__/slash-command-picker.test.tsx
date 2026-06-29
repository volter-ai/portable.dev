/**
 * Slash-command / skills picker — the "enriched form for slash commands".
 *
 *   - SlashCommandPicker (presentational): groups + filters the available
 *     commands/skills, hides on no-match, surfaces loading, fires onSelect.
 *   - useChatCommands (hook): GETs /api/chats/:chatId/commands through the authed
 *     client and stays disabled until there's a chatId.
 */

// In-memory keychain (the only credential store) + the picker's useAppTheme→mmkv.
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    deleteItemAsync: jest.fn(async (k: string) => void store.delete(k)),
  };
});
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string) => store.set(k, String(v)),
    getString: (k: string) => (store.has(k) ? store.get(k) : undefined),
    remove: (k: string) => void store.delete(k),
    contains: (k: string) => store.has(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));
// ShortFormComposer (ghost-text test) always mounts the headless VoiceInput; keep the
// native speech module out of the graph.
jest.mock('expo-speech-recognition', () =>
  require('../src/test/nativeMocks').speechRecognitionMockFactory()
);

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react-native';
import { fireEvent } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { ReactElement } from 'react';

import type { SlashCommandInfo } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { useChatCommands, useRepoCommands } from '../src/features/api/hooks';
import { createQueryClient } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { ShortFormComposer, SlashCommandPicker } from '../src/features/chat/composer';
import { rankSlashCommands } from '../src/features/chat/composer/rankSlashCommands';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

const cmd = (
  name: string,
  kind: SlashCommandInfo['kind'],
  description?: string
): SlashCommandInfo => ({
  name,
  kind,
  scope: kind === 'builtin' ? 'builtin' : 'project',
  description,
});

const COMMANDS: SlashCommandInfo[] = [
  { name: 'pdf-tools', kind: 'skill', scope: 'project', description: 'Work with PDFs' },
  { name: 'aurora', kind: 'skill', scope: 'global', description: 'Global helper' },
  {
    name: 'deploy',
    kind: 'command',
    scope: 'project',
    description: 'Ship it',
    argumentHint: '[env] [tag]',
  },
  { name: 'compact', kind: 'builtin', scope: 'builtin' },
];

describe('rankSlashCommands (relevance ordering)', () => {
  it('ranks an exact name-prefix above skills that only match weaker fields (the /comp bug)', () => {
    const items = [
      // word-boundary prefix in the name + "comp" in the description — the kind that
      // used to be sorted ABOVE compact because skills rendered first.
      cmd('create-component', 'skill', 'Compose components'),
      cmd('compact', 'builtin', 'Summarize the conversation'), // name prefix
      cmd('compactify-images', 'skill'), // name prefix, longer name
    ];
    expect(rankSlashCommands('comp', items).map((c) => c.name)).toEqual([
      'compact',
      'compactify-images',
      'create-component',
    ]);
  });

  it('a name match always beats a description-only match', () => {
    const items = [
      cmd('notes', 'skill', 'deploy helper'), // description-only hit
      cmd('deploy', 'command', 'Ship it'), // name prefix
    ];
    expect(rankSlashCommands('deploy', items)[0].name).toBe('deploy');
  });

  it('prefers the shorter name on an equal-tier prefix match', () => {
    const items = [cmd('compactify', 'skill'), cmd('compact', 'builtin')];
    expect(rankSlashCommands('comp', items)[0].name).toBe('compact');
  });

  it('matches a subsequence when there is no contiguous hit', () => {
    // 'cpct' is a subsequence of compact, not of deploy.
    const items = [cmd('compact', 'builtin'), cmd('deploy', 'command')];
    expect(rankSlashCommands('cpct', items).map((c) => c.name)).toEqual(['compact']);
  });

  it('tolerates a transposition typo (damerau)', () => {
    const items = [cmd('compact', 'builtin'), cmd('deploy', 'command')];
    expect(rankSlashCommands('comapct', items)[0].name).toBe('compact');
  });

  it('returns the catalog unchanged for an empty query (browse mode)', () => {
    const items = [cmd('b-skill', 'skill'), cmd('a-cmd', 'command')];
    expect(rankSlashCommands('', items).map((c) => c.name)).toEqual(['b-skill', 'a-cmd']);
  });

  it('excludes non-matches', () => {
    const items = [cmd('compact', 'builtin'), cmd('deploy', 'command')];
    expect(rankSlashCommands('zzz-nope', items)).toEqual([]);
  });
});

describe('SlashCommandPicker (presentational)', () => {
  it('lists every command grouped, and selecting fires onSelect with the name', () => {
    const onSelect = jest.fn();
    render(<SlashCommandPicker commands={COMMANDS} query="" onSelect={onSelect} />);

    expect(screen.getByText('Skills')).toBeTruthy();
    expect(screen.getByText('Commands')).toBeTruthy();
    expect(screen.getByText('Built-in')).toBeTruthy();
    for (const c of COMMANDS) {
      expect(screen.getByTestId(`slash-command-option-${c.name}`)).toBeTruthy();
    }

    // The argument-hint renders greyed inline after the command name. (Regex — the node
    // text is "/deploy [env] [tag]Ship it"; a bare string is an exact match and `[...]`
    // are regex metachars, the documented RNTL toHaveTextContent gotcha.)
    expect(screen.getByTestId('slash-command-option-deploy')).toHaveTextContent(/\[env\] \[tag\]/);

    fireEvent.press(screen.getByTestId('slash-command-option-deploy'));
    expect(onSelect).toHaveBeenCalledWith('deploy');
  });

  it('filters live by the typed query (name or description)', () => {
    render(<SlashCommandPicker commands={COMMANDS} query="dep" onSelect={jest.fn()} />);
    expect(screen.getByTestId('slash-command-option-deploy')).toBeTruthy();
    expect(screen.queryByTestId('slash-command-option-pdf-tools')).toBeNull();
    expect(screen.queryByTestId('slash-command-option-compact')).toBeNull();
  });

  it('searches as a FLAT relevance-ranked list — a name-prefix beats weaker skill matches', () => {
    const items = [
      cmd('create-component', 'skill', 'Compose components'),
      cmd('compact', 'builtin', 'Summarize'),
    ];
    render(<SlashCommandPicker commands={items} query="comp" onSelect={jest.fn()} />);

    // Best match (the prefix hit) renders first, even though it's a built-in and the
    // other is a skill — relevance wins, not kind order.
    const options = screen.getAllByTestId(/^slash-command-option-/);
    expect(options[0].props.testID).toBe('slash-command-option-compact');

    // Flat mode: no section headers while searching.
    expect(screen.queryByText('Skills')).toBeNull();
    expect(screen.queryByText('Built-in')).toBeNull();
  });

  it('hides entirely when nothing matches (e.g. typing a file path)', () => {
    render(<SlashCommandPicker commands={COMMANDS} query="zzz-nope" onSelect={jest.fn()} />);
    expect(screen.queryByTestId('slash-command-picker')).toBeNull();
  });

  it('shows a loading hint while commands are still loading and none are cached', () => {
    render(<SlashCommandPicker commands={[]} query="" loading onSelect={jest.fn()} />);
    expect(screen.getByTestId('slash-command-picker-loading')).toBeTruthy();
  });

  it('renders a tap-outside backdrop that cancels only when onDismiss is provided', () => {
    const onDismiss = jest.fn();
    const { rerender } = render(
      <SlashCommandPicker commands={COMMANDS} query="" onSelect={jest.fn()} onDismiss={onDismiss} />
    );
    fireEvent.press(screen.getByTestId('slash-command-picker-backdrop'));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    // No onDismiss → no backdrop (the home/inline contexts that don't need one).
    rerender(<SlashCommandPicker commands={COMMANDS} query="" onSelect={jest.fn()} />);
    expect(screen.queryByTestId('slash-command-picker-backdrop')).toBeNull();
  });
});

describe('ShortFormComposer ghost text (argument-hint autofill)', () => {
  // ShortFormComposer always mounts the headless VoiceInput, which reaches useApi()
  // (voice phrases), so it must render under an ApiProvider.
  const secureStore = (jest.requireMock('expo-secure-store') as { __store: Map<string, string> })
    .__store;
  let activeQueryClient: QueryClient | undefined;

  const baseProps = {
    onChangeText: () => {},
    onSubmit: () => {},
    canSend: false,
    placeholder: 'Message…',
    inputTestID: 'sf-input',
    sendTestID: 'sf-send',
    voiceTestID: 'sf-voice',
  };

  beforeEach(() => {
    secureStore.clear();
    secureStore.set(AUTH_TOKEN_KEY, 'token-abc');
    secureStore.set(RELAY_URL_KEY, 'https://sandbox.portable.test');
  });

  afterEach(() => {
    activeQueryClient?.clear();
    onlineManager.setOnline(true);
  });

  function mount(node: ReactElement) {
    const gateway = createMockGateway();
    const gwClient = new GatewayClient({
      gatewayUrl: gateway.baseUrl,
      fetchImpl: gateway.fetchImpl,
    });
    const client = new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
    const qc = createQueryClient();
    activeQueryClient = qc;
    return render(
      <ApiProvider client={client} queryClient={qc} netInfo={{ addEventListener: () => () => {} }}>
        {node}
      </ApiProvider>
    );
  }

  it('renders the grey hint inline after the typed value when ghostText is set', () => {
    mount(<ShortFormComposer {...baseProps} value="/deploy " ghostText=" [env] [tag]" />);
    // The hint is positioned AFTER the typed value via an off-screen measurer (the value
    // itself lives in the measurer + the field, not the visible hint — avoids the Android
    // zero-alpha double-print). jest runs no native layout, so drive the measurer's
    // onLayout to reveal the positioned hint, mirroring the first on-device layout pass.
    const measurer = screen.getByTestId('sf-input-ghost-measure');
    expect(measurer).toHaveTextContent(/\/deploy/);
    fireEvent(measurer, 'layout', {
      nativeEvent: { layout: { width: 48, height: 18, x: 0, y: 0 } },
    });
    const ghost = screen.getByTestId('sf-input-ghost');
    expect(ghost).toHaveTextContent(/\[env\] \[tag\]/);
  });

  it('renders no ghost overlay when ghostText is empty/undefined', () => {
    mount(<ShortFormComposer {...baseProps} value="hello" />);
    expect(screen.queryByTestId('sf-input-ghost')).toBeNull();
  });
});

describe('useChatCommands (hook)', () => {
  const SANDBOX_BASE = 'https://sandbox.portable.test';
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;
  const secureStore = (jest.requireMock('expo-secure-store') as { __store: Map<string, string> })
    .__store;

  function buildClient(gw: MockGateway): RelayApiClient {
    const gwClient = new GatewayClient({ gatewayUrl: gw.baseUrl, fetchImpl: gw.fetchImpl });
    return new RelayApiClient({ gateway: gwClient, fetchImpl: gw.fetchImpl });
  }

  function Probe({ chatId }: { chatId?: string }) {
    const q = useChatCommands(chatId);
    const label = q.data
      ? q.data.commands.map((c) => c.name).join(',')
      : q.isLoading
        ? 'loading'
        : 'idle';
    return <Text testID="result">{label}</Text>;
  }

  beforeEach(() => {
    secureStore.clear();
    secureStore.set(AUTH_TOKEN_KEY, 'token-abc');
    secureStore.set(RELAY_URL_KEY, SANDBOX_BASE);
    gateway = createMockGateway();
  });

  afterEach(() => {
    activeQueryClient?.clear();
    onlineManager.setOnline(true);
  });

  function mount(chatId?: string) {
    const qc = createQueryClient();
    activeQueryClient = qc;
    return render(
      <ApiProvider
        client={buildClient(gateway)}
        queryClient={qc}
        netInfo={{ addEventListener: () => () => {} }}
      >
        <Probe chatId={chatId} />
      </ApiProvider>
    );
  }

  it('GETs /api/chats/:chatId/commands and surfaces the commands', async () => {
    gateway.on('GET', `${SANDBOX_BASE}/api/chats/chat-1/commands`, () => ({
      body: { commands: COMMANDS },
    }));
    mount('chat-1');
    await waitFor(() =>
      expect(screen.getByTestId('result').props.children).toBe('pdf-tools,aurora,deploy,compact')
    );
    expect(gateway.requests.some((r) => r.url.endsWith('/api/chats/chat-1/commands'))).toBe(true);
  });

  it('stays disabled (no request) until there is a chatId', async () => {
    mount(undefined);
    await waitFor(() => expect(screen.getByTestId('result').props.children).toBe('idle'));
    expect(gateway.requests.some((r) => r.url.includes('/commands'))).toBe(false);
  });

  it('useRepoCommands GETs the repo-scoped endpoint', async () => {
    gateway.on('GET', `${SANDBOX_BASE}/api/repos/acme/widget/commands`, () => ({
      body: { commands: COMMANDS },
    }));
    function RepoProbe() {
      const q = useRepoCommands('acme', 'widget');
      return (
        <Text testID="result">
          {q.data ? q.data.commands.map((c) => c.name).join(',') : 'idle'}
        </Text>
      );
    }
    const qc = createQueryClient();
    activeQueryClient = qc;
    render(
      <ApiProvider
        client={buildClient(gateway)}
        queryClient={qc}
        netInfo={{ addEventListener: () => () => {} }}
      >
        <RepoProbe />
      </ApiProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId('result').props.children).toBe('pdf-tools,aurora,deploy,compact')
    );
    expect(gateway.requests.some((r) => r.url.endsWith('/api/repos/acme/widget/commands'))).toBe(
      true
    );
  });
});
