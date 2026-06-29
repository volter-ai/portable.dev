/**
 * ViewModel for the device-permissions settings page. Owns the per-type live
 * status (checked on EVERY mount — OS state, never persisted) and the request
 * flow. Both I/O seams are injectable (`checkStatus` / `requestPermission`,
 * defaulting to the real lazy-native adapters in `devicePermissions.ts`), so
 * the hook and its tests run with no native module.
 *
 * Geolocation is deliberately OUTSIDE this hook's surface: the seams take
 * `ActiveDevicePermissionType` only, so the "Future Permissions" card can
 * never trigger a status fetch (`enabled=false` cards skip the mount check).
 */

import { useCallback, useEffect, useState } from 'react';

import {
  ACTIVE_PERMISSION_TYPES,
  checkStatus as defaultCheckStatus,
  requestPermission as defaultRequestPermission,
  type ActiveDevicePermissionType,
  type DevicePermissionResult,
  type DevicePermissionStatus,
} from './devicePermissions';

export type PermissionChecker = (
  type: ActiveDevicePermissionType
) => Promise<DevicePermissionResult>;

export interface PermissionsViewModelDeps {
  /** Status reader (default: the real `devicePermissions.checkStatus`). */
  checkStatus?: PermissionChecker;
  /** OS prompt trigger (default: the real `devicePermissions.requestPermission`). */
  requestPermission?: PermissionChecker;
}

/** `null` = still checking (the card's initial "Checking..." state). */
export type PermissionStatusMap = Record<ActiveDevicePermissionType, DevicePermissionStatus | null>;

export interface PermissionsViewModel {
  /** Live per-type status; `null` while the mount check is in flight. */
  statuses: PermissionStatusMap;
  /** The type whose OS prompt is currently open (disables its button). */
  requesting: ActiveDevicePermissionType | null;
  /** Show the OS permission prompt and fold the result into `statuses`. */
  request: (type: ActiveDevicePermissionType) => Promise<void>;
}

const INITIAL_STATUSES: PermissionStatusMap = {
  notifications: null,
  camera: null,
  microphone: null,
};

export function usePermissionsViewModel(deps: PermissionsViewModelDeps = {}): PermissionsViewModel {
  const check = deps.checkStatus ?? defaultCheckStatus;
  const requestImpl = deps.requestPermission ?? defaultRequestPermission;

  const [statuses, setStatuses] = useState<PermissionStatusMap>(INITIAL_STATUSES);
  const [requesting, setRequesting] = useState<ActiveDevicePermissionType | null>(null);

  // Re-check on every mount (permissions are OS state, no cache).
  useEffect(() => {
    let cancelled = false;
    for (const type of ACTIVE_PERMISSION_TYPES) {
      check(type)
        .then((result) => {
          if (!cancelled) setStatuses((prev) => ({ ...prev, [type]: result.status }));
        })
        .catch(() => {
          // A failed read degrades to "not requested" (fallback-to-prompt).
          if (!cancelled) setStatuses((prev) => ({ ...prev, [type]: 'prompt' }));
        });
    }
    return () => {
      cancelled = true;
    };
    // Mount-only by design; the injected seam is stable for a mounted screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const request = useCallback(
    async (type: ActiveDevicePermissionType) => {
      setRequesting(type);
      try {
        const result = await requestImpl(type);
        setStatuses((prev) => ({ ...prev, [type]: result.status }));
      } catch {
        // Keep the prior status — the card logs and stays put on errors.
      } finally {
        setRequesting(null);
      }
    },
    [requestImpl]
  );

  return { statuses, requesting, request };
}
