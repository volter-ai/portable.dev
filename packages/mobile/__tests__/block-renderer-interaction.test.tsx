/**
 * Block renderer: interaction blocks (Permission, Secrets,
 * ConnectionRequest).
 *
 * Renders the native `BlockRenderer` against one fixture per block type in this
 * story's set and asserts each dispatches to its native component — and crucially
 * that NONE falls back to the raw-JSON-free `FallbackBlock` placeholder (the AC's
 * anti-requirement). The submit/response flows themselves are covered separately;
 * this story renders the shells.
 */

// The block barrel transitively imports `react-native-markdown-display` (via
// MarkdownText) — mock it to a marker so Jest never loads markdown-it (same rule
// as the other block tests).
// Blocks consume useAppTheme → themeStore → MMKV. Mock it (in-memory).
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

jest.mock('react-native-markdown-display', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children?: unknown }) => (
      <Text testID="md-display-mock">{children as string}</Text>
    ),
  };
});

import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

import { BlockRenderer, PermissionBlock } from '../src/features/chat/blocks';
import type { ToolResult } from '../src/features/chat/blocks';

function renderBlock(block: ClaudeStreamBlock, result?: ToolResult, isRecent = true) {
  return render(<BlockRenderer block={block} result={result} isRecent={isRecent} />);
}

/** Every case asserts its testID is present AND the fallback placeholder is absent. */
function expectDispatch(testID: string) {
  expect(screen.getByTestId(testID)).toBeTruthy();
  expect(screen.queryByTestId('block-fallback')).toBeNull();
}

describe('BlockRenderer — interaction blocks', () => {
  it('Permission (needsPermission tool) → native PermissionBlock wrapping the tool', () => {
    renderBlock({
      type: 'tool_use',
      id: 'perm1',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf node_modules' },
      needsPermission: true,
      permissionRequestId: 'req-1',
    });
    expectDispatch('block-permission');
    // Approve/Deny shell present and the underlying tool block still renders.
    expect(screen.getByTestId('block-permission-approve')).toBeTruthy();
    expect(screen.getByTestId('block-permission-deny')).toBeTruthy();
    expect(screen.getByTestId('tool-block-bash')).toBeTruthy();
  });

  it('Permission → onRespond fires with the request id; after responding the prompt clears', () => {
    const onRespond = jest.fn();
    const { getByTestId, queryByTestId } = render(
      <PermissionBlock
        block={{
          type: 'tool_use',
          id: 'perm2',
          toolName: 'Write',
          toolInput: { file_path: '/x.ts' },
          needsPermission: true,
          permissionRequestId: 'req-2',
        }}
        onRespond={onRespond}
      >
        <Text testID="perm-child">inner</Text>
      </PermissionBlock>
    );
    fireEvent.press(getByTestId('block-permission-approve'));
    expect(onRespond).toHaveBeenCalledWith(true, 'req-2');
    // Once responded the prompt is gone; the wrapped child remains.
    expect(queryByTestId('block-permission-approve')).toBeNull();
    expect(getByTestId('perm-child')).toBeTruthy();
  });

  it('Secrets (request_user_secrets) → native SecretsBlock', () => {
    renderBlock({
      type: 'tool_use',
      id: 's1',
      toolName: 'mcp__standard__request_user_secrets',
      toolInput: {
        file_path: '/workspace/.env',
        secrets: [{ key: 'OPENAI_API_KEY', description: 'OpenAI key' }, { key: 'STRIPE_SECRET' }],
      },
    });
    expectDispatch('block-secrets');
    expect(screen.getByText('OPENAI_API_KEY')).toBeTruthy();
    expect(screen.getByText('STRIPE_SECRET')).toBeTruthy();
    expect(screen.getByTestId('block-secrets-submit')).toBeTruthy();
  });

  it('ConnectionRequest (request_user_connection) → native ConnectionRequestBlock', () => {
    renderBlock({
      type: 'tool_use',
      id: 'c1',
      toolName: 'mcp__run-connection__request_user_connection',
      toolInput: { service: 'slack', reason: 'Need Slack to post updates', required: true },
    });
    expectDispatch('block-connection-request');
    expect(screen.getByText('Need Slack to post updates')).toBeTruthy();
    expect(screen.getByText('Required')).toBeTruthy();
    expect(screen.getByTestId('block-connection-request-connect')).toBeTruthy();
  });

  it('NONE of the interaction block types render the raw-JSON fallback placeholder', () => {
    const fixtures: ClaudeStreamBlock[] = [
      {
        type: 'tool_use',
        id: 'a',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        needsPermission: true,
      },
      {
        type: 'tool_use',
        id: 'b',
        toolName: 'request_user_secrets',
        toolInput: { secrets: [{ key: 'TOKEN' }] },
      },
      {
        type: 'tool_use',
        id: 'c',
        toolName: 'mcp__standard__request_user_connection',
        toolInput: { service: 'github' },
      },
    ];

    for (const block of fixtures) {
      const { unmount } = renderBlock(block);
      expect(screen.queryByTestId('block-fallback')).toBeNull();
      unmount();
    }
  });
});
