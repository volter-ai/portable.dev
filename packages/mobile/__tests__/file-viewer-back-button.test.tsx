/**
 * fix(b) + Finding 1 — FileViewerScreen back button (AC1) and
 * breadcrumb flex:1 container.
 *
 * Uses the REAL FileViewerScreen (this file has NO jest.mock stub for
 * `../src/features/file-viewer`), so AC1 tests can mount the real component
 * with an injected `onBack` spy.  Native module mocks are shared via
 * nativeMocks factories (no copy-paste).
 *
 * Kept separate from file-back-nav.test.tsx because that file stubs the
 * entire `../src/features/file-viewer` module — a single file can't both stub
 * and use the real module without doMock/resetModules isolation.
 */

// ─── common native stubs (shared factories — no duplication) ─────────────────

jest.mock('react-native-mmkv', () => require('../src/test/nativeMocks').mmkvMockFactory());

jest.mock('expo-secure-store', () => require('../src/test/nativeMocks').secureStoreMockFactory());

jest.mock('@react-native-community/netinfo', () =>
  require('../src/test/nativeMocks').netInfoMockFactory()
);

jest.mock('expo-clipboard', () => require('../src/test/nativeMocks').clipboardMockFactory());

jest.mock('expo-web-browser', () => require('../src/test/nativeMocks').webBrowserMockFactory());

jest.mock('react-native-markdown-display', () =>
  require('../src/test/nativeMocks').markdownDisplayMockFactory()
);

jest.mock('react-native-pdf', () => require('../src/test/nativeMocks').pdfMockFactory());

jest.mock('expo-video', () => require('../src/test/nativeMocks').expoVideoMockFactory());

jest.mock('expo-audio', () => require('../src/test/nativeMocks').expoAudioSimpleMockFactory());

// expo-router: minimal stub (FileViewerScreen uses router.back() as the onBack
// default, but our AC1 tests inject a spy via the onBack prop so router.back is
// never called — the mock just prevents native module load errors).
jest.mock('expo-router', () => ({
  __esModule: true,
  router: {
    push: jest.fn(),
    back: jest.fn(),
    dismissTo: jest.fn(),
    navigate: jest.fn(),
    canDismiss: jest.fn(() => true),
  },
  useLocalSearchParams: jest.fn(() => ({})),
}));

import { fireEvent, render, screen } from '@testing-library/react-native';
import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { FileContent } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { FileViewerScreen } from '../src/features/file-viewer';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

interface SecureStoreMock {
  __store: Map<string, string>;
}
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

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

describe('fix(b) + Finding 1 — FileViewerScreen back button + breadcrumb layout (AC1)', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function mount(filePath: string, onBack?: () => void) {
    activeQueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const client = buildClient(gateway);
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={activeQueryClient} netInfo={onlineNetInfo}>
          <FileViewerScreen owner={OWNER} repo={REPO} filePath={filePath} onBack={onBack} />
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

  // AC1 / fix(b): a back button must be rendered regardless of loading state
  it('AC1: renders a file-viewer-back button in the header', () => {
    const path = 'src/util.ts';
    // Don't register a gateway handler — let the screen stay in loading state.
    // The header (including the back button) must render immediately regardless.
    mount(path);

    expect(screen.getByTestId('file-viewer-back')).toBeTruthy();
  });

  // AC1 / fix(b) + Finding 4: pressing the back button calls the injected onBack spy
  // (no global expo-router mock required — the onBack prop seam keeps it clean).
  it('AC1: pressing file-viewer-back calls the injected onBack callback', () => {
    const path = 'src/util.ts';
    gateway.on('GET', contentsUrl(path), () => ({ body: textFile(path, 'const x = 1;') }));

    const onBack = jest.fn();
    mount(path, onBack);

    fireEvent.press(screen.getByTestId('file-viewer-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  // Finding 1: breadcrumb container must have flex:1 so deep paths aren't clipped
  it('Finding 1: breadcrumb-container View is rendered (flex:1 wrapper for long paths)', () => {
    // A deep multi-segment path — verifies the wrapper is present for any path length.
    mount('a/b/c/d/e/f/g/deeply-nested-file.ts');
    expect(screen.getByTestId('breadcrumb-container')).toBeTruthy();
  });

  // Regression: existing screen testID still present alongside the new button
  it('regression: file-viewer-screen testID is still rendered after adding back button', () => {
    mount('README.md');
    expect(screen.getByTestId('file-viewer-screen')).toBeTruthy();
  });
});
