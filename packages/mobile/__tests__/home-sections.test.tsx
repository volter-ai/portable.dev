/**
 * Home-screen sections — presentational tests for the new home
 * pieces: the floating profile pill, the swipeable recent-repos grid, the
 * "Continue chats" preview, and the repos-error card. These are pure views over
 * `useAppTheme()` (no API/socket), so they mount with only the MMKV theme-store
 * mock + a SafeAreaProvider.
 */

// react-native-mmkv backs the theme store that `useAppTheme()` reads at import.
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

import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { ChatListItem, RepositoryWithLocal } from '@vgit2/shared/types';
import { AUTOPILOT_COMPLETION_INSTRUCTION } from '@vgit2/shared/utils/autopilotHelpers';

import {
  HomeChatsSection,
  HomeErrorDisplay,
  HomeReposGrid,
  NewProjectModal,
  ProfilePill,
  getRelativeTime,
  getRepoFromPath,
  repoNameFontSize,
} from '../src/features/home';

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function wrap(node: React.ReactElement) {
  // SafeAreaProvider is typed against @types/react@18; this package is React 19
  // (whose ReactNode adds bigint), so a React-19 element passed as children trips
  // the cross-version structural check. Cast through `never` (the codebase idiom).
  return render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>{node as never}</SafeAreaProvider>
  );
}

function repo(full_name: string, extra: Partial<RepositoryWithLocal> = {}): RepositoryWithLocal {
  const [login, name] = full_name.split('/');
  return {
    id: 1,
    name,
    full_name,
    owner: { login, id: 1, avatar_url: `https://avatars/${login}.png` } as never,
    private: false,
    description: null,
    homepage: null,
    html_url: '',
    fork: false,
    created_at: '',
    updated_at: '',
    pushed_at: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    ...extra,
  } as RepositoryWithLocal;
}

describe('home sections', () => {
  it('ProfilePill renders the bare user-glyph fallback (no avatar) and fires onPress', () => {
    const onPress = jest.fn();
    wrap(<ProfilePill onPress={onPress} />);
    // No avatar → a bare user glyph, no initial-letter circle.
    expect(screen.getByTestId('home-profile-fallback')).toBeTruthy();
    fireEvent.press(screen.getByTestId('home-profile-pill'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('HomeReposGrid renders repo cards once laid out and navigates on press', () => {
    const onRepoPress = jest.fn();
    wrap(
      <HomeReposGrid
        repos={[repo('octocat/hello'), repo('octocat/world')]}
        onRepoPress={onRepoPress}
      />
    );
    // Width comes from onLayout; fire it so the paged grid renders its cards.
    fireEvent(screen.getByTestId('home-recent-repos'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 342, height: 300 } },
    });
    fireEvent.press(screen.getByTestId('home-repo-octocat/hello'));
    expect(onRepoPress).toHaveBeenCalledWith('octocat', 'hello');
  });

  it('HomeReposGrid shows a spinner while loading and nothing when empty', () => {
    const { rerender } = wrap(<HomeReposGrid repos={[]} loading onRepoPress={jest.fn()} />);
    expect(screen.getByTestId('home-repos-loading')).toBeTruthy();
    rerender(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <HomeReposGrid repos={[]} loading={false} onRepoPress={jest.fn()} />
      </SafeAreaProvider>
    );
    expect(screen.queryByTestId('home-recent-repos')).toBeNull();
  });

  it('HomeReposGrid shows the "Portable Projects" header + See more', () => {
    const onSeeMore = jest.fn();
    wrap(
      <HomeReposGrid
        repos={[repo('octocat/hello')]}
        onRepoPress={jest.fn()}
        onSeeMore={onSeeMore}
      />
    );
    expect(screen.getByText('Portable Projects')).toBeTruthy();
    fireEvent.press(screen.getByTestId('home-repos-see-more'));
    expect(onSeeMore).toHaveBeenCalledTimes(1);
  });

  it('HomeReposGrid injects the "+ New" tile (renders with zero repos) when onNewProject is set', () => {
    const onNewProject = jest.fn();
    wrap(<HomeReposGrid repos={[]} onRepoPress={jest.fn()} onNewProject={onNewProject} />);
    // The section renders even with no repos — the new tile trails the list.
    fireEvent(screen.getByTestId('home-recent-repos'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 342, height: 300 } },
    });
    fireEvent.press(screen.getByTestId('home-new-project'));
    expect(onNewProject).toHaveBeenCalledTimes(1);
  });

  it('NewProjectModal: Create is gated on a name, defaults to local-only, GitHub toggle opts in', () => {
    const onSubmit = jest.fn();
    const onCancel = jest.fn();
    wrap(<NewProjectModal visible onSubmit={onSubmit} onCancel={onCancel} />);
    // Disabled until a name is entered.
    fireEvent.press(screen.getByTestId('new-project-submit'));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.changeText(screen.getByTestId('new-project-name'), 'my-app');
    // Default: GitHub repo OFF (local-only).
    fireEvent.press(screen.getByTestId('new-project-submit'));
    expect(onSubmit).toHaveBeenLastCalledWith('my-app', { createGithubRepo: false });
    // Flip the toggle → opts into the remote repo.
    fireEvent(screen.getByTestId('new-project-github-toggle'), 'valueChange', true);
    fireEvent.press(screen.getByTestId('new-project-submit'));
    expect(onSubmit).toHaveBeenLastCalledWith('my-app', { createGithubRepo: true });
    fireEvent.press(screen.getByTestId('new-project-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('HomeChatsSection lists chats, See more + chat press route', () => {
    const onChatPress = jest.fn();
    const onSeeMore = jest.fn();
    const chats: ChatListItem[] = [
      {
        id: 'c1',
        type: 'claude_code',
        title: 'Fix the bug',
        lastUpdated: Date.now() - 3600_000,
        repo_path: '~/claude-workspace/me@x.com/octocat/hello',
        lastMessagePreview: 'done <promise>complete</promise>',
      } as ChatListItem,
    ];
    wrap(<HomeChatsSection chats={chats} onChatPress={onChatPress} onSeeMore={onSeeMore} />);
    expect(screen.getByText('Fix the bug')).toBeTruthy();
    // The autopilot stop-word is stripped from the last-message preview.
    expect(screen.getByText('done')).toBeTruthy();
    fireEvent.press(screen.getByTestId('chat-home-directory'));
    expect(onSeeMore).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('home-chat-c1'));
    expect(onChatPress).toHaveBeenCalledWith('c1');
  });

  it('HomeChatsSection long-press fires onChatLongPress (the shared action menu seam)', () => {
    const onChatLongPress = jest.fn();
    const chats: ChatListItem[] = [{ id: 'c1', type: 'claude_code', title: 'Fix the bug' }];
    wrap(
      <HomeChatsSection
        chats={chats}
        onChatPress={jest.fn()}
        onChatLongPress={onChatLongPress}
        onSeeMore={jest.fn()}
      />
    );
    fireEvent(screen.getByTestId('home-chat-c1'), 'longPress');
    expect(onChatLongPress).toHaveBeenCalledWith(chats[0]);
  });

  it('HomeChatsSection scrolls within its own contained area, showing boundary fades', () => {
    const chats: ChatListItem[] = Array.from(
      { length: 12 },
      (_, i) =>
        ({
          id: `c${i}`,
          type: 'claude_code',
          title: `Chat ${i}`,
          lastUpdated: Date.now() - i * 1000,
        }) as ChatListItem
    );
    wrap(<HomeChatsSection chats={chats} onChatPress={jest.fn()} onSeeMore={jest.fn()} />);

    // The cards live in a self-contained scroll area (not the home page scroll).
    const scroll = screen.getByTestId('home-chats-scroll');

    // Layout: viewport 300px, content 800px → the area is scrollable.
    fireEvent(scroll, 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 300 } },
    });
    fireEvent(scroll, 'contentSizeChange', 300, 800);

    // At the top: only the bottom fade shows ("more below").
    expect(screen.queryByTestId('home-chats-fade-top')).toBeNull();
    expect(screen.getByTestId('home-chats-fade-bottom')).toBeTruthy();

    // Scrolled to the bottom: the top fade appears, the bottom fade clears.
    fireEvent.scroll(scroll, { nativeEvent: { contentOffset: { y: 500 } } });
    expect(screen.getByTestId('home-chats-fade-top')).toBeTruthy();
    expect(screen.queryByTestId('home-chats-fade-bottom')).toBeNull();
  });

  it('shows the repo name from repoFullName / a flat disk path, not a generic "Workspace"', () => {
    // chat-list fix: a discovered chat carries the backend-resolved GitHub full_name
    // (the flat-clone repo_path is a raw disk path the legacy parser returns null for) —
    // and even without it, the disk-path basename beats the "Workspace" fallback.
    const chats: ChatListItem[] = [
      {
        id: 'r1',
        type: 'claude_code',
        title: 'A',
        lastUpdated: Date.now(),
        repo_path: '/Users/me/volter/my-app',
        repoFullName: 'volter-ai/my-app',
      } as ChatListItem,
      {
        id: 'r2',
        type: 'claude_code',
        title: 'B',
        lastUpdated: Date.now(),
        repo_path: '/Users/me/volter/clock-app', // no repoFullName → falls back to basename
      } as ChatListItem,
    ];
    wrap(<HomeChatsSection chats={chats} onChatPress={jest.fn()} onSeeMore={jest.fn()} />);
    expect(screen.getByText('my-app')).toBeTruthy();
    expect(screen.getByText('clock-app')).toBeTruthy();
    expect(screen.queryByText('Workspace')).toBeNull();
  });

  it('strips the leaked autopilot instruction from the first-message preview title', () => {
    const chats: ChatListItem[] = [
      {
        id: 'c2',
        type: 'claude_code',
        title: 'fallback title',
        lastUpdated: Date.now() - 3600_000,
        repo_path: '~/claude-workspace/me@x.com/octocat/hello',
        firstMessagePreview: `add a comment to the README${AUTOPILOT_COMPLETION_INSTRUCTION}`,
      } as ChatListItem,
    ];
    wrap(<HomeChatsSection chats={chats} onChatPress={jest.fn()} onSeeMore={jest.fn()} />);
    expect(screen.getByText('add a comment to the README')).toBeTruthy();
    expect(screen.queryByText(/IMPORTANT: You MUST/)).toBeNull();
    expect(screen.queryByText(/<promise>COMPLETE<\/promise>/)).toBeNull();
  });

  it('strips a truncated <task-notification> blob from the card preview (public issue #11)', () => {
    // A preview built by an OLDER PC api that did not strip server-side arrives here
    // truncated at 100 chars, so the closing </task-notification> tag is gone. The card
    // must still hide the raw marker (falling back to the chat title), not render it.
    const NOTE =
      '<task-notification>\n<task-id>bvt6pifet</task-id>\n<tool-use-id>toolu_01S8gFaS</tool-use-id>\n<status>killed</status>';
    const chats: ChatListItem[] = [
      {
        id: 'c-note',
        type: 'claude_code',
        title: 'Start dev server',
        lastUpdated: Date.now() - 3600_000,
        repo_path: '~/claude-workspace/me@x.com/octocat/hello',
        firstMessagePreview: `${NOTE.slice(0, 100)}...`,
        lastMessagePreview: `${NOTE.slice(0, 100)}...`,
      } as ChatListItem,
    ];
    wrap(<HomeChatsSection chats={chats} onChatPress={jest.fn()} onSeeMore={jest.fn()} />);
    // Title falls back to chat.title; no fragment of the marker is rendered anywhere.
    expect(screen.getByText('Start dev server')).toBeTruthy();
    expect(screen.queryByText(/task-notification/)).toBeNull();
    expect(screen.queryByText(/task-id/)).toBeNull();
  });

  it('HomeChatsSection renders nothing with no chats', () => {
    wrap(<HomeChatsSection chats={[]} onChatPress={jest.fn()} onSeeMore={jest.fn()} />);
    expect(screen.queryByTestId('home-recent-chats')).toBeNull();
  });

  it('HomeChatsSection shows a spinner on first load (loading, no chats yet)', () => {
    const { rerender } = wrap(
      <HomeChatsSection chats={[]} loading onChatPress={jest.fn()} onSeeMore={jest.fn()} />
    );
    expect(screen.getByTestId('home-chats-loading')).toBeTruthy();

    // Once chats arrive the spinner is gone and the cards render (loading is ignored
    // when there are chats — a background refetch never replaces the list with a spinner).
    rerender(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <HomeChatsSection
          chats={[{ id: 'c1', type: 'claude_code', title: 'Hi' }]}
          loading
          onChatPress={jest.fn()}
          onSeeMore={jest.fn()}
        />
      </SafeAreaProvider>
    );
    expect(screen.queryByTestId('home-chats-loading')).toBeNull();
    expect(screen.getByTestId('home-chat-c1')).toBeTruthy();
  });

  it('HomeErrorDisplay shows the error code + message', () => {
    wrap(
      <HomeErrorDisplay
        error={{ code: 'NETWORK_ERROR', message: 'offline' }}
        context="fetch repositories"
      />
    );
    expect(screen.getByTestId('home-repos-error')).toBeTruthy();
    expect(screen.getByText('offline')).toBeTruthy();
    expect(screen.getByText('Error Code: NETWORK_ERROR')).toBeTruthy();
    // No action prop → no action button (display-only default).
    expect(screen.queryByTestId('home-error-action')).toBeNull();
  });

  it('HomeErrorDisplay renders the optional action button (home repos-error → Connect PC)', () => {
    const onPress = jest.fn();
    wrap(
      <HomeErrorDisplay
        error={{ code: 'NETWORK_ERROR', message: 'offline' }}
        context="fetch repositories"
        action={{ label: 'Connect PC', testID: 'home-connect-pc', onPress }}
      />
    );
    const button = screen.getByTestId('home-connect-pc');
    expect(screen.getByText('Connect PC')).toBeTruthy();
    fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('home helpers', () => {
  it('getRelativeTime buckets by elapsed time', () => {
    const now = 10_000_000_000;
    expect(getRelativeTime(now - 30_000, now)).toBe('just now');
    expect(getRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(getRelativeTime(now - 3 * 3600_000, now)).toBe('3h ago');
    expect(getRelativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(getRelativeTime(now - 14 * 86_400_000, now)).toBe('2w ago');
  });

  it('getRepoFromPath extracts owner/repo and rejects reserved owners', () => {
    expect(getRepoFromPath('~/claude-workspace/me@x.com/octocat/hello')).toBe('octocat/hello');
    expect(getRepoFromPath('~/claude-workspace/me@x.com/workspace/hello')).toBeNull();
    expect(getRepoFromPath('/some/other/path')).toBeNull();
    expect(getRepoFromPath(undefined)).toBeNull();
  });

  it('repoNameFontSize shrinks with length', () => {
    expect(repoNameFontSize(5)).toBe(12.8);
    expect(repoNameFontSize(30)).toBe(8.8);
  });
});
