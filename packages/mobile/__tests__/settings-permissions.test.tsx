/**
 * Settings → Permissions (`/settings/permissions`) — the device-permissions
 * page (web `PermissionsSection` parity). No HTTP / ApiProvider: the page is
 * purely OS-permission state, driven through the injectable
 * `checkStatus`/`requestPermission` seams (the real lazy-native adapters in
 * `devicePermissions.ts` are NEVER loaded here). Asserts:
 *   1. live statuses render per type after the mount check (incl. the
 *      "Checking..." initial state),
 *   2. the request flow flips prompt → granted,
 *   3. denied shows platform instructions + the Open Settings seam,
 *   4. geolocation renders the disabled "Coming soon" card and its checker is
 *      NEVER called.
 */

// ── Hoisted mocks (must precede the SUT import) ──────────────────────────────

// PermissionsScreen consumes useAppTheme → themeStore → MMKV. Mock it (in-memory).
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

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type {
  ActiveDevicePermissionType,
  DevicePermissionResult,
  DevicePermissionStatus,
} from '../src/features/settings/sections/permissions/devicePermissions';
import { PermissionsScreen } from '../src/features/settings/sections/permissions/PermissionsScreen';

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

type StatusFixture = Record<ActiveDevicePermissionType, DevicePermissionStatus>;

interface RenderOpts {
  statuses?: Partial<StatusFixture>;
  checkStatus?: jest.Mock;
  requestPermission?: jest.Mock;
  openSettings?: jest.Mock;
  instructions?: string;
}

function makeCheckStatus(statuses: Partial<StatusFixture>): jest.Mock {
  return jest.fn(
    async (type: ActiveDevicePermissionType): Promise<DevicePermissionResult> => ({
      status: statuses[type] ?? 'prompt',
    })
  );
}

function renderPermissions(opts: RenderOpts = {}) {
  const checkStatus = opts.checkStatus ?? makeCheckStatus(opts.statuses ?? {});
  const requestPermission =
    opts.requestPermission ??
    jest.fn(async (): Promise<DevicePermissionResult> => ({ status: 'granted' }));
  const openSettings = opts.openSettings ?? jest.fn();

  render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <PermissionsScreen
        checkStatus={checkStatus}
        requestPermission={requestPermission}
        openSettings={openSettings}
        instructions={opts.instructions}
        onBack={jest.fn()}
      />
    </SafeAreaProvider>
  );
  return { checkStatus, requestPermission, openSettings };
}

/** Flush the ViewModel's mount-check promises. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('settings permissions — device permissions page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the live status badge per type after the mount check', async () => {
    // Deferred checks so the initial "Checking..." state is deterministic.
    const resolvers = new Map<ActiveDevicePermissionType, (r: DevicePermissionResult) => void>();
    const checkStatus = jest.fn(
      (type: ActiveDevicePermissionType) =>
        new Promise<DevicePermissionResult>((resolve) => resolvers.set(type, resolve))
    ) as jest.Mock;

    renderPermissions({ checkStatus });

    // All three active cards are present and show the checking state.
    for (const type of ['notifications', 'camera', 'microphone'] as const) {
      expect(screen.getByTestId(`settings-permissions-card-${type}`)).toBeTruthy();
      expect(screen.getByTestId(`settings-permissions-status-${type}`)).toHaveTextContent(
        'Checking...'
      );
    }

    await act(async () => {
      resolvers.get('notifications')!({ status: 'granted' });
      resolvers.get('camera')!({ status: 'prompt' });
      resolvers.get('microphone')!({ status: 'denied' });
      await Promise.resolve();
    });

    expect(screen.getByTestId('settings-permissions-status-notifications')).toHaveTextContent(
      'Granted'
    );
    expect(screen.getByTestId('settings-permissions-status-camera')).toHaveTextContent(
      'Not requested'
    );
    expect(screen.getByTestId('settings-permissions-status-microphone')).toHaveTextContent(
      'Denied'
    );

    // Exactly one mount check per ACTIVE type — and never for geolocation.
    expect(checkStatus).toHaveBeenCalledTimes(3);
    expect(checkStatus.mock.calls.map(([t]) => t).sort()).toEqual([
      'camera',
      'microphone',
      'notifications',
    ]);
  });

  it('granted type shows the green granted badge (no request button)', async () => {
    renderPermissions({
      statuses: { notifications: 'granted', camera: 'granted', microphone: 'granted' },
    });
    await flush();

    // Regex: the badge text is glyph-prefixed ('✓ Permission Granted') — the
    // documented RNTL bare-string strictness gotcha.
    expect(screen.getByTestId('settings-permissions-granted-notifications')).toHaveTextContent(
      /Permission Granted/
    );
    expect(screen.queryByTestId('settings-permissions-request-notifications')).toBeNull();
  });

  it('request flow flips prompt → granted on the pressed card', async () => {
    const { requestPermission } = renderPermissions({
      statuses: { notifications: 'granted', camera: 'prompt', microphone: 'granted' },
    });
    await flush();

    // Prompt state: "Not requested" badge + Request button + blocked features.
    expect(screen.getByTestId('settings-permissions-status-camera')).toHaveTextContent(
      'Not requested'
    );
    const requestButton = screen.getByTestId('settings-permissions-request-camera');
    expect(requestButton).toHaveTextContent('Request Permission');

    await act(async () => {
      fireEvent.press(requestButton);
    });

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission).toHaveBeenCalledWith('camera');
    await waitFor(() =>
      expect(screen.getByTestId('settings-permissions-status-camera')).toHaveTextContent('Granted')
    );
    expect(screen.getByTestId('settings-permissions-granted-camera')).toBeTruthy();
    expect(screen.queryByTestId('settings-permissions-request-camera')).toBeNull();
  });

  it('denied type shows platform instructions and Open Settings fires the seam', async () => {
    const { openSettings } = renderPermissions({
      statuses: { notifications: 'granted', camera: 'granted', microphone: 'denied' },
      instructions: 'Open Settings → Portable → enable the permission',
    });
    await flush();

    expect(screen.getByTestId('settings-permissions-status-microphone')).toHaveTextContent(
      'Denied'
    );
    expect(screen.getByTestId('settings-permissions-instructions-microphone')).toHaveTextContent(
      'Open Settings → Portable → enable the permission'
    );
    // Denied = settings-only: no request button.
    expect(screen.queryByTestId('settings-permissions-request-microphone')).toBeNull();

    fireEvent.press(screen.getByTestId('settings-permissions-open-settings-microphone'));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('non-granted card lists its blocked features (web parity note)', async () => {
    renderPermissions({
      statuses: { notifications: 'prompt', camera: 'granted', microphone: 'granted' },
    });
    await flush();

    const card = screen.getByTestId('settings-permissions-card-notifications');
    expect(card).toHaveTextContent(/Features Requiring Permission:/);
    expect(card).toHaveTextContent(/Task completion alerts/);
    // Granted cards do NOT render the blocked-features note.
    expect(screen.getByTestId('settings-permissions-card-camera')).not.toHaveTextContent(
      /Features Requiring Permission:/
    );
  });

  it('geolocation renders the disabled Coming-soon card and its checker is NEVER called', async () => {
    const { checkStatus, requestPermission } = renderPermissions({
      statuses: { notifications: 'granted', camera: 'granted', microphone: 'granted' },
    });
    await flush();

    const card = screen.getByTestId('settings-permissions-card-geolocation');
    expect(card).toHaveTextContent(/Location/);
    expect(screen.getByTestId('settings-permissions-coming-soon-geolocation')).toHaveTextContent(
      'Coming soon - not yet implemented'
    );

    // No live status / actions for the future card.
    expect(screen.queryByTestId('settings-permissions-status-geolocation')).toBeNull();
    expect(screen.queryByTestId('settings-permissions-request-geolocation')).toBeNull();

    // The seams were never invoked for geolocation.
    expect(checkStatus.mock.calls.every(([t]) => t !== 'geolocation')).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
