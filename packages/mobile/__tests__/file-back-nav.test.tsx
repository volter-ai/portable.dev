/**
 * RN file back-nav fix (AC1–AC5).
 *
 * Two test groups:
 *
 *   1. Route-shell (`FileViewRoute`) — verifies the `onNavigate` closure in
 *      `app/(app)/repos/[owner]/[repo]/file/[...path].tsx` calls
 *      `router.dismissTo` (not `router.push`) when the breadcrumb is tapped
 *      (AC2), and falls back to `router.navigate` when `canDismiss()` is false
 *      (AC4 deep-link single-entry guard).  FileViewerScreen is STUBBED to a
 *      minimal shim so we don't need the full HTTP / TanStack Query stack.
 *
 *   2. `onBack` AC4 tests — verifies that the route passes a guarded `onBack`
 *      to FileViewerScreen: `router.back()` when canDismiss=true, fallback to
 *      `router.navigate(repoTarget(''))` when canDismiss=false (no silent no-op
 *      on deep-link cold launch).
 *
 * AC5 regression: breadcrumb directory taps still fire `onNavigate` (asserted
 * below), and the repo-back chevron is exercised in the existing repo-page.test —
 * not touched here (different route component).
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

// ─── expo-router mock ─────────────────────────────────────────────────────────

jest.mock('expo-router', () => ({
  __esModule: true,
  router: {
    push: jest.fn(),
    back: jest.fn(),
    dismissTo: jest.fn(),
    navigate: jest.fn(),
    canDismiss: jest.fn(() => true),
  },
  useLocalSearchParams: jest.fn(() => ({
    owner: 'octocat',
    repo: 'hello-world',
    path: ['src', 'utils', 'helper.ts'],
  })),
}));

// ─── stub FileViewerScreen (STUBBED — real screen is in file-viewer-back-button.test) ─
// The stub surfaces onNavigate, onBack, owner, repo, filePath via tappable elements
// so tests can invoke the route's closures without the full HTTP/TanStack stack.
jest.mock('../src/features/file-viewer', () => {
  const { Pressable, Text, View } = require('react-native');
  return {
    __esModule: true,
    FileViewerScreen: ({
      onNavigate,
      onBack,
      owner,
      repo,
      filePath,
    }: {
      onNavigate?: (p: string) => void;
      onBack?: () => void;
      owner?: string;
      repo?: string;
      filePath?: string;
    }) => (
      <View testID="file-viewer-screen">
        <Text testID="stub-owner">{owner}</Text>
        <Text testID="stub-repo">{repo}</Text>
        <Text testID="stub-filepath">{filePath}</Text>
        {/* tappable elements that simulate breadcrumb nav */}
        <Pressable testID="stub-breadcrumb-repo" onPress={() => onNavigate?.('')} />
        <Pressable testID="stub-breadcrumb-dir" onPress={() => onNavigate?.('src/utils')} />
        {/* tappable element that simulates the back chevron */}
        <Pressable testID="stub-back-button" onPress={() => onBack?.()} />
      </View>
    ),
  };
});

// ─── imports ──────────────────────────────────────────────────────────────────

import { fireEvent, render, screen } from '@testing-library/react-native';
import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { GatewayClient } from '../src/services/gatewayClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { ApiProvider } from '../src/features/api/ApiProvider';
import { createMockGateway, type MockGateway } from '../src/test';

// Route under test (FileViewerScreen is STUBBED above)
import FileViewRoute from '../app/(app)/repos/[owner]/[repo]/file/[...path]';

interface SecureStoreMock {
  __store: Map<string, string>;
}
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

const expoRouter = jest.requireMock('expo-router') as {
  router: {
    push: jest.Mock;
    back: jest.Mock;
    dismissTo: jest.Mock;
    navigate: jest.Mock;
    canDismiss: jest.Mock;
  };
  useLocalSearchParams: jest.Mock;
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

// ─── Part 1: Route-shell breadcrumb tests (AC2 + AC4) ────────────────────────

describe('FileViewRoute onNavigate (AC2 + AC4)', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient() {
    activeQueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return activeQueryClient;
  }

  function mountRoute() {
    const client = buildClient(gateway);
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={newQueryClient()} netInfo={onlineNetInfo}>
          <FileViewRoute />
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
    expoRouter.router.canDismiss.mockReturnValue(true);
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  // AC2 — breadcrumb repo tap must call router.dismissTo, NEVER router.push
  it('AC2: breadcrumb repo tap calls router.dismissTo (not push) when canDismiss=true', () => {
    mountRoute();

    fireEvent.press(screen.getByTestId('stub-breadcrumb-repo'));

    expect(expoRouter.router.dismissTo).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/repos/[owner]/[repo]',
        params: expect.objectContaining({
          owner: OWNER,
          repo: REPO,
          tab: 'files',
          expandPath: '',
        }),
      })
    );
    expect(expoRouter.router.push).not.toHaveBeenCalled();
  });

  // AC2 — directory segment tap must call router.dismissTo with the dir path
  it('AC2: breadcrumb dir tap calls router.dismissTo with directory path when canDismiss=true', () => {
    mountRoute();

    fireEvent.press(screen.getByTestId('stub-breadcrumb-dir'));

    expect(expoRouter.router.dismissTo).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/repos/[owner]/[repo]',
        params: expect.objectContaining({
          owner: OWNER,
          repo: REPO,
          tab: 'files',
          expandPath: 'src/utils',
        }),
      })
    );
    expect(expoRouter.router.push).not.toHaveBeenCalled();
  });

  // AC4 — canDismiss()=false (deep link, single-entry stack) → fallback to navigate
  it('AC4: breadcrumb falls back to router.navigate (not dismissTo) when canDismiss() is false', () => {
    expoRouter.router.canDismiss.mockReturnValue(false);
    mountRoute();

    fireEvent.press(screen.getByTestId('stub-breadcrumb-repo'));

    expect(expoRouter.router.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/repos/[owner]/[repo]',
        params: expect.objectContaining({ owner: OWNER, repo: REPO, tab: 'files' }),
      })
    );
    expect(expoRouter.router.dismissTo).not.toHaveBeenCalled();
    expect(expoRouter.router.push).not.toHaveBeenCalled();
  });

  // AC4 — deep-link fallback also works for a dir-path segment
  it('AC4: dir-path breadcrumb fallback to router.navigate when canDismiss() is false', () => {
    expoRouter.router.canDismiss.mockReturnValue(false);
    mountRoute();

    fireEvent.press(screen.getByTestId('stub-breadcrumb-dir'));

    expect(expoRouter.router.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ expandPath: 'src/utils' }),
      })
    );
    expect(expoRouter.router.dismissTo).not.toHaveBeenCalled();
  });

  // AC5 regression — repo and dir path values are forwarded correctly in both branches
  it('AC5 regression: route passes owner/repo params correctly to the breadcrumb stub', () => {
    mountRoute();

    expect(screen.getByTestId('stub-owner')).toHaveTextContent(OWNER);
    expect(screen.getByTestId('stub-repo')).toHaveTextContent(REPO);
    expect(screen.getByTestId('stub-filepath')).toHaveTextContent('src/utils/helper.ts');
  });
});

// ─── Part 2: Route-shell onBack tests (AC4 back-button guard) ────────────────
//
// The back chevron in FileViewerScreen calls the `onBack` prop injected by the
// route.  These tests verify that the route's `onBack` closure applies the same
// AC4 canDismiss guard as `onNavigate`: router.back() when canDismiss=true,
// router.navigate(repoTarget('')) when canDismiss=false (no silent no-op on
// deep-link cold launch).

describe('FileViewRoute onBack (AC4 back-button guard)', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function mountRoute() {
    activeQueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const client = buildClient(gateway);
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={activeQueryClient} netInfo={onlineNetInfo}>
          <FileViewRoute />
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
    expoRouter.router.canDismiss.mockReturnValue(true);
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  it('AC4: onBack calls router.back() when canDismiss()=true', () => {
    mountRoute();

    fireEvent.press(screen.getByTestId('stub-back-button'));

    expect(expoRouter.router.back).toHaveBeenCalledTimes(1);
    expect(expoRouter.router.navigate).not.toHaveBeenCalled();
    expect(expoRouter.router.push).not.toHaveBeenCalled();
  });

  it('AC4: onBack falls back to router.navigate(repoTarget) when canDismiss()=false — no silent no-op', () => {
    expoRouter.router.canDismiss.mockReturnValue(false);
    mountRoute();

    fireEvent.press(screen.getByTestId('stub-back-button'));

    expect(expoRouter.router.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/repos/[owner]/[repo]',
        params: expect.objectContaining({
          owner: OWNER,
          repo: REPO,
          tab: 'files',
          expandPath: '',
        }),
      })
    );
    expect(expoRouter.router.back).not.toHaveBeenCalled();
    expect(expoRouter.router.push).not.toHaveBeenCalled();
  });
});

// ─── Part 3: AC5 regression (multiple taps, stub) ────────────────────────────
//
// NOTE: FileViewerScreen is STUBBED in this file (the jest.mock above applies to
// the whole file). Tests that need the REAL FileViewerScreen live in the
// companion file-viewer-back-button.test.tsx, which does NOT stub the module.

describe('breadcrumb onNavigate AC5 regression (stub)', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function mountRoute() {
    activeQueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const client = buildClient(gateway);
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={activeQueryClient} netInfo={onlineNetInfo}>
          <FileViewRoute />
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
    expoRouter.router.canDismiss.mockReturnValue(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
  });

  it('AC5 regression: multiple breadcrumb taps each call dismissTo with the right path', () => {
    mountRoute();

    // Repo root tap
    fireEvent.press(screen.getByTestId('stub-breadcrumb-repo'));
    expect(expoRouter.router.dismissTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ expandPath: '' }) })
    );

    // Directory tap
    jest.clearAllMocks();
    expoRouter.router.canDismiss.mockReturnValue(true);
    fireEvent.press(screen.getByTestId('stub-breadcrumb-dir'));
    expect(expoRouter.router.dismissTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ expandPath: 'src/utils' }) })
    );

    // router.push must never be called
    expect(expoRouter.router.push).not.toHaveBeenCalled();
  });
});
