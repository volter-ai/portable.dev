/**
 * FollowUpComposer — per-chat Effort selector (issue: per-chat /effort control).
 *
 * Verifies the Effort control mirrors the existing Model/Permissions pattern:
 *   - hidden entirely when the chat's current model doesn't support effort (Haiku),
 *     rather than shown disabled;
 *   - only offers the levels the current model actually supports (Sonnet has no
 *     X-High);
 *   - selecting a level calls `onUpdateSettings({ effort })` (the same PATCH-backed
 *     `useChatSettings.update` path Model/Permissions already use) — no live
 *     session interrupt.
 */

// react-native-mmkv backs the theme store; useAppTheme (pulled in by FollowUpComposer)
// requires this mock even though this test never reads/writes it directly.
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string) => store.set(k, v),
    getString: (k: string) => store.get(k) ?? undefined,
    remove: (k: string) => store.delete(k),
    contains: (k: string) => store.has(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { FollowUpComposer } from '../src/features/chat/FollowUpComposer';
import type { ChatSettings } from '../src/features/state';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

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

async function renderComposer(settings: Required<ChatSettings>, onUpdateSettings: jest.Mock) {
  const gateway = createMockGateway();
  gateway.on('GET', `${SANDBOX_BASE}/api/agent-setups`, () => ({
    body: { agentSetups: [{ id: 'freestyle', name: 'Freestyle' }] },
  }));
  gateway.on('GET', `${SANDBOX_BASE}/api/chats/chat-1/commands`, () => ({
    body: { commands: [] },
  }));

  const qc = createQueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <ApiProvider client={buildClient(gateway)} queryClient={qc} netInfo={onlineNetInfo}>
        <FollowUpComposer
          chatId="chat-1"
          settings={settings}
          onUpdateSettings={onUpdateSettings}
          onSend={jest.fn()}
        />
      </ApiProvider>
    </SafeAreaProvider>
  );

  // Expand the card so the control row (model/permissions/effort/agent) renders.
  await act(async () => {
    fireEvent(screen.getByTestId('active-chat-composer-input'), 'focus');
    await Promise.resolve();
  });
}

describe('FollowUpComposer — Effort control', () => {
  it('shows the Effort control with all 5 levels for a model that supports the full range (opus)', async () => {
    const onUpdateSettings = jest.fn();
    await renderComposer(
      {
        model: 'opus',
        permissions: 'bypass_permissions',
        agentSetupId: 'freestyle',
        effort: 'high',
      },
      onUpdateSettings
    );

    fireEvent.press(screen.getByTestId('open-effort-sheet'));
    expect(screen.getByTestId('effort-sheet')).toBeTruthy();
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(screen.getByTestId(`effort-option-${level}`)).toBeTruthy();
    }

    fireEvent.press(screen.getByTestId('effort-option-xhigh'));
    expect(onUpdateSettings).toHaveBeenCalledWith({ effort: 'xhigh' });
  });

  it('omits X-High for Sonnet (not in its supported range)', async () => {
    const onUpdateSettings = jest.fn();
    await renderComposer(
      {
        model: 'sonnet',
        permissions: 'bypass_permissions',
        agentSetupId: 'freestyle',
        effort: 'high',
      },
      onUpdateSettings
    );

    fireEvent.press(screen.getByTestId('open-effort-sheet'));
    for (const level of ['low', 'medium', 'high', 'max']) {
      expect(screen.getByTestId(`effort-option-${level}`)).toBeTruthy();
    }
    expect(screen.queryByTestId('effort-option-xhigh')).toBeNull();
  });

  it('hides the Effort control entirely for Haiku (no effort support)', async () => {
    const onUpdateSettings = jest.fn();
    await renderComposer(
      {
        model: 'haiku',
        permissions: 'bypass_permissions',
        agentSetupId: 'freestyle',
        effort: 'high',
      },
      onUpdateSettings
    );

    expect(screen.queryByTestId('open-effort-sheet')).toBeNull();
  });
});
