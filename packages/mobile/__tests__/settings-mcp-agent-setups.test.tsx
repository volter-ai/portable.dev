/**
 * Settings sections — MCP Servers (`/settings/mcp`) + Agent Setups
 * (`/settings/agent-setups`), the read-only ports of the web
 * `McpServersSection` / `AgentSetupsSection`.
 *
 * Mounts each screen under SafeAreaProvider + ApiProvider (the chat-chrome
 * pattern) with `createMockGateway` registering the sandbox endpoints by FULL
 * URL, and asserts:
 *   1. MCP: loading → content; status badges with the EXACT web labels
 *      ('Available' / 'Configuration Required' / 'Disabled'), the requirements
 *      line (`Missing: …`, only for missing_token + non-empty requirements),
 *      exact category labels, and the conditional tool-count badge
 *      (singular/plural copy; absent when toolCount is missing);
 *   2. MCP icon resolution priority (pure helpers): emoji → custom URL →
 *      favicon → letter fallback, plus the rendered variants per card;
 *   3. Agent Setups: loading → content; the DERIVED orchestration labels
 *      ('Delegation-Based' needs subAgents AND preferDelegation; never from
 *      the API), sub-agent chips, and dicebear avatars seeded by setup.id /
 *      subAgent.type;
 *   4. the error state when each endpoint 500s.
 */

// ── Hoisted mocks (must precede the SUT imports) ─────────────────────────────

// useAppTheme → themeStore → MMKV: mock the native nitro module (in-memory).
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string | number | boolean) => store.set(k, String(v)),
    getString: (k: string) => store.get(k),
    remove: (k: string) => store.delete(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

// In-memory keychain (the authed sandbox client reads token + sandbox URL).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    getItemAsync: async (k: string) => (store.has(k) ? store.get(k)! : null),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});

// The native NetInfo module must never load under Jest; connectivity is injected.
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { AgentSetup } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { AgentSetupsScreen } from '../src/features/settings/sections/agent-setups/AgentSetupsScreen';
import { getOrchestrationLabel } from '../src/features/settings/sections/agent-setups/agentSetupHelpers';
import { McpServersScreen } from '../src/features/settings/sections/mcp/McpServersScreen';
import {
  getFaviconUrl,
  getMcpCategoryLabel,
  resolveMcpIconSource,
  type McpStatus,
} from '../src/features/settings/sections/mcp/mcpHelpers';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

const secureStore = (jest.requireMock('expo-secure-store') as { __store: Map<string, string> })
  .__store;

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const SANDBOX_BASE = 'https://sandbox.portable.test';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MCPS: McpStatus[] = [
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Browser automation for testing flows.',
    type: 'external',
    enabled: true,
    toolCount: 5,
    requirements: [],
    status: 'available',
    icon: '🎭',
    category: 'automation',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'GitHub repository operations.',
    type: 'external',
    enabled: true,
    websiteUrl: 'https://github.com',
    requirements: ['GITHUB_TOKEN', 'GITHUB_ORG'],
    status: 'missing_token',
    category: 'development',
  },
  {
    id: 'custom-thing',
    name: 'Custom Thing',
    description: 'A custom in-house MCP.',
    type: 'custom',
    enabled: false,
    toolCount: 1,
    requirements: [],
    status: 'disabled',
    // No category → 'Other'; no icon/websiteUrl → letter fallback.
  },
];

const DELEGATION_SETUP: AgentSetup = {
  id: 'delegation-setup',
  name: 'Best Practice',
  description: 'Delegates work to specialised sub-agents.',
  systemPromptTemplate: '',
  subAgents: [
    {
      type: 'planner',
      name: 'Planner',
      description: 'Plans tasks',
      prompt: '',
      tools: [],
      model: 'inherit',
      colorTheme: '#1f6feb',
    },
    {
      type: 'coder',
      name: 'Coder',
      description: 'Writes code',
      prompt: '',
      tools: [],
      model: 'inherit',
    },
  ],
  mcpServers: ['playwright'],
  behavior: {
    useWorkflowManagement: true,
    preferDelegation: true,
    parallelExecution: true,
    planBeforeExecuting: true,
  },
  colorTheme: '#8957e5',
};

const DIRECT_SETUP: AgentSetup = {
  id: 'direct-setup',
  name: 'Freestyle',
  description: 'Executes everything directly.',
  systemPromptTemplate: '',
  // preferDelegation true but NO sub-agents → still 'Direct Execution'
  // (the derivation is an AND, web parity).
  subAgents: [],
  mcpServers: [],
  behavior: {
    useWorkflowManagement: false,
    preferDelegation: true,
    parallelExecution: false,
    planBeforeExecuting: false,
  },
};

// ── Harness ──────────────────────────────────────────────────────────────────

const inertNetInfo: NetInfoLike = { addEventListener: () => () => {} };

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

describe('settings — MCP Servers + Agent Setups sections', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function mount(element: React.JSX.Element): void {
    activeQueryClient = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider
          client={buildClient(gateway)}
          queryClient={activeQueryClient}
          netInfo={inertNetInfo}
        >
          {element}
        </ApiProvider>
      </SafeAreaProvider>
    );
  }

  beforeEach(() => {
    secureStore.clear();
    secureStore.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.set(AUTH_TOKEN_KEY, 'good-token');
    gateway = createMockGateway();
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  // ── MCP Servers ────────────────────────────────────────────────────────────

  describe('McpServersScreen', () => {
    beforeEach(() => {
      gateway.on('GET', `${SANDBOX_BASE}/api/mcps/available`, () => ({ body: { mcps: MCPS } }));
    });

    it('transitions loading → cards and renders the exact status labels + requirements', async () => {
      mount(<McpServersScreen />);

      // Loading state first (query in flight).
      expect(screen.getByTestId('settings-mcp-loading')).toBeTruthy();
      expect(screen.queryByTestId('settings-mcp-card-playwright')).toBeNull();

      await waitFor(() => {
        expect(screen.getByTestId('settings-mcp-card-playwright')).toBeTruthy();
      });
      expect(screen.queryByTestId('settings-mcp-loading')).toBeNull();

      // Exact web status labels.
      expect(screen.getByTestId('settings-mcp-status-playwright')).toHaveTextContent('✓ Available');
      expect(screen.getByTestId('settings-mcp-status-github')).toHaveTextContent(
        '⚠️ Configuration Required'
      );
      expect(screen.getByTestId('settings-mcp-status-custom-thing')).toHaveTextContent(
        '○ Disabled'
      );

      // Names + descriptions.
      expect(screen.getByTestId('settings-mcp-name-github')).toHaveTextContent('GitHub');
      expect(screen.getByTestId('settings-mcp-description-playwright')).toHaveTextContent(
        'Browser automation for testing flows.'
      );

      // Requirements line: exact copy, ONLY on the missing_token card.
      expect(screen.getByTestId('settings-mcp-requirements-github')).toHaveTextContent(
        'Missing: GITHUB_TOKEN, GITHUB_ORG'
      );
      expect(screen.queryByTestId('settings-mcp-requirements-playwright')).toBeNull();
      expect(screen.queryByTestId('settings-mcp-requirements-custom-thing')).toBeNull();
    });

    it('renders exact category labels and the conditional tool-count badge (singular/plural)', async () => {
      mount(<McpServersScreen />);
      await waitFor(() => {
        expect(screen.getByTestId('settings-mcp-card-playwright')).toBeTruthy();
      });

      // Exact category labels ('Other' for a missing category).
      expect(screen.getByTestId('settings-mcp-category-playwright')).toHaveTextContent(
        'Automation'
      );
      expect(screen.getByTestId('settings-mcp-category-github')).toHaveTextContent('Development');
      expect(screen.getByTestId('settings-mcp-category-custom-thing')).toHaveTextContent('Other');

      // Tool-count badge: plural, singular, and ABSENT when toolCount is missing.
      expect(screen.getByTestId('settings-mcp-tools-playwright')).toHaveTextContent('5 tools');
      expect(screen.getByTestId('settings-mcp-tools-custom-thing')).toHaveTextContent('1 tool');
      expect(screen.queryByTestId('settings-mcp-tools-github')).toBeNull();
    });

    it('renders the icon per the web priority: emoji → favicon image → letter fallback', async () => {
      mount(<McpServersScreen />);
      await waitFor(() => {
        expect(screen.getByTestId('settings-mcp-card-playwright')).toBeTruthy();
      });

      // Emoji icon renders as a Text glyph.
      expect(screen.getByTestId('settings-mcp-icon-playwright-emoji')).toHaveTextContent('🎭');
      expect(screen.queryByTestId('settings-mcp-icon-playwright-image')).toBeNull();

      // websiteUrl → google s2 favicon Image.
      const favicon = screen.getByTestId('settings-mcp-icon-github-image');
      expect((favicon.props as { source: { uri: string } }).source.uri).toBe(
        'https://www.google.com/s2/favicons?domain=github.com&sz=64'
      );

      // No icon / websiteUrl → uppercased first-letter fallback.
      expect(screen.getByTestId('settings-mcp-icon-custom-thing-fallback')).toHaveTextContent('C');
    });

    it('shows the error state (with the web copy prefix) when the endpoint 500s', async () => {
      gateway.on('GET', `${SANDBOX_BASE}/api/mcps/available`, () => ({
        status: 500,
        body: { error: 'boom' },
      }));
      mount(<McpServersScreen />);

      await waitFor(() => {
        expect(screen.getByTestId('settings-mcp-error')).toBeTruthy();
      });
      expect(screen.getByTestId('settings-mcp-error')).toHaveTextContent(/Error loading MCPs:/);
      expect(screen.getByTestId('settings-mcp-error-retry')).toBeTruthy();
      expect(screen.queryByTestId('settings-mcp-card-playwright')).toBeNull();
    });
  });

  // ── MCP helpers (pure) ─────────────────────────────────────────────────────

  describe('mcpHelpers — icon resolution priority + category labels', () => {
    it('resolves emoji ahead of custom URL ahead of favicon ahead of fallback', () => {
      // 1. Emoji wins even when a websiteUrl exists.
      expect(resolveMcpIconSource({ name: 'A', icon: '🎭', websiteUrl: 'https://a.dev' })).toEqual({
        kind: 'emoji',
        emoji: '🎭',
      });

      // 2. 'fa:' icons are unimplemented (web parity) → fall through to favicon.
      expect(
        resolveMcpIconSource({ name: 'B', icon: 'fa:rocket', websiteUrl: 'https://b.dev' })
      ).toEqual({ kind: 'image', uri: 'https://www.google.com/s2/favicons?domain=b.dev&sz=64' });

      // 3. Custom http(s) icon URL wins over the favicon.
      expect(
        resolveMcpIconSource({
          name: 'C',
          icon: 'https://cdn.example.com/icon2.png',
          websiteUrl: 'https://c.dev',
        })
      ).toEqual({ kind: 'image', uri: 'https://cdn.example.com/icon2.png' });

      // 4. No icon → favicon from websiteUrl.
      expect(resolveMcpIconSource({ name: 'D', websiteUrl: 'https://d.dev' })).toEqual({
        kind: 'image',
        uri: 'https://www.google.com/s2/favicons?domain=d.dev&sz=64',
      });

      // 5. Nothing → uppercased first letter.
      expect(resolveMcpIconSource({ name: 'thing' })).toEqual({ kind: 'fallback', letter: 'T' });
    });

    it('builds the google s2 favicon URL and falls back on an invalid websiteUrl', () => {
      expect(getFaviconUrl('https://playwright.dev', 64)).toBe(
        'https://www.google.com/s2/favicons?domain=playwright.dev&sz=64'
      );
      expect(getFaviconUrl('not a url')).toBe('');
      // Invalid websiteUrl cascades to the letter fallback.
      expect(resolveMcpIconSource({ name: 'x', websiteUrl: 'not a url' })).toEqual({
        kind: 'fallback',
        letter: 'X',
      });
    });

    it('maps categories to the exact labels with the Other fallback', () => {
      expect(getMcpCategoryLabel({ category: 'automation' })).toBe('Automation');
      expect(getMcpCategoryLabel({ category: 'development' })).toBe('Development');
      expect(getMcpCategoryLabel({ category: 'productivity' })).toBe('Productivity');
      expect(getMcpCategoryLabel({ category: 'platform' })).toBe('Platform');
      expect(getMcpCategoryLabel({ category: 'media' })).toBe('Media');
      expect(getMcpCategoryLabel({ category: undefined })).toBe('Other');
    });
  });

  // ── Agent Setups ───────────────────────────────────────────────────────────

  describe('AgentSetupsScreen', () => {
    beforeEach(() => {
      gateway.on('GET', `${SANDBOX_BASE}/api/agent-setups`, () => ({
        body: { agentSetups: [DELEGATION_SETUP, DIRECT_SETUP] },
      }));
    });

    it('transitions loading → cards and renders the DERIVED orchestration labels', async () => {
      mount(<AgentSetupsScreen />);

      expect(screen.getByTestId('settings-agent-setups-loading')).toBeTruthy();
      expect(screen.queryByTestId('settings-agent-setups-card-delegation-setup')).toBeNull();

      await waitFor(() => {
        expect(screen.getByTestId('settings-agent-setups-card-delegation-setup')).toBeTruthy();
      });
      expect(screen.queryByTestId('settings-agent-setups-loading')).toBeNull();

      expect(screen.getByTestId('settings-agent-setups-name-delegation-setup')).toHaveTextContent(
        'Best Practice'
      );
      expect(
        screen.getByTestId('settings-agent-setups-description-direct-setup')
      ).toHaveTextContent('Executes everything directly.');

      // Derived: subAgents.length > 0 AND preferDelegation → 'Delegation-Based';
      // preferDelegation alone (no sub-agents) → 'Direct Execution'.
      expect(
        screen.getByTestId('settings-agent-setups-orchestration-delegation-setup')
      ).toHaveTextContent('Delegation-Based');
      expect(
        screen.getByTestId('settings-agent-setups-orchestration-direct-setup')
      ).toHaveTextContent('Direct Execution');
    });

    it('renders the sub-agent chips and dicebear avatars seeded by setup.id / subAgent.type', async () => {
      mount(<AgentSetupsScreen />);
      await waitFor(() => {
        expect(screen.getByTestId('settings-agent-setups-card-delegation-setup')).toBeTruthy();
      });

      // Both sub-agent chips, by name; none on the direct setup. (Regex —
      // the chip node concatenates the avatar initial + name, the documented
      // RNTL adjacent-Text gotcha.)
      expect(
        screen.getByTestId('settings-agent-setups-subagent-delegation-setup-planner')
      ).toHaveTextContent(/Planner/);
      expect(
        screen.getByTestId('settings-agent-setups-subagent-delegation-setup-coder')
      ).toHaveTextContent(/Coder/);
      expect(
        screen.queryByTestId('settings-agent-setups-subagent-direct-setup-planner')
      ).toBeNull();

      // Setup avatar seeded by setup.id.
      const setupAvatar = screen.getByTestId('settings-agent-setups-avatar-image-delegation-setup');
      expect((setupAvatar.props as { source: { uri: string } }).source.uri).toBe(
        'https://api.dicebear.com/7.x/notionists/png?seed=delegation-setup'
      );

      // Sub-agent avatar seeded by subAgent.type (NOT an id).
      const subAvatar = screen.getByTestId(
        'settings-agent-setups-subagent-avatar-image-delegation-setup-planner'
      );
      expect((subAvatar.props as { source: { uri: string } }).source.uri).toBe(
        'https://api.dicebear.com/7.x/notionists/png?seed=planner'
      );
    });

    it('shows the error state (with the web copy prefix) when the endpoint 500s', async () => {
      gateway.on('GET', `${SANDBOX_BASE}/api/agent-setups`, () => ({
        status: 500,
        body: { error: 'boom' },
      }));
      mount(<AgentSetupsScreen />);

      await waitFor(() => {
        expect(screen.getByTestId('settings-agent-setups-error')).toBeTruthy();
      });
      expect(screen.getByTestId('settings-agent-setups-error')).toHaveTextContent(
        /Error loading agent setups:/
      );
      expect(screen.getByTestId('settings-agent-setups-error-retry')).toBeTruthy();
      expect(screen.queryByTestId('settings-agent-setups-card-delegation-setup')).toBeNull();
    });
  });

  // ── Agent-setup helpers (pure) ─────────────────────────────────────────────

  describe('agentSetupHelpers — orchestration derivation', () => {
    it('requires BOTH sub-agents and preferDelegation for Delegation-Based', () => {
      expect(getOrchestrationLabel(DELEGATION_SETUP)).toBe('Delegation-Based');
      expect(getOrchestrationLabel(DIRECT_SETUP)).toBe('Direct Execution');
      // Sub-agents WITHOUT preferDelegation is also direct.
      expect(
        getOrchestrationLabel({
          subAgents: DELEGATION_SETUP.subAgents,
          behavior: { ...DELEGATION_SETUP.behavior, preferDelegation: false },
        })
      ).toBe('Direct Execution');
    });
  });
});
