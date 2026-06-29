/**
 * Block renderer: GitHub block set + completion check.
 *
 * Renders the native `BlockRenderer` against one fixture per GitHub entity block
 * type (issue, PR, branch, workflow-run, commit, comment, repo)
 * and asserts each dispatches to its native component with NO raw-JSON
 * `FallbackBlock`. Plus the cross-set completion check: every `block.type` and
 * specialised tool in `BLOCK_COVERAGE` renders a fixture without
 * error and never hits the fallback. (Device-only visual parity on iOS + Android
 * is the deferred final pass, per the PRD's device-acceptance pattern.)
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

import { render, screen } from '@testing-library/react-native';

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

import { BLOCK_COVERAGE, BlockRenderer } from '../src/features/chat/blocks';
import type { ToolResult } from '../src/features/chat/blocks';

function renderBlock(block: ClaudeStreamBlock, result?: ToolResult, isRecent = true) {
  return render(<BlockRenderer block={block} result={result} isRecent={isRecent} />);
}

/** Asserts a fixture dispatched to a real native component, not the fallback. */
function expectDispatch(testID: string) {
  expect(screen.getByTestId(testID)).toBeTruthy();
  expect(screen.queryByTestId('block-fallback')).toBeNull();
}

describe('BlockRenderer — GitHub blocks', () => {
  it('Issue → native GitHubIssueBlock', () => {
    renderBlock({
      type: 'github_issue',
      repo: 'volterhq/portable',
      number: 42,
      title: 'Crash on cold start',
      state: 'open',
      html_url: 'https://github.com/volterhq/portable/issues/42',
    });
    expectDispatch('block-github-issue');
    expect(screen.getByText('Crash on cold start')).toBeTruthy();
    expect(screen.getByText('volterhq/portable #42')).toBeTruthy();
  });

  it('PR → native GitHubPRBlock (merged state)', () => {
    renderBlock({
      type: 'github_pull_request',
      repo: 'volterhq/portable',
      number: 100,
      title: 'Add native block renderer',
      merged: true,
      html_url: 'https://github.com/volterhq/portable/pull/100',
    });
    expectDispatch('block-github-pr');
    expect(screen.getByText('merged')).toBeTruthy();
  });

  it('Branch → native GitHubBranchBlock', () => {
    renderBlock({ type: 'github_branch', repo: 'volterhq/portable', branch: 'feat/blocks' });
    expectDispatch('block-github-branch');
    expect(screen.getByText('feat/blocks')).toBeTruthy();
  });

  it('Workflow run → native GitHubWorkflowRunBlock', () => {
    renderBlock({
      type: 'github_workflow_run',
      repo: 'volterhq/portable',
      runId: 9876,
      name: 'CI',
      conclusion: 'success',
    });
    expectDispatch('block-github-workflow-run');
    expect(screen.getByText('success')).toBeTruthy();
  });

  it('Commit → native GitHubCommitBlock (short sha)', () => {
    renderBlock({
      type: 'github_commit',
      repo: 'volterhq/portable',
      sha: 'abcdef1234567890',
      message: 'fix: handle null sandbox url',
    });
    expectDispatch('block-github-commit');
    expect(screen.getByText('volterhq/portable abcdef1')).toBeTruthy();
  });

  it('Comment → native GitHubCommentBlock', () => {
    renderBlock({
      type: 'github_comment',
      repo: 'volterhq/portable',
      author: 'octocat',
      body: 'Looks good to me!',
    });
    expectDispatch('block-github-comment');
    expect(screen.getByText('Looks good to me!')).toBeTruthy();
  });

  it('Repo → native GitHubRepoBlock', () => {
    renderBlock({ type: 'github_repo', repo: 'volterhq/portable', description: 'Mobile AI IDE' });
    expectDispatch('block-github-repo');
    expect(screen.getByText('Mobile AI IDE')).toBeTruthy();
  });

  it('error block → native ErrorBlock', () => {
    renderBlock({
      type: 'error',
      title: 'Tool failed',
      message: 'The command exited with status 1',
      code: 'E_EXIT_1',
      details: 'stderr: command not found',
    });
    expectDispatch('block-error');
    expect(screen.getByText('Tool failed')).toBeTruthy();
    // Details are collapsible → a toggle is present.
    expect(screen.getByTestId('block-error-toggle')).toBeTruthy();
  });

  it('NONE of the GitHub / error block types render the raw-JSON fallback', () => {
    const fixtures: ClaudeStreamBlock[] = [
      { type: 'github_issue', repo: 'a/b', number: 1 },
      { type: 'github_pr', repo: 'a/b', number: 2 },
      { type: 'github_branch', repo: 'a/b', branch: 'main' },
      { type: 'github_workflow', repo: 'a/b', runId: 3 },
      { type: 'github_commit', repo: 'a/b', sha: 'deadbeef' },
      { type: 'github_comment', repo: 'a/b', author: 'x' },
      { type: 'github_repository', repo: 'a/b' },
      { type: 'error', message: 'boom' },
    ];
    for (const block of fixtures) {
      const { unmount } = renderBlock(block);
      expect(screen.queryByTestId('block-fallback')).toBeNull();
      unmount();
    }
  });
});

describe('BlockRenderer — completion check across all block sets', () => {
  // One fixture per covered block type / tool. Every entry MUST render without a
  // `block-fallback`. A genuinely-unknown type is the control (it SHOULD fall back).
  const blockTypeFixture = (type: string): ClaudeStreamBlock => {
    switch (type) {
      case 'text':
        return { type: 'text', content: 'hello **world**' };
      case 'image':
        return { type: 'image', source: { type: 'base64', data: 'AAA', media_type: 'image/png' } };
      case 'video':
        return { type: 'video', content: '/workspace/out.mp4' };
      case 'actions':
        return { type: 'actions', actions: [{ label: 'Open', action: 'open' }] };
      case 'error':
        return { type: 'error', message: 'boom' };
      default:
        // GitHub entity types — a minimal repo-bearing fixture.
        return { type, repo: 'a/b', number: 1, runId: 1, branch: 'main', sha: 'deadbeef' };
    }
  };

  const toolFixture = (toolName: string): ClaudeStreamBlock => {
    const name = toolName.endsWith('*') ? toolName.replace('*', 'navigate') : toolName;
    const base: ClaudeStreamBlock = { type: 'tool_use', id: `t-${name}`, toolName: name };
    if (name === 'request_user_secrets') base.toolInput = { secrets: [{ key: 'K' }] };
    else if (name === 'request_user_connection') base.toolInput = { service: 'github' };
    else
      base.toolInput = {
        command: 'ls',
        file_path: '/x.ts',
        query: 'q',
        url: 'https://x',
        port: 3000,
      };
    return base;
  };

  it.each(BLOCK_COVERAGE.blockTypes)('block.type "%s" dispatches (no fallback)', (type) => {
    renderBlock(blockTypeFixture(type));
    expect(screen.queryByTestId('block-fallback')).toBeNull();
  });

  it.each(BLOCK_COVERAGE.toolNames)('tool "%s" dispatches (no fallback)', (toolName) => {
    renderBlock(toolFixture(toolName));
    expect(screen.queryByTestId('block-fallback')).toBeNull();
  });

  it('a genuinely-unknown block type still renders the visible fallback (control)', () => {
    renderBlock({ type: 'totally_unknown_block' });
    expect(screen.getByTestId('block-fallback')).toBeTruthy();
  });
});
