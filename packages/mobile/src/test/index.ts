/**
 * `src/test` — the `packages/mobile` integration-test harness.
 *
 * The foundation every other mobile story's integration tests build on. Two
 * reusable mocking layers, each interposing at the boundary the real client
 * uses, so a screen can be mounted with React Native Testing Library and driven
 * end-to-end with no device, no Metro, and no network:
 *
 *   - {@link createMockGateway} — HTTP mocking for the Portable gateway
 *     (injectable `fetchImpl` + optional `global.fetch` install). Ships typed
 *     defaults for the `/auth/mobile/react-native/*` routes.
 *   - {@link createSocketIoMock} / {@link createMockSocket} — Socket.IO mocking
 *     for the shared transport core (`@vgit2/shared/socket`), able to drive
 *     server→client events and record client→server emissions.
 *
 * See `__tests__/harness-integration.test.tsx` for a sample that mounts a
 * component and asserts a mocked gateway HTTP response and a mocked Socket.IO
 * event are both observed.
 */

export {
  createMockGateway,
  registerRnDefaults,
  type MockGateway,
  type MockGatewayHandler,
  type MockGatewayOptions,
  type MockGatewayRequest,
  type MockGatewayResponseSpec,
} from './mockGateway';

export {
  createMockSocket,
  createSocketIoMock,
  type MockSocketController,
  type MockSocketIoModule,
  type MockSocketOptions,
  type RecordedEmission,
} from './mockSocket';

export {
  createExpoAudioMock,
  type ExpoAudioMockController,
  type ExpoAudioMockModule,
  type ExpoAudioMockRecorder,
} from './mockExpoAudio';

export { createExpoFileSystemMock, type ExpoFileSystemMockModule } from './mockExpoFileSystem';

export { buildCafFixture, type CafFixtureOptions } from './cafFixture';

export {
  mmkvMockFactory,
  secureStoreMockFactory,
  netInfoMockFactory,
  clipboardMockFactory,
  webBrowserMockFactory,
  markdownDisplayMockFactory,
  pdfMockFactory,
  expoVideoMockFactory,
  expoAudioSimpleMockFactory,
} from './nativeMocks';
