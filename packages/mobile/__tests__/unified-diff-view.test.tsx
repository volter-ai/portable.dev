/**
 * UnifiedDiffView (portable.dev#17) — the shared native unified-diff renderer
 * extracted from PullViewer. Asserts the testID contract (preserved for the PR
 * Files tab), the line classification (add/remove/context/@@ hunk), the optional
 * filename header, and the pure `classifyDiffLine` helper.
 */
import { render } from '@testing-library/react-native';

// useAppTheme → themeStore → react-native-mmkv (nitro) — mock it in-memory.
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (key: string, value: string | number | boolean) => store.set(key, String(value)),
    getString: (key: string) => (store.has(key) ? store.get(key) : undefined),
    remove: (key: string) => store.delete(key),
    contains: (key: string) => store.has(key),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance };
});

import { UnifiedDiffView, classifyDiffLine } from '../src/components/UnifiedDiffView';

const PATCH = '@@ -1,2 +1,3 @@\n context line\n+added line\n-removed line';

describe('classifyDiffLine', () => {
  it('classifies hunk / add / remove / context lines', () => {
    expect(classifyDiffLine('@@ -1,2 +1,3 @@')).toBe('hunk');
    expect(classifyDiffLine('+added')).toBe('add');
    expect(classifyDiffLine('-removed')).toBe('remove');
    expect(classifyDiffLine(' unchanged')).toBe('context');
    expect(classifyDiffLine('')).toBe('context');
  });
});

describe('UnifiedDiffView', () => {
  it('renders the patch under the given testID with every line', () => {
    const screen = render(<UnifiedDiffView diff={PATCH} testID="pull-viewer-patch-src/app.ts" />);
    expect(screen.getByTestId('pull-viewer-patch-src/app.ts')).toBeTruthy();
    expect(screen.getByText('@@ -1,2 +1,3 @@')).toBeTruthy();
    expect(screen.getByText('+added line')).toBeTruthy();
    expect(screen.getByText('-removed line')).toBeTruthy();
  });

  it('renders an optional filename header above the diff', () => {
    const screen = render(<UnifiedDiffView diff={PATCH} filename="src/app.ts" />);
    expect(screen.getByText('src/app.ts')).toBeTruthy();
  });

  it('omits the filename header when none is given', () => {
    const screen = render(<UnifiedDiffView diff={PATCH} />);
    expect(screen.queryByText('src/app.ts')).toBeNull();
  });
});
