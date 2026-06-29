/**
 * File/image upload + image gallery + camera.
 *
 * Mounts `AttachmentBar` (the composer attach surface) inside the authed TanStack
 * Query layer (`createMockGateway`) with `expo-image-picker` / `expo-document-picker`
 * / `expo-image-manipulator` replaced by controllable mocks and an in-memory
 * SecureStore. Verifies, end-to-end with no device + no network (per the AC):
 *
 *   1. a picked image is COMPRESSED (expo-image-manipulator) and multipart-POSTed
 *      to `/api/upload` (field `file`, Bearer, no cookies);
 *   2. the uploaded attachment appears in the message (a thumbnail in the strip);
 *   3. the image gallery modal opens and RESPONDS TO SWIPE GESTURES (navigates).
 *
 * Camera (`expo-camera`) is the device-only final-pass acceptance — it is loaded
 * lazily and not exercised here.
 */

// Native pickers / compressor → controllable mocks (the AC's mocked modules).
const pickerController = {
  imageAssets: [] as unknown[],
  documentAssets: [] as unknown[],
  imageCanceled: false,
  documentCanceled: false,
  launchCalls: 0,
  documentCalls: 0,
};
const manipulatorController = { manipulateCalls: 0, saveCalls: 0, resizeCalls: 0 };

// uploadAttachment appends the multipart part via appendFormDataFile, which
// lazy-requires expo-file-system (winter-fetch part) — in-memory mock.
jest.mock('expo-file-system', () =>
  require('../src/test/mockExpoFileSystem').createExpoFileSystemMock()
);

// AttachmentBar consumes useAppTheme → themeStore → MMKV. Mock it (in-memory).
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

jest.mock('expo-image-picker', () => ({
  __esModule: true,
  launchImageLibraryAsync: jest.fn(async () => {
    pickerController.launchCalls += 1;
    return pickerController.imageCanceled
      ? { canceled: true, assets: null }
      : { canceled: false, assets: pickerController.imageAssets };
  }),
}));

jest.mock('expo-document-picker', () => ({
  __esModule: true,
  getDocumentAsync: jest.fn(async () => {
    pickerController.documentCalls += 1;
    return pickerController.documentCanceled
      ? { canceled: true, assets: null }
      : { canceled: false, assets: pickerController.documentAssets };
  }),
}));

jest.mock('expo-image-manipulator', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- self-referential chainable mock.
  const context: any = {
    resize: jest.fn(() => {
      manipulatorController.resizeCalls += 1;
      return context;
    }),
    renderAsync: jest.fn(async () => ({
      saveAsync: jest.fn(async () => {
        manipulatorController.saveCalls += 1;
        return { uri: 'file:///compressed.jpg', width: 2048, height: 1536 };
      }),
    })),
  };
  return {
    __esModule: true,
    ImageManipulator: {
      manipulate: jest.fn(() => {
        manipulatorController.manipulateCalls += 1;
        return context;
      }),
    },
    SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
  };
});

// NetInfo must never load under Jest (ApiProvider injects a stub).
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

// In-memory keychain for expo-secure-store (sandbox URL + authToken live here).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    getItemAsync: async (k: string) => (store.has(k) ? store.get(k)! : null),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useRef } from 'react';
import { Alert, Platform, Pressable, Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { AttachmentBar, type AttachmentBarHandle } from '../src/features/chat/attachments';
import type { UploadedAttachment } from '../src/features/chat/attachments';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

const secureStore = (jest.requireMock('expo-secure-store') as { __store: Map<string, string> })
  .__store;

const SANDBOX_BASE = 'https://sandbox.portable.test';
const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const onlineNetInfo: NetInfoLike = { addEventListener: () => () => {} };

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

/** A large library image asset (> 5 MB, > 2048px → triggers compression + resize). */
function largeImageAsset(i: number) {
  return {
    uri: `file:///photo-${i}.jpg`,
    fileName: `photo-${i}.jpg`,
    mimeType: 'image/jpeg',
    width: 4032,
    height: 3024,
    fileSize: 8 * 1024 * 1024,
  };
}

describe('file/image upload + gallery + swipe', () => {
  let gateway: MockGateway;
  let qc: QueryClient;
  let uploadHits = 0;

  beforeEach(() => {
    pickerController.imageAssets = [];
    pickerController.documentAssets = [];
    pickerController.imageCanceled = false;
    pickerController.documentCanceled = false;
    pickerController.launchCalls = 0;
    pickerController.documentCalls = 0;
    manipulatorController.manipulateCalls = 0;
    manipulatorController.saveCalls = 0;
    manipulatorController.resizeCalls = 0;
    uploadHits = 0;

    secureStore.clear();
    secureStore.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.set(AUTH_TOKEN_KEY, 'authtoken-abc');

    gateway = createMockGateway();
    gateway.on('POST', `${SANDBOX_BASE}/api/upload`, () => {
      uploadHits += 1;
      const n = uploadHits;
      return {
        body: {
          fileName: `srv-${n}.jpg`,
          originalName: `photo-${n}.jpg`,
          path: `uploads/srv-${n}.jpg`,
          absolutePath: `/workspace/uploads/srv-${n}.jpg`,
          mimeType: 'image/jpeg',
          size: 1234,
        },
      };
    });

    qc = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    qc.clear();
    onlineManager.setOnline(true);
    jest.restoreAllMocks();
  });

  // The "+" trigger now lives in the composer, opening the source
  // sheet through AttachmentBar's imperative handle. This harness reproduces that
  // wiring so the test can still drive the flow from an `attach-button`.
  function AttachmentHarness({ onChange }: { onChange?: (u: UploadedAttachment[]) => void }) {
    const ref = useRef<AttachmentBarHandle>(null);
    return (
      <>
        <Pressable testID="attach-button" onPress={() => ref.current?.openSourceSheet()}>
          <Text>+</Text>
        </Pressable>
        <AttachmentBar ref={ref} onChange={onChange} />
      </>
    );
  }

  function mount(onChange?: (u: UploadedAttachment[]) => void) {
    const client = buildClient(gateway);
    render(
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
          <ApiProvider client={client} queryClient={qc} netInfo={onlineNetInfo}>
            <AttachmentHarness onChange={onChange} />
          </ApiProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  it('compresses a picked image, POSTs multipart to /api/upload, and shows it in the message', async () => {
    pickerController.imageAssets = [largeImageAsset(1)];
    const onChange = jest.fn();
    mount(onChange);

    // Open the source sheet → pick from the photo library.
    // The Modal is always-mounted in React (visible prop governs UIKit, not mount/unmount),
    // but RNTL excludes visible=false Modals from query results. Capture onDismiss while
    // the sheet is open so we keep the reference after pressing closes it.
    fireEvent.press(screen.getByTestId('attach-button'));
    const onDismissLib = screen.getByTestId('attach-source-sheet').props.onDismiss;
    await act(async () => {
      fireEvent.press(screen.getByTestId('attach-source-library'));
    });
    // Simulate UIKit completing the dismiss animation — triggers the deferred picker.
    await act(async () => {
      await onDismissLib?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The picker was invoked and the image was compressed (manipulator + resize).
    expect(pickerController.launchCalls).toBe(1);
    expect(manipulatorController.manipulateCalls).toBe(1);
    expect(manipulatorController.resizeCalls).toBe(1);
    expect(manipulatorController.saveCalls).toBe(1);

    // It uploaded once, multipart, to the sandbox /api/upload (Bearer + no cookies).
    await waitFor(() => expect(uploadHits).toBe(1));
    const req = gateway.requests.find(
      (r) => r.method === 'POST' && r.url === `${SANDBOX_BASE}/api/upload`
    );
    expect(req).toBeTruthy();
    const authHeader = req!.headers.Authorization ?? req!.headers.authorization;
    expect(authHeader).toBe('Bearer authtoken-abc');
    expect(req!.credentials).toBe('omit');
    const form = req!.rawBody as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.has('file')).toBe(true);

    // The uploaded attachment appears in the message (a thumbnail + onChange fired).
    await waitFor(() => {
      const last = onChange.mock.calls.at(-1)?.[0] as UploadedAttachment[] | undefined;
      expect(last?.length).toBe(1);
    });
    const uploaded = onChange.mock.calls.at(-1)![0] as UploadedAttachment[];
    expect(uploaded[0].response.path).toBe('uploads/srv-1.jpg');
    expect(screen.getByTestId(`attachment-item-${uploaded[0].id}`)).toBeTruthy();
  });

  it('opens the gallery and responds to swipe gestures', async () => {
    pickerController.imageAssets = [largeImageAsset(1), largeImageAsset(2)];
    const onChange = jest.fn();
    mount(onChange);

    // Capture onDismiss before pressing: RNTL excludes visible=false Modals from
    // query results even though the Modal is always-mounted in React.
    fireEvent.press(screen.getByTestId('attach-button'));
    const onDismissGallery = screen.getByTestId('attach-source-sheet').props.onDismiss;
    await act(async () => {
      fireEvent.press(screen.getByTestId('attach-source-library'));
    });
    await act(async () => {
      await onDismissGallery?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      const last = onChange.mock.calls.at(-1)?.[0] as UploadedAttachment[] | undefined;
      expect(last?.length).toBe(2);
    });
    const uploaded = onChange.mock.calls.at(-1)![0] as UploadedAttachment[];

    // Open the gallery on the first image.
    fireEvent.press(screen.getByTestId(`attachment-open-${uploaded[0].id}`));
    expect(screen.getByTestId('image-gallery-modal')).toBeTruthy();
    expect(screen.getByTestId('gallery-index').props.children).toEqual([1, ' / ', 2]);

    // Swipe LEFT → advance to the next image.
    await act(async () => {
      fireGestureHandler(getByGestureTestId('gallery-pan'), [
        { state: State.BEGAN, translationX: 0, translationY: 0 },
        { state: State.ACTIVE, translationX: -40, translationY: 0 },
        { state: State.ACTIVE, translationX: -120, translationY: 0 },
        { state: State.END, translationX: -120, translationY: 0 },
      ]);
    });
    expect(screen.getByTestId('gallery-index').props.children).toEqual([2, ' / ', 2]);

    // Swipe RIGHT → back to the first image.
    await act(async () => {
      fireGestureHandler(getByGestureTestId('gallery-pan'), [
        { state: State.BEGAN, translationX: 0, translationY: 0 },
        { state: State.ACTIVE, translationX: 40, translationY: 0 },
        { state: State.ACTIVE, translationX: 120, translationY: 0 },
        { state: State.END, translationX: 120, translationY: 0 },
      ]);
    });
    expect(screen.getByTestId('gallery-index').props.children).toEqual([1, ' / ', 2]);
  });

  it('uploads a picked document without compressing it', async () => {
    pickerController.documentAssets = [
      { uri: 'file:///doc.pdf', name: 'doc.pdf', mimeType: 'application/pdf', size: 2048 },
    ];
    const onChange = jest.fn();
    mount(onChange);

    // Capture onDismiss before pressing: RNTL excludes visible=false Modals from
    // query results even though the Modal is always-mounted in React.
    fireEvent.press(screen.getByTestId('attach-button'));
    const onDismissDoc = screen.getByTestId('attach-source-sheet').props.onDismiss;
    await act(async () => {
      fireEvent.press(screen.getByTestId('attach-source-document'));
    });
    await act(async () => {
      await onDismissDoc?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pickerController.documentCalls).toBe(1);
    // A PDF is NOT an image → no compression.
    expect(manipulatorController.manipulateCalls).toBe(0);
    await waitFor(() => expect(uploadHits).toBe(1));
    const req = gateway.requests.find((r) => r.url === `${SANDBOX_BASE}/api/upload`);
    expect((req!.rawBody as FormData).has('file')).toBe(true);
  });

  it('defers Library picker launch until source-sheet onDismiss fires (ordering guard)', async () => {
    // Regression guard (Photo Library / Files tap → picker never opens on iOS).
    // Root cause: pick() called setSheetOpen(false) then await action() in the SAME tick;
    // iOS UIKit refuses to present a native VC while a JS <Modal> is still dismissing.
    // Fix: store the action as a pending ref, close the sheet, and invoke from onDismiss.
    pickerController.imageAssets = [largeImageAsset(1)];
    mount();

    // Open the source sheet. Capture onDismiss first — RNTL excludes visible=false
    // Modals from query results even though the Modal stays mounted in React.
    fireEvent.press(screen.getByTestId('attach-button'));
    const onDismissOrdering = screen.getByTestId('attach-source-sheet').props.onDismiss;

    // Press Library and flush microtasks. Pre-fix: picker fires synchronously here
    // (launchCalls → 1). Post-fix: pick() stores a pending ref + sets sheetOpen=false;
    // picker has NOT been called yet.
    await act(async () => {
      fireEvent.press(screen.getByTestId('attach-source-library'));
      await Promise.resolve();
      await Promise.resolve();
    });

    // BEFORE FIX: launchCalls === 1 → fails here (ordering bug confirmed).
    // AFTER FIX:  launchCalls === 0; picker is waiting for the dismiss callback.
    expect(pickerController.launchCalls).toBe(0);

    // Simulate UIKit completing the dismiss animation (onDismiss fires on device).
    await act(async () => {
      await onDismissOrdering?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    // After dismiss: the deferred picker must have been launched exactly once.
    expect(pickerController.launchCalls).toBe(1);
  });

  it('launches Library picker immediately on Android (no onDismiss gate)', async () => {
    // On Android, onDismiss is not reliably fired, so pick() must launch the picker
    // directly (same tick as setSheetOpen(false)). Gate verified by mocking Platform.OS.
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    pickerController.imageAssets = [largeImageAsset(1)];
    mount();

    fireEvent.press(screen.getByTestId('attach-button'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('attach-source-library'));
      await Promise.resolve();
      await Promise.resolve();
    });

    // On Android: picker fires immediately — no onDismiss required.
    expect(pickerController.launchCalls).toBe(1);

    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  });

  it('surfaces a picker launch error via Alert when the native picker throws', async () => {
    // Verifies that picker errors are shown to the user instead of swallowed.
    // jest-expo defaults Platform.OS to 'ios', so this exercises the onDismiss path.
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { launchImageLibraryAsync } = jest.requireMock('expo-image-picker') as {
      launchImageLibraryAsync: jest.Mock;
    };
    launchImageLibraryAsync.mockImplementationOnce(async () => {
      throw new Error('permission denied');
    });
    mount();

    // Capture before pressing: RNTL excludes visible=false Modals from query results.
    fireEvent.press(screen.getByTestId('attach-button'));
    const onDismissErr = screen.getByTestId('attach-source-sheet').props.onDismiss;
    await act(async () => {
      fireEvent.press(screen.getByTestId('attach-source-library'));
    });
    await act(async () => {
      await onDismissErr?.();
      await Promise.resolve();
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      'Attachment error',
      'Could not open picker. Please try again.'
    );
  });
});
