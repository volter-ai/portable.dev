/**
 * Block renderer scaffold + core text/file blocks.
 *
 * Renders the native `BlockRenderer` against one fixture per CORE block type
 * (Text, Bash, BashOutput, Read, Write, Edit, Grep, Glob) and asserts:
 *   1. each block dispatches to its native renderer (by type, and for tool_use
 *      by toolName);
 *   2. text routes through `react-native-markdown-display` (mocked to a marker);
 *   3. code blocks render the native syntax highlighter and Edit renders the
 *      native +/- diff;
 *   4. an unknown/unhandled block type renders the visible fallback placeholder
 *      (and NEVER raw JSON).
 */

// TextBlock renders Markdown via react-native-markdown-display — mock it to a
// marker so we can assert text routes through it without loading markdown-it.
const mockMarkdownRender = jest.fn();
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
    default: ({ children }: { children?: unknown }) => {
      mockMarkdownRender(children);
      return <Text testID="md-display-mock">{children as string}</Text>;
    },
  };
});

import { fireEvent, render, screen } from '@testing-library/react-native';

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

import { BlockRenderer } from '../src/features/chat/blocks';
import type { ToolResult } from '../src/features/chat/blocks';

function renderBlock(block: ClaudeStreamBlock, result?: ToolResult, isRecent = true) {
  return render(<BlockRenderer block={block} result={result} isRecent={isRecent} />);
}

afterEach(() => {
  mockMarkdownRender.mockClear();
});

describe('BlockRenderer — core text/file blocks', () => {
  it('renders a text block as Markdown (routes through react-native-markdown-display)', () => {
    renderBlock({ type: 'text', content: '# Hello\n\nworld' });
    expect(screen.getByTestId('block-text')).toBeTruthy();
    // Markdown routed through the library component, with the raw content.
    expect(screen.getByTestId('md-display-mock')).toBeTruthy();
    expect(mockMarkdownRender).toHaveBeenCalledWith('# Hello\n\nworld');
  });

  it('strips the autopilot stop word from assistant text', () => {
    renderBlock({ type: 'text', content: 'All done!\n<promise>COMPLETE</promise>' });
    expect(screen.getByTestId('block-text')).toBeTruthy();
    // The `<promise>COMPLETE</promise>` token never reaches the renderer.
    expect(mockMarkdownRender).toHaveBeenCalledWith('All done!');
    expect(mockMarkdownRender).not.toHaveBeenCalledWith(
      expect.stringContaining('<promise>COMPLETE</promise>')
    );
  });

  it('renders a Bash block: command syntax-highlighted + output', () => {
    renderBlock(
      { type: 'tool_use', id: 't1', toolName: 'Bash', toolInput: { command: 'echo hi && ls' } },
      { content: 'hi' }
    );
    expect(screen.getByTestId('tool-block-bash')).toBeTruthy();
    // Auto-expanded (isRecent) → command rendered through the native highlighter.
    expect(screen.getByTestId('code-highlight')).toBeTruthy();
  });

  it('renders a BashOutput block with the result text', () => {
    renderBlock(
      { type: 'tool_use', id: 't2', toolName: 'BashOutput', toolInput: { bash_id: 'shell-1' } },
      { content: 'build complete' }
    );
    expect(screen.getByTestId('tool-block-bash-output')).toBeTruthy();
    expect(screen.getByText('build complete')).toBeTruthy();
  });

  it('renders a Read block: file contents syntax-highlighted', () => {
    renderBlock(
      { type: 'tool_use', id: 't3', toolName: 'Read', toolInput: { file_path: '/src/app.ts' } },
      { content: 'const x = 1;' }
    );
    expect(screen.getByTestId('tool-block-read')).toBeTruthy();
    expect(screen.getByTestId('code-highlight')).toBeTruthy();
  });

  it('renders a Write block: file contents syntax-highlighted', () => {
    renderBlock({
      type: 'tool_use',
      id: 't4',
      toolName: 'Write',
      toolInput: { file_path: '/src/new.py', content: 'def f():\n    return 1' },
    });
    expect(screen.getByTestId('tool-block-write')).toBeTruthy();
    expect(screen.getByTestId('code-highlight')).toBeTruthy();
  });

  it('renders an Edit block as a native +/- diff', () => {
    renderBlock({
      type: 'tool_use',
      id: 't5',
      toolName: 'Edit',
      toolInput: { file_path: '/a.ts', old_string: 'let a = 1', new_string: 'let a = 2' },
    });
    expect(screen.getByTestId('tool-block-edit')).toBeTruthy();
    expect(screen.getByTestId('diff-highlight')).toBeTruthy();
    // The changed line shows as both a removed and an added diff line.
    expect(screen.getAllByTestId('diff-line-remove').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('diff-line-add').length).toBeGreaterThan(0);
  });

  it('renders a Grep block with matched lines', () => {
    renderBlock(
      { type: 'tool_use', id: 't6', toolName: 'Grep', toolInput: { pattern: 'TODO' } },
      { content: 'a.ts:1: TODO\nb.ts:2: TODO' }
    );
    expect(screen.getByTestId('tool-block-grep')).toBeTruthy();
    expect(screen.getByTestId('grep-results')).toBeTruthy();
  });

  it('renders a Glob block with matched paths', () => {
    renderBlock(
      { type: 'tool_use', id: 't7', toolName: 'Glob', toolInput: { pattern: '**/*.ts' } },
      { content: 'src/a.ts\nsrc/b.ts' }
    );
    expect(screen.getByTestId('tool-block-glob')).toBeTruthy();
    expect(screen.getByTestId('glob-results')).toBeTruthy();
  });

  it('collapses a tool block by default (not isRecent) and expands on tap', () => {
    renderBlock(
      { type: 'tool_use', id: 't8', toolName: 'Read', toolInput: { file_path: '/a.ts' } },
      { content: 'const x = 1;' },
      false
    );
    // Collapsed → body absent.
    expect(screen.queryByTestId('tool-block-read-body')).toBeNull();
    expect(screen.queryByTestId('code-highlight')).toBeNull();
    fireEvent.press(screen.getByTestId('tool-block-read-toggle'));
    expect(screen.getByTestId('tool-block-read-body')).toBeTruthy();
    expect(screen.getByTestId('code-highlight')).toBeTruthy();
  });

  it('renders a visible fallback placeholder for an unknown block type (no raw JSON)', () => {
    // `image`/`video`/`actions` are handled elsewhere; use a type still
    // deferred to the interaction / github sets to exercise the fallback.
    renderBlock({ type: 'connection_request', content: 'data:image/png;base64,AAAA' });
    const fallback = screen.getByTestId('block-fallback');
    expect(fallback).toBeTruthy();
    expect(screen.getByText(/Unsupported block: connection_request/)).toBeTruthy();
    // The placeholder must NOT dump the raw payload.
    expect(screen.queryByText(/base64/)).toBeNull();
  });

  it('renders the GENERIC tool block for a tool_use with no specialised renderer (e.g. Task)', () => {
    // tool_use blocks no longer fall back to raw-JSON / placeholder —
    // an unrecognised tool renders the generic `ToolBlock` (a real native block).
    renderBlock({
      type: 'tool_use',
      id: 't9',
      toolName: 'Task',
      toolInput: { subagent_type: 'qa' },
    });
    expect(screen.getByTestId('tool-block-generic')).toBeTruthy();
    expect(screen.queryByTestId('block-fallback')).toBeNull();
    // The tool name labels the block; no raw JSON dump.
    expect(screen.getByText('Task')).toBeTruthy();
  });
});
