/**
 * Block renderer: media, tool & agent blocks.
 *
 * Renders the native `BlockRenderer` against one fixture per block type in this
 * story's set (Image, Video, Playwright, generic Tool, Todo, Tunnel, ExitPlanMode,
 * Actions, WebSearch, WebFetch) and
 * asserts each dispatches to its native component — and crucially that NONE falls
 * back to the raw-JSON-free `FallbackBlock` placeholder (the AC's anti-requirement).
 */

// ExitPlanModeBlock renders its plan via react-native-markdown-display — mock it
// to a marker so we don't load markdown-it (same rule as the other blocks tests).
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

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';
import type { MessageAction } from '@vgit2/shared/types';

import { BlockRenderer } from '../src/features/chat/blocks';
import type { ToolResult } from '../src/features/chat/blocks';

function renderBlock(block: ClaudeStreamBlock, result?: ToolResult, isRecent = true) {
  return render(<BlockRenderer block={block} result={result} isRecent={isRecent} />);
}

/** Every case asserts its testID is present AND the fallback placeholder is absent. */
function expectDispatch(testID: string) {
  expect(screen.getByTestId(testID)).toBeTruthy();
  expect(screen.queryByTestId('block-fallback')).toBeNull();
}

describe('BlockRenderer — media / tool / agent blocks', () => {
  it('Image (absolute URL) → native ImageBlock', () => {
    renderBlock({ type: 'image', source: { url: 'https://x.test/shot.png' } });
    expectDispatch('block-image');
    expect(screen.getByTestId('block-image-img').props.source.uri).toBe('https://x.test/shot.png');
  });

  it('Image (base64 screenshot) → ImageBlock renders a data: URI inline', () => {
    renderBlock({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAB' },
    });
    expectDispatch('block-image');
    expect(screen.getByTestId('block-image-img').props.source.uri).toMatch(
      /^data:image\/png;base64,AAAB/
    );
  });

  it('Video → native VideoBlock PLAYS via expo-video (not a bare link)', () => {
    renderBlock({ type: 'video', source: { url: 'https://x.test/clip.webm' } });
    expectDispatch('block-video');
    // The expo-video player is mounted (the user-requested behaviour) — not the old link.
    expect(screen.getByTestId('block-video-player')).toBeTruthy();
    expect(screen.queryByTestId('block-video-open')).toBeNull();
  });

  it('display_video tool_use → generic ToolBlock (the PC emits the player as a separate video block)', () => {
    // The tool_result is just a text confirmation of a LOCAL path; the playable video
    // arrives as a SEPARATE `video` block (processDisplayVideo), so the tool_use must
    // NOT itself render a (broken) player.
    renderBlock(
      {
        type: 'tool_use',
        id: 'v1',
        toolName: 'mcp__standard__display_video',
        toolInput: { video_path: 'demo.webm' },
      },
      { content: [{ type: 'text', text: 'Video displayed: /tmp/pw/demo.webm' }] }
    );
    expectDispatch('tool-block-generic');
    expect(screen.queryByTestId('block-video')).toBeNull();
  });

  it('Playwright browser tool → native PlaywrightBlock', () => {
    renderBlock(
      {
        type: 'tool_use',
        id: 'p1',
        toolName: 'mcp__playwright__browser_navigate',
        toolInput: { url: 'https://example.com' },
      },
      { content: 'navigated' }
    );
    expectDispatch('tool-block-playwright');
  });

  it('unknown tool → GENERIC ToolBlock (not the fallback placeholder)', () => {
    renderBlock(
      { type: 'tool_use', id: 'g1', toolName: 'SomeMcpTool', toolInput: { foo: 'bar' } },
      { content: 'done' }
    );
    expectDispatch('tool-block-generic');
    expect(screen.getByText('SomeMcpTool')).toBeTruthy();
  });

  it('TodoWrite → native TodoBlock', () => {
    renderBlock({
      type: 'tool_use',
      id: 'td1',
      toolName: 'TodoWrite',
      toolInput: {
        todos: [
          { content: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' },
          { content: 'Ship it', activeForm: 'Shipping it', status: 'pending' },
        ],
      },
    });
    expectDispatch('block-todo');
    expect(screen.getByText('Writing tests')).toBeTruthy();
  });

  it('tunnel tool → native TunnelBlock', () => {
    renderBlock(
      {
        type: 'tool_use',
        id: 'tn1',
        toolName: 'mcp__standard__create_tunnel',
        toolInput: { port: 3000 },
      },
      { content: '✓ Tunnel ready for port 3000: https://abc.trycloudflare.com' }
    );
    expectDispatch('tool-block-tunnel');
  });

  it('ExitPlanMode → native ExitPlanModeBlock (plan + choices)', () => {
    renderBlock({
      type: 'tool_use',
      id: 'ep1',
      toolName: 'ExitPlanMode',
      toolInput: { plan: '# Plan\n\nDo the thing.' },
    });
    expectDispatch('block-exit-plan');
    expect(screen.getByTestId('block-exit-plan-full-control')).toBeTruthy();
    expect(screen.getByTestId('block-exit-plan-revise')).toBeTruthy();
  });

  it('Actions → native ActionsBlock', () => {
    renderBlock({
      type: 'actions',
      actions: [
        { id: 'a1', label: 'Continue refactoring', prompt: 'continue' },
        { id: 'a2', label: 'Archive', prompt: 'archive', type: 'archive' },
      ],
    });
    expectDispatch('block-actions');
    expect(screen.getByTestId('block-action-a1')).toBeTruthy();
    expect(screen.getByText('Continue refactoring')).toBeTruthy();
  });

  it('BlockRenderer forwards onActionClick to the chip (tapping fires it)', () => {
    const onActionClick = jest.fn();
    const action: MessageAction = {
      id: 'a1',
      label: 'Start fix',
      prompt: 'Fix the test',
      actionType: 'send_message',
    };
    render(
      <BlockRenderer block={{ type: 'actions', actions: [action] }} onActionClick={onActionClick} />
    );

    fireEvent.press(screen.getByTestId('block-action-a1'));

    expect(onActionClick).toHaveBeenCalledWith(action);
  });

  it('WebSearch → native WebSearchBlock', () => {
    renderBlock(
      { type: 'tool_use', id: 'ws1', toolName: 'WebSearch', toolInput: { query: 'rn testing' } },
      { content: 'Links: [{"title":"RN docs","url":"https://reactnative.dev"}]' }
    );
    expectDispatch('tool-block-web-search');
  });

  it('WebFetch → native WebFetchBlock', () => {
    renderBlock(
      {
        type: 'tool_use',
        id: 'wf1',
        toolName: 'WebFetch',
        toolInput: { url: 'https://example.com', prompt: 'summarise' },
      },
      { content: 'A summary.' }
    );
    expectDispatch('tool-block-web-fetch');
  });

  it('NONE of the media / tool / agent block types render the raw-JSON fallback placeholder', () => {
    const fixtures: { block: ClaudeStreamBlock; result?: ToolResult }[] = [
      { block: { type: 'image', source: { url: 'https://x/i.png' } } },
      { block: { type: 'video', source: { url: 'https://x/v.webm' } } },
      {
        block: {
          type: 'tool_use',
          id: 'a',
          toolName: 'mcp__playwright__browser_click',
          toolInput: {},
        },
      },
      { block: { type: 'tool_use', id: 'b', toolName: 'AnythingElse', toolInput: {} } },
      { block: { type: 'tool_use', id: 'c', toolName: 'TodoWrite', toolInput: { todos: [] } } },
      {
        block: {
          type: 'tool_use',
          id: 'd',
          toolName: 'mcp__standard__show_tunnel',
          toolInput: { port: 8080 },
        },
      },
      { block: { type: 'tool_use', id: 'e', toolName: 'ExitPlanMode', toolInput: { plan: 'x' } } },
      { block: { type: 'actions', actions: [{ id: 'x', label: 'Go', prompt: 'go' }] } },
      { block: { type: 'tool_use', id: 'f', toolName: 'WebSearch', toolInput: { query: 'q' } } },
      {
        block: { type: 'tool_use', id: 'g', toolName: 'WebFetch', toolInput: { url: 'https://x' } },
      },
    ];

    for (const { block, result } of fixtures) {
      const { unmount } = renderBlock(block, result);
      expect(screen.queryByTestId('block-fallback')).toBeNull();
      unmount();
    }
  });
});
