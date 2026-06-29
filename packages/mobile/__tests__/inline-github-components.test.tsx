/**
 * Inline GitHub component rendering in TextBlock.
 *
 * Tests:
 *   1. `parseInlineComponents` — parser unit tests (pure, no rendering).
 *   2. `InlineGitHubIssue` / `InlineGitHubPR` / `InlineGitHubWorkflow` — render
 *      the correct card testID and text from props; callback is invoked on tap.
 *   3. `TextBlock` with inline tags — fast-path (pure text) + mixed content,
 *      including viewer open/close lifecycle through the hoisted `TaskItemViewer`.
 *
 * Mocks required by the block barrel:
 *   - `react-native-mmkv` (themeStore)
 *   - `react-native-markdown-display` (MarkdownText)
 *   - `TaskItemViewer` (avoids pulling in expo-router + viewer deps)
 */

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

// Stub `TaskItemViewer` so TextBlock tests don't pull in expo-router et al.
jest.mock(
  '../src/features/tasks/viewer/TaskItemViewer',
  () => ({
    TaskItemViewer: ({ target, onClose }: { target: unknown; onClose: () => void }) => {
      const { View, Text, Pressable } = require('react-native');
      if (!target) return null;
      return (
        <View testID="task-item-viewer-stub">
          <Pressable testID="task-item-viewer-close" onPress={onClose}>
            <Text>Close</Text>
          </Pressable>
        </View>
      );
    },
  }),
  { virtual: false }
);

import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ViewerTarget } from '../src/features/tasks/viewer/viewerTypes';

import {
  parseInlineComponents,
  InlineGitHubIssue,
  InlineGitHubPR,
  InlineGitHubWorkflow,
} from '../src/features/chat/blocks/InlineGitHubComponents';
import { TextBlock } from '../src/features/chat/blocks/TextBlock';

// ─── parseInlineComponents ────────────────────────────────────────────────────

describe('parseInlineComponents', () => {
  it('returns a single text segment for plain text (fast path)', () => {
    const segs = parseInlineComponents('Hello world');
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ kind: 'text', content: 'Hello world' });
  });

  it('parses a GitHubIssue tag with string + number props', () => {
    const segs = parseInlineComponents('<GitHubIssue repo="owner/repo" number={42} />');
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      kind: 'component',
      name: 'GitHubIssue',
      props: { repo: 'owner/repo', number: 42 },
    });
  });

  it('parses a GitHubPR tag', () => {
    const segs = parseInlineComponents('<GitHubPR repo="volter/app" number={99} />');
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      kind: 'component',
      name: 'GitHubPR',
      props: { repo: 'volter/app', number: 99 },
    });
  });

  it('parses a GitHubWorkflow tag with runId', () => {
    const segs = parseInlineComponents('<GitHubWorkflow repo="a/b" runId={789} />');
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      kind: 'component',
      name: 'GitHubWorkflow',
      props: { repo: 'a/b', runId: 789 },
    });
  });

  it('splits mixed text + component into multiple segments', () => {
    const content = 'The bug is in <GitHubIssue repo="a/b" number={1} /> check it out';
    const segs = parseInlineComponents(content);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toMatchObject({ kind: 'text', content: 'The bug is in ' });
    expect(segs[1]).toMatchObject({ kind: 'component', name: 'GitHubIssue' });
    expect(segs[2]).toMatchObject({ kind: 'text', content: ' check it out' });
  });

  it('handles multiple inline tags in one string', () => {
    const content =
      'Issue <GitHubIssue repo="a/b" number={1} /> and PR <GitHubPR repo="a/b" number={2} />';
    const segs = parseInlineComponents(content);
    expect(segs).toHaveLength(4);
    expect(segs[0].kind).toBe('text');
    expect(segs[1]).toMatchObject({ kind: 'component', name: 'GitHubIssue' });
    expect(segs[2].kind).toBe('text');
    expect(segs[3]).toMatchObject({ kind: 'component', name: 'GitHubPR' });
  });

  it('leaves unrecognised component names as plain text', () => {
    const segs = parseInlineComponents('Hello <Unknown foo="bar" /> world');
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('text');
  });

  it('parses a bare boolean prop (with trailing space)', () => {
    const segs = parseInlineComponents('<GitHubIssue repo="a/b" number={1} compact />');
    const seg = segs[0];
    expect(seg.kind).toBe('component');
    if (seg.kind === 'component') {
      expect(seg.props.compact).toBe(true);
    }
  });
});

// ─── InlineGitHubIssue ────────────────────────────────────────────────────────

describe('InlineGitHubIssue', () => {
  it('renders the card with repo + number', () => {
    render(<InlineGitHubIssue repo="volter/app" number={42} onPress={jest.fn()} />);
    expect(screen.getByTestId('inline-github-issue')).toBeTruthy();
    expect(screen.getByText('volter/app #42')).toBeTruthy();
  });

  it('calls onPress with the correct ViewerTarget when tapped', () => {
    const onPress = jest.fn<void, [ViewerTarget]>();
    render(<InlineGitHubIssue repo="volter/app" number={42} onPress={onPress} />);
    fireEvent.press(screen.getByTestId('inline-github-issue'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith({
      kind: 'issue',
      owner: 'volter',
      repo: 'app',
      number: 42,
    });
  });
});

// ─── InlineGitHubPR ───────────────────────────────────────────────────────────

describe('InlineGitHubPR', () => {
  it('renders the card with repo + number', () => {
    render(<InlineGitHubPR repo="volter/app" number={100} onPress={jest.fn()} />);
    expect(screen.getByTestId('inline-github-pr')).toBeTruthy();
    expect(screen.getByText('volter/app #100')).toBeTruthy();
  });

  it('calls onPress with kind: pull when tapped', () => {
    const onPress = jest.fn<void, [ViewerTarget]>();
    render(<InlineGitHubPR repo="volter/app" number={100} onPress={onPress} />);
    fireEvent.press(screen.getByTestId('inline-github-pr'));
    expect(onPress).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'pull', owner: 'volter', repo: 'app', number: 100 })
    );
  });
});

// ─── InlineGitHubWorkflow ─────────────────────────────────────────────────────

describe('InlineGitHubWorkflow', () => {
  it('renders the card with repo + runId', () => {
    render(<InlineGitHubWorkflow repo="volter/app" runId={789} />);
    expect(screen.getByTestId('inline-github-workflow')).toBeTruthy();
    expect(screen.getByText('volter/app run 789')).toBeTruthy();
  });

  it('renders without runId (actions index fallback)', () => {
    render(<InlineGitHubWorkflow repo="volter/app" />);
    expect(screen.getByTestId('inline-github-workflow')).toBeTruthy();
    expect(screen.getByText('volter/app')).toBeTruthy();
  });
});

// ─── TextBlock with inline components ────────────────────────────────────────

describe('TextBlock — inline GitHub components', () => {
  it('fast path: pure text renders a single MarkdownText (no inline components)', () => {
    render(<TextBlock content="Hello **world**" />);
    expect(screen.getByTestId('block-text')).toBeTruthy();
    expect(screen.getByTestId('md-display-mock')).toBeTruthy();
    // No inline components rendered.
    expect(screen.queryByTestId('inline-github-issue')).toBeNull();
    expect(screen.queryByTestId('inline-github-pr')).toBeNull();
  });

  it('mixed: text + GitHubIssue tag renders markdown text segments + inline card', () => {
    render(
      <TextBlock content={'The bug is in <GitHubIssue repo="owner/repo" number={42} /> — see it'} />
    );
    expect(screen.getByTestId('block-text')).toBeTruthy();
    // Two text segments → two md-display-mock elements
    expect(screen.getAllByTestId('md-display-mock').length).toBeGreaterThanOrEqual(1);
    // The inline card
    expect(screen.getByTestId('inline-github-issue')).toBeTruthy();
    expect(screen.getByText('owner/repo #42')).toBeTruthy();
  });

  it('mixed: text + GitHubPR tag renders the PR card', () => {
    render(<TextBlock content={'PR: <GitHubPR repo="a/b" number={5} />'} />);
    expect(screen.getByTestId('inline-github-pr')).toBeTruthy();
    expect(screen.getByText('a/b #5')).toBeTruthy();
  });

  it('mixed: text + GitHubWorkflow tag renders the workflow card', () => {
    render(<TextBlock content={'Run: <GitHubWorkflow repo="a/b" runId={99} />'} />);
    expect(screen.getByTestId('inline-github-workflow')).toBeTruthy();
    expect(screen.getByText('a/b run 99')).toBeTruthy();
  });

  it('tapping an issue card opens the TaskItemViewer', () => {
    render(<TextBlock content={'See <GitHubIssue repo="owner/repo" number={1} />'} />);
    expect(screen.queryByTestId('task-item-viewer-stub')).toBeNull();
    fireEvent.press(screen.getByTestId('inline-github-issue'));
    expect(screen.getByTestId('task-item-viewer-stub')).toBeTruthy();
  });

  it('closing the TaskItemViewer hides it', () => {
    render(<TextBlock content={'See <GitHubIssue repo="owner/repo" number={1} />'} />);
    fireEvent.press(screen.getByTestId('inline-github-issue'));
    expect(screen.getByTestId('task-item-viewer-stub')).toBeTruthy();
    fireEvent.press(screen.getByTestId('task-item-viewer-close'));
    expect(screen.queryByTestId('task-item-viewer-stub')).toBeNull();
  });

  it('text-only content still routes through react-native-markdown-display', () => {
    render(<TextBlock content="# Hello\n\nworld" />);
    expect(screen.getByTestId('md-display-mock')).toBeTruthy();
  });
});
