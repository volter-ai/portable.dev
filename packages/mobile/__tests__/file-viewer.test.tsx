/**
 * File viewers (code, markdown, image, PDF, CSV, video, audio)
 * + the toolbar / 404-history / binary-download / breadcrumb-copy polish.
 *
 * Renders `FileViewerScreen` through the authed TanStack Query layer with a mocked
 * sandbox HTTP layer (`createMockGateway`) + an in-memory SecureStore (sandbox URL
 * + authToken). With one fixture file per type it asserts, per the story's
 * acceptance criteria:
 *
 *   - code → native syntax highlighting + the metadata toolbar (line count, copy,
 *     line-number toggle);
 *   - markdown → renders via `react-native-markdown-display`;
 *   - image → the RN `Image` viewer streams the `/raw/` URL with a Bearer header;
 *   - PDF → the `react-native-pdf` viewer (lazy-loaded);
 *   - CSV → PapaParse native table, sortable + auto-width + row/col badge + empty;
 *   - video / audio → expo-video / expo-audio viewers (mocked);
 *   - the breadcrumb reflects + copies the path;
 *   - loading / error / 404-history (restore) / 404-no-history / binary-download.
 */

// The viewers consume useAppTheme (CodeHighlight/MarkdownText) → themeStore → MMKV.
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

// In-memory keychain (sandbox URL + authToken live here).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

// The markdown viewer renders via react-native-markdown-display — mock it to a
// plain Text marker so the content is assertable without the markdown-it parser.
jest.mock('react-native-markdown-display', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children: string }) => <Text>{children}</Text>,
  };
});

// react-native-pdf is a device-only native module — mock it to a marker that
// surfaces the source URI so the lazy PDF viewer is assertable.
jest.mock('react-native-pdf', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ source }: { source: { uri: string } }) => (
      <Text testID="pdf-source">{source?.uri}</Text>
    ),
  };
});

// Clipboard (CodeViewer + Breadcrumb copy) — assertable spy.
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

// System browser (binary "Download file") — assertable spy.
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({})) }));

// expo-video — controllable VideoView marker + a statusChange emitter (error path).
jest.mock('expo-video', () => {
  const React = require('react');
  const { View } = require('react-native');
  let listener: ((p: { status?: string; error?: unknown }) => void) | null = null;
  const controller = {
    emitStatus: (payload: { status?: string; error?: unknown }) => listener?.(payload),
  };
  return {
    __controller: controller,
    useVideoPlayer: (_source: unknown, setup?: (p: unknown) => void) => {
      const player = {
        loop: false,
        play: jest.fn(),
        addListener: (_event: string, cb: (p: { status?: string; error?: unknown }) => void) => {
          listener = cb;
          return { remove: () => {} };
        },
      };
      setup?.(player);
      return player;
    },
    VideoView: ({ style, testID }: { style?: unknown; testID?: string }) =>
      React.createElement(View, { style, testID }),
  };
});

// expo-audio playback — minimal player + status (the recorder mock is separate).
const mockAudioPlayer = { play: jest.fn(), pause: jest.fn(), seekTo: jest.fn(async () => {}) };
const mockAudioStatus = { playing: false, currentTime: 0, duration: 120, isLoaded: true };
jest.mock('expo-audio', () => ({
  useAudioPlayer: () => mockAudioPlayer,
  useAudioPlayerStatus: () => mockAudioStatus,
}));

// The native NetInfo module must never load under Jest.
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { FileContent } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { FileViewerScreen, detectFileType, parseCsv } from '../src/features/file-viewer';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

interface SecureStoreMock {
  __store: Map<string, string>;
}
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;
const clipboard = jest.requireMock('expo-clipboard') as { setStringAsync: jest.Mock };
const webBrowser = jest.requireMock('expo-web-browser') as { openBrowserAsync: jest.Mock };
const expoVideo = jest.requireMock('expo-video') as {
  __controller: { emitStatus: (p: { status?: string; error?: unknown }) => void };
};

const SANDBOX_BASE = 'https://sandbox.portable.test';
const OWNER = 'octocat';
const REPO = 'hello-world';
const AUTH_TOKEN = 'good-token';

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const onlineNetInfo: NetInfoLike = { addEventListener: () => () => {} };

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

function contentsUrl(filePath: string): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/contents/${filePath}`;
}
function historyUrl(filePath: string): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/file-history/${filePath}`;
}
function rawUrl(filePath: string): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/raw/${filePath}`;
}

/** A base64 `FileContent` payload (the shape the sandbox `/contents/` returns). */
function textFile(filePath: string, body: string): FileContent {
  const name = filePath.split('/').pop() ?? filePath;
  return {
    type: 'file',
    name,
    path: filePath,
    sha: 'sha1',
    size: body.length,
    url: '',
    html_url: '',
    git_url: '',
    download_url: null,
    content: Buffer.from(body, 'utf-8').toString('base64'),
    encoding: 'base64',
  };
}

describe('File viewers', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return activeQueryClient;
  }

  function mount(filePath: string, onNavigate?: (dir: string) => void) {
    const client = buildClient(gateway);
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={newQueryClient()} netInfo={onlineNetInfo}>
          <FileViewerScreen owner={OWNER} repo={REPO} filePath={filePath} onNavigate={onNavigate} />
        </ApiProvider>
      </SafeAreaProvider>
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    secureStore.__store.clear();
    secureStore.__store.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.__store.set(AUTH_TOKEN_KEY, AUTH_TOKEN);
    gateway = createMockGateway();
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  // --- pure helpers -------------------------------------------------------

  it('detects the correct viewer type per extension', () => {
    expect(detectFileType('a.ts').type).toBe('code');
    expect(detectFileType('README.md').type).toBe('markdown');
    expect(detectFileType('logo.png').type).toBe('image');
    expect(detectFileType('manual.pdf').type).toBe('pdf');
    expect(detectFileType('people.csv').type).toBe('csv');
    expect(detectFileType('clip.mp4').type).toBe('video');
    expect(detectFileType('song.mp3').type).toBe('audio');
    expect(detectFileType('archive.zip').type).toBe('binary');
  });

  it('parses CSV with PapaParse into header + rows', () => {
    const parsed = parseCsv('name,age\nAlice,30\nBob,25', 'people.csv');
    expect(parsed.error).toBeUndefined();
    expect(parsed.headers).toEqual(['name', 'age']);
    expect(parsed.rows).toEqual([
      ['Alice', '30'],
      ['Bob', '25'],
    ]);
  });

  // --- loading / error states --------------------------------------------

  it('shows the loading skeleton while file content is fetching', async () => {
    const path = 'src/util.ts';
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    gateway.on('GET', contentsUrl(path), async () => {
      await gate;
      return { body: textFile(path, 'const x = 1;') };
    });

    mount(path);

    expect(await screen.findByTestId('file-viewer-loading')).toBeTruthy();
    await act(async () => {
      release();
    });
    expect(await screen.findByTestId('code-highlight')).toBeTruthy();
  });

  it('renders the error state when the API returns a non-404 error', async () => {
    const path = 'src/util.ts';
    gateway.on('GET', contentsUrl(path), () => ({ status: 500, body: { error: 'boom' } }));

    mount(path);

    expect(await screen.findByTestId('file-viewer-error')).toBeTruthy();
    expect(screen.queryByTestId('file-viewer-not-found')).toBeNull();
  });

  // --- 404 / git history --------------------------------------------------

  it('renders the git-history restore path on a 404 with last-commit history', async () => {
    const path = 'src/deleted.ts';
    gateway.on('GET', contentsUrl(path), () => ({ status: 404, body: { error: 'not found' } }));
    gateway.on('GET', historyUrl(path), () => ({
      body: {
        existed: true,
        lastCommit: {
          sha: 'abcdef1234567',
          message: 'Add the util',
          author: 'Alice',
          date: new Date().toISOString(),
          content: 'export const restored = true;',
        },
      },
    }));
    gateway.on('PUT', contentsUrl(path), () => ({ body: { sha: 'sha2' } }));

    mount(path);

    expect(await screen.findByTestId('file-not-found-history')).toBeTruthy();
    expect(screen.getByTestId('file-not-found-commit-sha')).toHaveTextContent('abcdef1');
    expect(screen.getByTestId('file-not-found-commit-author')).toHaveTextContent(/Alice/);
    expect(screen.getByTestId('file-not-found-commit-message')).toHaveTextContent(/Add the util/);

    // Restore → PUT /contents with the last-committed content.
    await act(async () => {
      fireEvent.press(screen.getByTestId('file-not-found-restore'));
    });
    await waitFor(() => {
      const put = gateway.requests.find((r) => r.method === 'PUT' && r.url === contentsUrl(path));
      expect(put).toBeTruthy();
      expect((put?.body as { content?: string })?.content).toBe('export const restored = true;');
    });
  });

  it('renders the plain not-found message on a 404 with no git history', async () => {
    const path = 'src/ghost.ts';
    gateway.on('GET', contentsUrl(path), () => ({ status: 404, body: { error: 'not found' } }));
    gateway.on('GET', historyUrl(path), () => ({ body: { existed: false } }));

    mount(path);

    expect(await screen.findByTestId('file-not-found-message')).toBeTruthy();
    expect(screen.queryByTestId('file-not-found-restore')).toBeNull();
  });

  // --- viewers ------------------------------------------------------------

  it('renders the code viewer with native syntax highlighting + toolbar', async () => {
    const path = 'src/util.ts';
    const src = 'const answer: number = 42;\nfunction add(a, b) { return a + b; }\nexport { add };';
    gateway.on('GET', contentsUrl(path), () => ({ body: textFile(path, src) }));

    mount(path);

    expect(screen.getByTestId('file-viewer-type').props.children).toBe('code');
    const code = await screen.findByTestId('code-highlight');
    expect(code).toHaveTextContent(/const/);
    expect(code).toHaveTextContent(/function/);

    // Toolbar: line count + copy + line-number toggle.
    expect(screen.getByTestId('code-viewer-line-count')).toHaveTextContent('3 lines');

    await act(async () => {
      fireEvent.press(screen.getByTestId('code-viewer-copy'));
    });
    expect(clipboard.setStringAsync).toHaveBeenCalledWith(src);

    // Toggling line numbers keeps the code rendered (per-line gutter variant).
    await act(async () => {
      fireEvent.press(screen.getByTestId('code-viewer-toggle-lines'));
    });
    expect(screen.getByTestId('code-highlight')).toHaveTextContent(/function/);
  });

  it('renders the markdown viewer via react-native-markdown-display', async () => {
    const path = 'docs/guide.md';
    gateway.on('GET', contentsUrl(path), () => ({
      body: textFile(path, '# Title\n\nHello markdown'),
    }));

    mount(path);

    expect(screen.getByTestId('file-viewer-type').props.children).toBe('markdown');
    expect(await screen.findByTestId('markdown')).toHaveTextContent(/Hello markdown/);
  });

  it('renders the image viewer streaming the /raw/ URL with a Bearer header', async () => {
    const path = 'assets/logo.png';
    mount(path);

    expect(screen.getByTestId('file-viewer-type').props.children).toBe('image');
    const img = await screen.findByTestId('file-viewer-image-content');
    expect(img.props.source.uri).toBe(rawUrl(path));
    expect(img.props.source.headers).toEqual({ Authorization: `Bearer ${AUTH_TOKEN}` });
    // No /contents/ fetch for a binary file — the bytes stream from /raw/.
    expect(gateway.requests.some((r) => r.url.includes('/contents/'))).toBe(false);
  });

  it('renders the react-native-pdf viewer with the /raw/ source (lazy-loaded)', async () => {
    const path = 'docs/manual.pdf';
    mount(path);

    expect(screen.getByTestId('file-viewer-type').props.children).toBe('pdf');
    expect(await screen.findByTestId('pdf-viewer')).toBeTruthy();
    expect(await screen.findByTestId('pdf-source')).toHaveTextContent(rawUrl(path));
  });

  it('renders the video viewer (expo-video) and shows an inline error on load failure', async () => {
    const path = 'media/clip.mp4';
    mount(path);

    expect(screen.getByTestId('file-viewer-type').props.children).toBe('video');
    expect(await screen.findByTestId('file-viewer-video')).toBeTruthy();
    expect(screen.getByTestId('file-viewer-video-player')).toBeTruthy();

    // A statusChange error surfaces the inline message (not a crash).
    await act(async () => {
      expoVideo.__controller.emitStatus({ status: 'error' });
    });
    expect(await screen.findByTestId('file-viewer-video-error')).toBeTruthy();
  });

  it('renders the audio viewer (expo-audio) with play/pause + duration', async () => {
    const path = 'media/song.mp3';
    mount(path);

    expect(screen.getByTestId('file-viewer-type').props.children).toBe('audio');
    expect(await screen.findByTestId('file-viewer-audio')).toBeTruthy();
    expect(screen.getByTestId('file-viewer-audio-name')).toHaveTextContent('song.mp3');
    expect(screen.getByTestId('file-viewer-audio-duration')).toHaveTextContent('2:00'); // 120s

    fireEvent.press(screen.getByTestId('file-viewer-audio-playpause'));
    expect(mockAudioPlayer.play).toHaveBeenCalled();
  });

  it('renders the CSV viewer as a native table with sortable columns, read-only', async () => {
    const path = 'data/people.csv';
    const csv = 'name,age\nAlice,30\nBob,25\nCarol,40';
    gateway.on('GET', contentsUrl(path), () => ({ body: textFile(path, csv) }));

    mount(path);

    expect(screen.getByTestId('file-viewer-type').props.children).toBe('csv');
    await screen.findByTestId('file-viewer-csv');

    // Metadata badge + header (sortable) + all three data rows.
    expect(screen.getByTestId('csv-meta')).toHaveTextContent('3 rows × 2 columns');
    expect(screen.getByTestId('csv-header-0')).toHaveTextContent('name');
    expect(screen.getByTestId('csv-header-1')).toHaveTextContent('age');
    expect(screen.getByTestId('csv-row-count')).toHaveTextContent('3');

    // Default (unsorted) order: Alice first.
    expect(screen.getByTestId('csv-row-0')).toHaveTextContent(/Alice/);

    // Sort ascending by `age` → Bob (25) to the top (numeric).
    await act(async () => {
      fireEvent.press(screen.getByTestId('csv-header-1'));
    });
    expect(screen.getByTestId('csv-row-0')).toHaveTextContent(/Bob/);
    expect(screen.getByTestId('csv-header-1')).toHaveTextContent(/▲/);

    // Sort descending → Carol (40) to the top.
    await act(async () => {
      fireEvent.press(screen.getByTestId('csv-header-1'));
    });
    expect(screen.getByTestId('csv-row-0')).toHaveTextContent(/Carol/);
    expect(screen.getByTestId('csv-header-1')).toHaveTextContent(/▼/);

    // Read-only: no editing inputs anywhere in the viewer.
    expect(screen.UNSAFE_queryAllByType(TextInput as never)).toHaveLength(0);
  });

  it('renders the CSV empty-table state for a header-only file', async () => {
    const path = 'data/empty.csv';
    gateway.on('GET', contentsUrl(path), () => ({ body: textFile(path, 'name,age') }));

    mount(path);

    await screen.findByTestId('file-viewer-csv');
    expect(screen.getByTestId('csv-empty')).toBeTruthy();
    expect(screen.getByTestId('csv-meta')).toHaveTextContent('0 rows × 2 columns');
  });

  // --- binary download ----------------------------------------------------

  it('renders a download button for an unpreviewable binary file', async () => {
    const path = 'dist/bundle.zip';
    mount(path);

    expect(screen.getByTestId('file-viewer-type').props.children).toBe('binary');
    expect(await screen.findByTestId('file-viewer-binary')).toBeTruthy();

    fireEvent.press(screen.getByTestId('file-viewer-download'));
    expect(webBrowser.openBrowserAsync).toHaveBeenCalledWith(
      `${rawUrl(path)}?token=${AUTH_TOKEN}`,
      expect.anything()
    );
    // No /contents/ fetch for a binary file.
    expect(gateway.requests.some((r) => r.url.includes('/contents/'))).toBe(false);
  });

  // --- breadcrumb ---------------------------------------------------------

  it('reflects the file path in the breadcrumb, navigates, and copies the path', async () => {
    const path = 'src/utils/file.ts';
    const onNavigate = jest.fn();
    gateway.on('GET', contentsUrl(path), () => ({ body: textFile(path, 'const x = 1;') }));

    mount(path, onNavigate);

    expect(screen.getByTestId('breadcrumb-repo')).toHaveTextContent(REPO);
    expect(screen.getByTestId('breadcrumb-segment-0')).toHaveTextContent('src');
    expect(screen.getByTestId('breadcrumb-segment-1')).toHaveTextContent('utils');
    expect(screen.getByTestId('breadcrumb-segment-2')).toHaveTextContent('file.ts');

    fireEvent.press(screen.getByTestId('breadcrumb-segment-1'));
    expect(onNavigate).toHaveBeenCalledWith('src/utils');

    fireEvent.press(screen.getByTestId('breadcrumb-repo'));
    expect(onNavigate).toHaveBeenCalledWith('');

    // Copy path button → clipboard gets the full path.
    await act(async () => {
      fireEvent.press(screen.getByTestId('breadcrumb-copy'));
    });
    expect(clipboard.setStringAsync).toHaveBeenCalledWith(path);
  });
});
