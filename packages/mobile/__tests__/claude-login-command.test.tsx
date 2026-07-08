/**
 * `/login` client command + dead-credential CTA (portable.dev#18).
 *
 *   1. `isLoginCommand` recognizes exactly `/login` (case-insensitive, no args);
 *   2. FollowUpComposer: sending `/login` navigates to Settings → Claude Account
 *      instead of calling `onSend`;
 *   3. the slash picker lists the client `login` entry and selecting it navigates
 *      immediately (no text inserted, nothing sent);
 *   4. ErrorBlock: `code === 'ai_credential_invalid'` renders the
 *      "Sign in with Claude" button → navigates; a generic error does not.
 */

// ── Hoisted mocks (must precede the SUT import) ──────────────────────────────

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

// The singleton `router` both the composer intercepts and the ErrorBlock CTA use.
jest.mock('expo-router', () => ({
  __esModule: true,
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { ErrorBlock } from '../src/features/chat/blocks/ErrorBlock';
import {
  CLAUDE_ACCOUNT_ROUTE,
  isLoginCommand,
} from '../src/features/chat/composer/clientSlashCommands';
import { FollowUpComposer } from '../src/features/chat/FollowUpComposer';
import type { ChatSettings } from '../src/features/state';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

const routerMock = (jest.requireMock('expo-router') as { router: { push: jest.Mock } }).router;

const SANDBOX_BASE = 'https://sandbox.portable.test';

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const inertNetInfo: NetInfoLike = { addEventListener: () => () => {} };

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

const SETTINGS: Required<ChatSettings> = {
  model: 'opus',
  permissions: 'bypass_permissions',
  agentSetupId: 'freestyle',
  effort: 'high',
};

async function renderComposer(onSend: jest.Mock) {
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
      <ApiProvider client={buildClient(gateway)} queryClient={qc} netInfo={inertNetInfo}>
        <FollowUpComposer
          chatId="chat-1"
          settings={SETTINGS}
          onUpdateSettings={jest.fn()}
          onSend={onSend}
        />
      </ApiProvider>
    </SafeAreaProvider>
  );

  await act(async () => {
    fireEvent(screen.getByTestId('active-chat-composer-input'), 'focus');
    await Promise.resolve();
  });
}

beforeEach(() => {
  routerMock.push.mockClear();
});

describe('isLoginCommand', () => {
  it('matches exactly /login (trimmed, case-insensitive)', () => {
    expect(isLoginCommand('/login')).toBe(true);
    expect(isLoginCommand('  /LOGIN  ')).toBe(true);
  });

  it('does not match arguments, other commands, or plain text', () => {
    expect(isLoginCommand('/login now')).toBe(false);
    expect(isLoginCommand('/logout')).toBe(false);
    expect(isLoginCommand('login')).toBe(false);
    expect(isLoginCommand('please run /login')).toBe(false);
  });
});

describe('FollowUpComposer — /login intercept', () => {
  it('sending /login navigates to Claude Account instead of sending', async () => {
    const onSend = jest.fn();
    await renderComposer(onSend);

    fireEvent.changeText(screen.getByTestId('active-chat-composer-input'), '/login');
    fireEvent.press(screen.getByTestId('active-chat-send'));

    expect(onSend).not.toHaveBeenCalled();
    expect(routerMock.push).toHaveBeenCalledWith(CLAUDE_ACCOUNT_ROUTE);
    // The input was cleared (the command was consumed).
    expect(screen.getByTestId('active-chat-composer-input').props.value).toBe('');
  });

  it('a normal message still sends', async () => {
    const onSend = jest.fn();
    await renderComposer(onSend);

    fireEvent.changeText(screen.getByTestId('active-chat-composer-input'), 'hello there');
    fireEvent.press(screen.getByTestId('active-chat-send'));

    expect(onSend).toHaveBeenCalledWith('hello there', undefined);
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it('the slash picker lists the client login entry and selecting it navigates', async () => {
    const onSend = jest.fn();
    await renderComposer(onSend);

    fireEvent.changeText(screen.getByTestId('active-chat-composer-input'), '/log');

    const option = await screen.findByTestId('slash-command-option-login');
    fireEvent.press(option);

    expect(routerMock.push).toHaveBeenCalledWith(CLAUDE_ACCOUNT_ROUTE);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('active-chat-composer-input').props.value).toBe('');
  });
});

describe('ErrorBlock — dead-credential CTA', () => {
  it('renders the Sign in with Claude button for ai_credential_invalid and navigates', () => {
    render(
      <ErrorBlock
        block={{
          type: 'error',
          blockId: 'b1',
          title: 'Claude sign-in needed',
          message: "Portable couldn't run the AI — your Claude credential is missing or invalid.",
          code: 'ai_credential_invalid',
        }}
      />
    );

    fireEvent.press(screen.getByTestId('block-error-signin'));
    expect(routerMock.push).toHaveBeenCalledWith(CLAUDE_ACCOUNT_ROUTE);
  });

  it('does not render the CTA for a generic error block', () => {
    render(
      <ErrorBlock
        block={{ type: 'error', blockId: 'b2', title: 'Error', message: 'Something failed' }}
      />
    );
    expect(screen.queryByTestId('block-error-signin')).toBeNull();
  });
});
