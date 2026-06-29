/**
 * Settings — Secrets section (`/settings/secrets`): full CRUD round-trip
 * against the mock gateway (web `SecretsSection` + `SecretsTable` parity).
 *
 *   1. list renders masked rows + source badges + relative times, sorted by
 *      updatedAt DESC; connection rows expose NO delete affordance;
 *   2. search narrows (key/displayName/description, case-insensitive) via the
 *      hidden `settings-secrets-count` testID;
 *   3. add: key auto-uppercases, empty form surfaces the web validation copy
 *      (no POST), submit POSTs `{ key, value, description }`;
 *   4. edit: row → view panel → edit form → PATCH
 *      `/api/user/secrets/${encodeURIComponent(key)}` body;
 *   5. delete: row ✕ → confirm card gates the DELETE (cancel sends nothing);
 *   6. connection-sourced view panel exposes NO edit affordance;
 *   7. empty / error (+retry) list states with the web copy.
 */

// ── Hoisted mocks (must precede the SUT import) ──────────────────────────────

// SecretsScreen → useAppTheme → themeStore → MMKV. In-memory mock (repo shape).
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

// The native NetInfo module must never load under Jest; ApiProvider gets an
// injected NetInfoLike below.
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { Secret } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { SecretsScreen } from '../src/features/settings/sections/secrets/SecretsScreen';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

const secureStore = (jest.requireMock('expo-secure-store') as { __store: Map<string, string> })
  .__store;

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const SANDBOX_BASE = 'https://sandbox.portable.test';
const SECRETS_URL = `${SANDBOX_BASE}/api/user/secrets`;

const NOW = 1_750_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MASKED = '••••••••';

/** Fixture: manual + connection + env_editor, distinct updatedAt for sorting. */
function makeSecrets(): Secret[] {
  return [
    {
      key: 'API_TOKEN',
      value: MASKED,
      description: 'Main API token',
      source: 'manual',
      createdAt: NOW - 10 * DAY,
      updatedAt: NOW - 2 * HOUR,
    },
    {
      key: 'SLACK_TOKEN',
      value: MASKED,
      source: 'connection',
      sourceConnectionId: 'conn-1',
      displayName: 'Slack Bot',
      createdAt: NOW - 5 * DAY,
      updatedAt: NOW - 1 * DAY,
    },
    {
      key: 'DB_URL',
      value: MASKED,
      description: 'Postgres connection string',
      source: 'env_editor',
      createdAt: NOW - 3 * DAY,
      updatedAt: NOW - 30_000,
    },
  ];
}

const inertNetInfo: NetInfoLike = { addEventListener: () => () => {} };

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

describe('settings — secrets section (full CRUD)', () => {
  let gateway: MockGateway;
  let serverSecrets: Secret[];
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    return activeQueryClient;
  }

  beforeEach(() => {
    secureStore.clear();
    secureStore.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.set(AUTH_TOKEN_KEY, 'good-token');
    serverSecrets = makeSecrets();
    gateway = createMockGateway();
    gateway.on('GET', SECRETS_URL, () => ({ body: { secrets: serverSecrets } }));
    gateway.on('POST', SECRETS_URL, (req) => {
      const body = req.body as { key: string; value: string; description?: string };
      const secret: Secret = {
        key: body.key,
        value: MASKED,
        description: body.description,
        source: 'manual',
        createdAt: NOW,
        updatedAt: NOW,
      };
      serverSecrets = [...serverSecrets, secret];
      return { body: { success: true, secret } };
    });
    gateway.on('PATCH', `${SECRETS_URL}/${encodeURIComponent('API_TOKEN')}`, () => ({
      body: { success: true },
    }));
    gateway.on('DELETE', `${SECRETS_URL}/${encodeURIComponent('API_TOKEN')}`, () => {
      serverSecrets = serverSecrets.filter((s) => s.key !== 'API_TOKEN');
      return { body: { success: true } };
    });
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  function mountScreen(): void {
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider
          client={buildClient(gateway)}
          queryClient={newQueryClient()}
          netInfo={inertNetInfo}
        >
          <SecretsScreen onBack={jest.fn()} deps={{ now: () => NOW }} />
        </ApiProvider>
      </SafeAreaProvider>
    );
  }

  async function mountAndAwaitList(expectedCount = '3'): Promise<void> {
    mountScreen();
    await waitFor(() => {
      expect(screen.getByTestId('settings-secrets-count')).toHaveTextContent(expectedCount);
    });
  }

  it('renders masked rows + source badges + relative times, sorted by updatedAt DESC', async () => {
    await mountAndAwaitList();

    // Masked values on every row.
    expect(screen.getByTestId('settings-secrets-row-API_TOKEN-value')).toHaveTextContent(MASKED);
    expect(screen.getByTestId('settings-secrets-row-DB_URL-value')).toHaveTextContent(MASKED);

    // Source badges (web: Manual / Env Editor / connection displayName).
    expect(screen.getByTestId('settings-secrets-row-API_TOKEN-source')).toHaveTextContent('Manual');
    expect(screen.getByTestId('settings-secrets-row-DB_URL-source')).toHaveTextContent(
      'Env Editor'
    );
    expect(screen.getByTestId('settings-secrets-row-SLACK_TOKEN-source')).toHaveTextContent(
      'Slack Bot'
    );

    // Relative times from the injected clock (web formatTime buckets).
    expect(screen.getByTestId('settings-secrets-row-API_TOKEN-time')).toHaveTextContent('2h ago');
    expect(screen.getByTestId('settings-secrets-row-DB_URL-time')).toHaveTextContent('just now');

    // updatedAt DESC: DB_URL (just now) → API_TOKEN (2h) → SLACK_TOKEN (1d).
    const sources = screen.getAllByTestId(/^settings-secrets-row-.+-source$/);
    expect(sources[0]).toHaveTextContent('Env Editor');
    expect(sources[1]).toHaveTextContent('Manual');
    expect(sources[2]).toHaveTextContent('Slack Bot');

    // Connection rows have NO delete affordance; manual rows do.
    expect(screen.queryByTestId('settings-secrets-row-SLACK_TOKEN-delete')).toBeNull();
    expect(screen.getByTestId('settings-secrets-row-API_TOKEN-delete')).toBeTruthy();
  });

  it('search narrows case-insensitively across key/displayName/description', async () => {
    await mountAndAwaitList();

    // displayName match ('Slack Bot') — also the key, deterministically 1 row.
    fireEvent.changeText(screen.getByTestId('settings-secrets-search'), 'slack');
    expect(screen.getByTestId('settings-secrets-count')).toHaveTextContent('1');
    expect(screen.getByTestId('settings-secrets-row-SLACK_TOKEN')).toBeTruthy();

    // description match.
    fireEvent.changeText(screen.getByTestId('settings-secrets-search'), 'postgres');
    expect(screen.getByTestId('settings-secrets-count')).toHaveTextContent('1');
    expect(screen.getByTestId('settings-secrets-row-DB_URL')).toBeTruthy();

    // cleared → all rows again.
    fireEvent.changeText(screen.getByTestId('settings-secrets-search'), '');
    expect(screen.getByTestId('settings-secrets-count')).toHaveTextContent('3');
  });

  it('add: validates empty form, uppercases the key, POSTs { key, value, description }', async () => {
    await mountAndAwaitList();

    fireEvent.press(screen.getByTestId('settings-secrets-add'));
    expect(screen.getByTestId('settings-secrets-add-form')).toBeTruthy();

    // Empty submit → the web validation copy, and NO request was sent.
    fireEvent.press(screen.getByTestId('settings-secrets-add-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('settings-secrets-error-banner')).toHaveTextContent(
        'Key and value are required'
      );
    });
    expect(gateway.requests.find((r) => r.method === 'POST')).toBeUndefined();

    // Key auto-uppercases (typed lowercase).
    fireEvent.changeText(screen.getByTestId('settings-secrets-add-key'), 'my_key');
    expect(screen.getByTestId('settings-secrets-add-key').props.value).toBe('MY_KEY');

    // Secure value with a show/hide toggle.
    const valueInput = screen.getByTestId('settings-secrets-add-value');
    expect(valueInput.props.secureTextEntry).toBe(true);
    fireEvent.press(screen.getByTestId('settings-secrets-add-value-toggle'));
    expect(screen.getByTestId('settings-secrets-add-value').props.secureTextEntry).toBe(false);
    fireEvent.changeText(screen.getByTestId('settings-secrets-add-value'), 'super-secret');

    // Description is collapsed behind the web's toggle.
    fireEvent.press(screen.getByTestId('settings-secrets-add-description-toggle'));
    fireEvent.changeText(screen.getByTestId('settings-secrets-add-description'), 'My description');

    fireEvent.press(screen.getByTestId('settings-secrets-add-submit'));

    await waitFor(() => {
      const post = gateway.requests.find(
        (r) => r.method === 'POST' && r.url.endsWith('/api/user/secrets')
      );
      expect(post).toBeTruthy();
      expect(post!.body).toEqual({
        key: 'MY_KEY',
        value: 'super-secret',
        description: 'My description',
      });
    });

    // Refetch + back to the list (the new row is server state, no optimism).
    await waitFor(() => {
      expect(screen.getByTestId('settings-secrets-count')).toHaveTextContent('4');
    });
    expect(screen.getByTestId('settings-secrets-row-MY_KEY')).toBeTruthy();
  });

  it('edit: view panel → edit form → PATCH /api/user/secrets/:key body', async () => {
    await mountAndAwaitList();

    fireEvent.press(screen.getByTestId('settings-secrets-row-API_TOKEN'));
    expect(screen.getByTestId('settings-secrets-view-key')).toHaveTextContent('API_TOKEN');
    expect(screen.getByTestId('settings-secrets-view-value')).toHaveTextContent(MASKED);
    expect(screen.getByTestId('settings-secrets-view-description')).toHaveTextContent(
      'Main API token'
    );
    expect(screen.getByTestId('settings-secrets-view-source')).toHaveTextContent(/Manual/);

    fireEvent.press(screen.getByTestId('settings-secrets-view-edit'));
    expect(screen.getByTestId('settings-secrets-edit')).toBeTruthy();
    // Description prefilled from the secret; value starts EMPTY and is REQUIRED
    // (the backend PATCH has no keep-current path — a blank value must never
    // produce a request, only the validation banner).
    expect(screen.getByTestId('settings-secrets-edit-description').props.value).toBe(
      'Main API token'
    );
    expect(screen.getByTestId('settings-secrets-edit-value').props.value).toBe('');
    fireEvent.press(screen.getByTestId('settings-secrets-edit-save'));
    expect(screen.getByTestId('settings-secrets-error-banner')).toHaveTextContent(
      'Enter a new value'
    );
    expect(gateway.requests.some((r) => r.method === 'PATCH')).toBe(false);

    fireEvent.changeText(screen.getByTestId('settings-secrets-edit-value'), 'fresh-value');
    fireEvent.changeText(screen.getByTestId('settings-secrets-edit-description'), 'rotated');
    fireEvent.press(screen.getByTestId('settings-secrets-edit-save'));

    await waitFor(() => {
      const patch = gateway.requests.find(
        (r) => r.method === 'PATCH' && r.url.endsWith(`/api/user/secrets/API_TOKEN`)
      );
      expect(patch).toBeTruthy();
      expect(patch!.body).toEqual({ value: 'fresh-value', description: 'rotated' });
    });

    // Returns to the list after the save.
    await waitFor(() => {
      expect(screen.queryByTestId('settings-secrets-edit')).toBeNull();
    });
    expect(screen.getByTestId('settings-secrets-search')).toBeTruthy();
  });

  it('delete: the confirm step gates the DELETE (cancel sends nothing)', async () => {
    await mountAndAwaitList();

    fireEvent.press(screen.getByTestId('settings-secrets-row-API_TOKEN-delete'));
    // Web confirm() copy, no request yet. (Regex: the card node also contains
    // the button labels — the documented RNTL adjacent-text gotcha.)
    expect(screen.getByTestId('settings-secrets-delete-confirm')).toHaveTextContent(
      /Delete secret "API_TOKEN"\?/
    );
    expect(gateway.requests.find((r) => r.method === 'DELETE')).toBeUndefined();

    // Cancel → confirm dismissed, still nothing sent.
    fireEvent.press(screen.getByTestId('settings-secrets-delete-cancel'));
    expect(screen.queryByTestId('settings-secrets-delete-confirm')).toBeNull();
    expect(gateway.requests.find((r) => r.method === 'DELETE')).toBeUndefined();

    // Re-request and confirm → DELETE to the encoded-key URL, list refreshes.
    fireEvent.press(screen.getByTestId('settings-secrets-row-API_TOKEN-delete'));
    fireEvent.press(screen.getByTestId('settings-secrets-delete-confirm-button'));

    await waitFor(() => {
      const del = gateway.requests.find(
        (r) => r.method === 'DELETE' && r.url.endsWith('/api/user/secrets/API_TOKEN')
      );
      expect(del).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByTestId('settings-secrets-count')).toHaveTextContent('2');
    });
    expect(screen.queryByTestId('settings-secrets-row-API_TOKEN')).toBeNull();
  });

  it('connection-sourced secret is read-only in the view panel (no edit affordance)', async () => {
    await mountAndAwaitList();

    fireEvent.press(screen.getByTestId('settings-secrets-row-SLACK_TOKEN'));
    expect(screen.getByTestId('settings-secrets-view-key')).toHaveTextContent('SLACK_TOKEN');
    expect(screen.getByTestId('settings-secrets-view-source')).toHaveTextContent(/Slack Bot/);
    expect(screen.queryByTestId('settings-secrets-view-edit')).toBeNull();

    fireEvent.press(screen.getByTestId('settings-secrets-view-close'));
    expect(screen.getByTestId('settings-secrets-search')).toBeTruthy();
  });

  it('shows the web empty-state copy when no secrets exist', async () => {
    serverSecrets = [];
    mountScreen();

    await waitFor(() => {
      expect(screen.getByTestId('settings-secrets-empty')).toHaveTextContent(
        'No secrets yet. Add your first secret to get started.'
      );
    });
  });

  it('shows the list error state with retry (web copy)', async () => {
    let failNext = true;
    gateway.on('GET', SECRETS_URL, () => {
      if (failNext) {
        failNext = false;
        return { status: 500, body: { error: 'boom' } };
      }
      return { body: { secrets: serverSecrets } };
    });
    mountScreen();

    await waitFor(() => {
      // Regex: the error node also contains the Retry button label.
      expect(screen.getByTestId('settings-secrets-error')).toHaveTextContent(
        /Failed to load secrets/
      );
    });

    fireEvent.press(screen.getByTestId('settings-secrets-error-retry'));
    await waitFor(() => {
      expect(screen.getByTestId('settings-secrets-count')).toHaveTextContent('3');
    });
  });
});
