/**
 * Controllable `expo-audio` mock for the voice-input integration tests.
 *
 * `expo-audio` is a native module — under jest-expo it would try to load the JSI
 * `AudioModule`. This mock replaces it with a deterministic in-memory recorder whose
 * permission result + produced file URI are scriptable, and whose metering status
 * listener can be driven from the test (`__controller.emitMetering`) to exercise the
 * waveform visualizer. Mirrors the `createSocketIoMock` / `createMockGateway` harness
 * pattern (expose a `__controller` read via `jest.requireMock`).
 *
 * Usage:
 *   jest.mock('expo-audio', () => require('../src/test/mockExpoAudio').createExpoAudioMock());
 *   const audio = jest.requireMock('expo-audio') as ExpoAudioMockModule;
 *   audio.__controller.permissionGranted = true;
 *   audio.__controller.recordedUri = 'file:///rec.m4a';
 *   act(() => audio.__controller.emitMetering(-8)); // drives the waveform level
 */

export interface ExpoAudioMockRecorder {
  readonly uri: string | null;
  readonly isRecording: boolean;
  prepareToRecordAsync(options?: unknown): Promise<void>;
  record(options?: unknown): void;
  stop(): Promise<void>;
  getStatus(): {
    isRecording: boolean;
    metering?: number;
    durationMillis: number;
    url: string | null;
  };
}

export interface ExpoAudioMockController {
  /** Result of the next permission request. */
  permissionGranted: boolean;
  /** URI the recorder resolves after `stop()`. */
  recordedUri: string | null;
  /** Current metering value surfaced via `useAudioRecorderState`. */
  metering: number | undefined;
  /**
   * Make the next N `prepareToRecordAsync` calls throw (scripts the device
   * rejecting the recording options — drives the fallback path).
   */
  prepareFailuresRemaining: number;
  /** The options each `prepareToRecordAsync` call received (`null` = no-arg). */
  prepareOptions: unknown[];
  /** Call counters for assertions. */
  permissionRequests: number;
  prepareCalls: number;
  recordCalls: number;
  stopCalls: number;
  setAudioModeCalls: number;
  /** Set the metering value and re-render any mounted `useAudioRecorderState` (→ waveform). */
  emitMetering(metering: number): void;
  reset(): void;
}

export interface ExpoAudioMockModule {
  __controller: ExpoAudioMockController;
  useAudioRecorder(
    options: unknown,
    statusListener?: (status: { metering?: number; isRecording?: boolean }) => void
  ): ExpoAudioMockRecorder;
  useAudioRecorderState(recorder: ExpoAudioMockRecorder, interval?: number): unknown;
  requestRecordingPermissionsAsync(): Promise<{
    granted: boolean;
    status: string;
    canAskAgain: boolean;
  }>;
  getRecordingPermissionsAsync(): Promise<{
    granted: boolean;
    status: string;
    canAskAgain: boolean;
  }>;
  setAudioModeAsync(mode: unknown): Promise<void>;
  RecordingPresets: { HIGH_QUALITY: Record<string, unknown>; LOW_QUALITY: Record<string, unknown> };
  PermissionStatus: { GRANTED: string; DENIED: string; UNDETERMINED: string };
  /** Enum values consumed by `recordingStrategy.ts` — mirror expo-audio. */
  IOSOutputFormat: { MPEG4AAC: string; LINEARPCM: string };
  AudioQuality: { MIN: number; LOW: number; MEDIUM: number; HIGH: number; MAX: number };
}

export function createExpoAudioMock(): ExpoAudioMockModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- jest mock factory can't use ESM import.
  const React = require('react') as typeof import('react');
  let recording = false;
  const stateListeners = new Set<() => void>();

  const controller: ExpoAudioMockController = {
    permissionGranted: true,
    recordedUri: 'file:///mock-recording.m4a',
    metering: undefined,
    prepareFailuresRemaining: 0,
    prepareOptions: [],
    permissionRequests: 0,
    prepareCalls: 0,
    recordCalls: 0,
    stopCalls: 0,
    setAudioModeCalls: 0,
    emitMetering(metering: number) {
      controller.metering = metering;
      stateListeners.forEach((l) => l());
    },
    reset() {
      recording = false;
      controller.permissionGranted = true;
      controller.recordedUri = 'file:///mock-recording.m4a';
      controller.metering = undefined;
      controller.prepareFailuresRemaining = 0;
      controller.prepareOptions = [];
      controller.permissionRequests = 0;
      controller.prepareCalls = 0;
      controller.recordCalls = 0;
      controller.stopCalls = 0;
      controller.setAudioModeCalls = 0;
    },
  };

  // A single stable recorder instance (faithful to expo-audio, where useAudioRecorder
  // returns a stable AudioRecorder across renders).
  const recorder: ExpoAudioMockRecorder = {
    get uri() {
      return controller.recordedUri;
    },
    get isRecording() {
      return recording;
    },
    async prepareToRecordAsync(options?: unknown) {
      controller.prepareCalls += 1;
      controller.prepareOptions.push(options ?? null);
      if (controller.prepareFailuresRemaining > 0) {
        controller.prepareFailuresRemaining -= 1;
        throw new Error('Failed to create recorder: mock device rejected the options');
      }
    },
    record() {
      controller.recordCalls += 1;
      recording = true;
      stateListeners.forEach((l) => l());
    },
    async stop() {
      controller.stopCalls += 1;
      recording = false;
      stateListeners.forEach((l) => l());
    },
    getStatus() {
      return { isRecording: recording, durationMillis: 0, url: controller.recordedUri };
    },
  };

  return {
    __controller: controller,
    useAudioRecorder() {
      return recorder;
    },
    useAudioRecorderState() {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        const listener = () => force((n) => n + 1);
        stateListeners.add(listener);
        return () => void stateListeners.delete(listener);
      }, []);
      return {
        canRecord: true,
        isRecording: recording,
        durationMillis: 0,
        mediaServicesDidReset: false,
        metering: controller.metering,
        url: controller.recordedUri,
      };
    },
    async requestRecordingPermissionsAsync() {
      controller.permissionRequests += 1;
      return {
        granted: controller.permissionGranted,
        status: controller.permissionGranted ? 'granted' : 'denied',
        canAskAgain: true,
      };
    },
    async getRecordingPermissionsAsync() {
      return {
        granted: controller.permissionGranted,
        status: controller.permissionGranted ? 'granted' : 'denied',
        canAskAgain: true,
      };
    },
    async setAudioModeAsync() {
      controller.setAudioModeCalls += 1;
    },
    RecordingPresets: { HIGH_QUALITY: {}, LOW_QUALITY: {} },
    PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
    IOSOutputFormat: { MPEG4AAC: 'aac ', LINEARPCM: 'lpcm' },
    AudioQuality: { MIN: 0, LOW: 32, MEDIUM: 64, HIGH: 96, MAX: 127 },
  };
}
