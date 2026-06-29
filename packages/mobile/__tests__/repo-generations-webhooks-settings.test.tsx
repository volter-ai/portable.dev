/**
 * Generations & Settings (RepoPage tabs).
 *
 * Drives the Generations and Settings tabs through the authed TanStack Query layer
 * with a mocked sandbox HTTP layer (`createMockGateway`), an in-memory SecureStore
 * (sandbox URL + authToken), and an in-memory MMKV. Verifies:
 *
 *   1. the Generations tab lists AI generations;
 *   2. the Settings tab renders repo details + collaborators (read-only parity).
 *
 * (The Webhooks tab + external-webhooks feature were removed.)
 */

// In-memory keychain for expo-secure-store (sandbox URL + authToken live here).
jest.mock('expo-secure-store', () => {
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
});

// react-native-mmkv backs the chat-store (transitively imported by the screen).
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

// The native NetInfo module must never load under Jest.
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

// The Overview tab (transitively imported by the screen) renders Markdown.
jest.mock('react-native-markdown-display', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children: string }) => <Text>{children}</Text>,
  };
});

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { Generation } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { RepoPageScreen } from '../src/features/repo';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

interface SecureStoreMock {
  __store: Map<string, string>;
}
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

const SANDBOX_BASE = 'https://sandbox.portable.test';
const OWNER = 'octocat';
const REPO = 'hello-world';

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const onlineNetInfo: NetInfoLike = { addEventListener: () => () => {} };

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

function generationsUrl(page = 1): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/generations?page=${page}&per_page=30`;
}
function repoUrl(): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}`;
}
function collaboratorsUrl(): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/collaborators`;
}

function makeGeneration(id: string, name: string, type: 'image' | 'video'): Generation {
  return {
    id,
    timestamp: '2026-05-01T10:00:00Z',
    name,
    version: 'initial',
    iteration: 0,
    type,
    model: type === 'video' ? 'veo-3' : 'flux-pro',
    input: {},
    output: { url: `https://cdn.test/${id}.png` },
    userId: 'user-1',
  };
}

describe('Generations & Settings', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return activeQueryClient;
  }

  function mount(qc: QueryClient, tab: 'generations' | 'settings') {
    const client = buildClient(gateway);
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={qc} netInfo={onlineNetInfo}>
          <RepoPageScreen owner={OWNER} repo={REPO} tab={tab} navigate={() => {}} />
        </ApiProvider>
      </SafeAreaProvider>
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    secureStore.__store.clear();
    secureStore.__store.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.__store.set(AUTH_TOKEN_KEY, 'good-token');
    gateway = createMockGateway();
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  it('Generations tab lists AI generations', async () => {
    gateway.on('GET', generationsUrl(), () => ({
      body: {
        generations: [
          makeGeneration('g1', 'logo', 'image'),
          makeGeneration('g2', 'intro', 'video'),
        ],
        total_count: 2,
        has_more_pages: false,
      },
    }));

    mount(newQueryClient(), 'generations');

    await waitFor(() => expect(screen.getByTestId('repo-generation-g1')).toBeTruthy());
    expect(screen.getByTestId('repo-generation-g2')).toBeTruthy();
    expect(screen.getByTestId('repo-generations-count').props.children).toBe(2);
  });

  it('Settings tab renders repo details + collaborators', async () => {
    gateway.on('GET', repoUrl(), () => ({
      body: {
        name: REPO,
        full_name: `${OWNER}/${REPO}`,
        description: 'My first repo',
        private: false,
        language: 'TypeScript',
        default_branch: 'main',
        visibility: 'public',
        stargazers_count: 42,
        forks_count: 7,
        open_issues_count: 3,
        html_url: `https://github.com/${OWNER}/${REPO}`,
        isLocal: false,
      },
    }));
    gateway.on('GET', collaboratorsUrl(), () => ({
      body: { team_members: [{ name: 'Octo Cat', username: 'octocat' }] },
    }));

    mount(newQueryClient(), 'settings');

    await waitFor(() => expect(screen.getByTestId('repo-settings')).toBeTruthy());
    expect(screen.getByTestId('repo-settings-description')).toHaveTextContent(/My first repo/);
    expect(screen.getByTestId('repo-settings-default-branch')).toHaveTextContent(/main/);
    expect(screen.getByTestId('repo-settings-language')).toHaveTextContent(/TypeScript/);

    // Collaborators load (separate query).
    await waitFor(() =>
      expect(screen.getByTestId('repo-settings-collaborator-octocat')).toBeTruthy()
    );
    expect(screen.getByTestId('repo-settings-collaborators-count').props.children).toBe(1);
  });
});
