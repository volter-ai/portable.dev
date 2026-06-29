/**
 * Picks the per-platform {@link ActivityBackend}. iOS → the Live
 * Activity backend; every other platform (Android / web / unknown) → a silent
 * no-op.
 *
 * The Android ongoing-notification backend was REMOVED. It re-rendered
 * the notification every second to tick the elapsed counter, which spammed the
 * phone with constant "Running a command"/"Editing files" notifications +
 * vibration during long runs (most visibly during project creation). iOS is
 * unaffected: the Live Activity renders its elapsed timer NATIVELY in the widget,
 * so JS never pushes a per-second update. There is intentionally no Android
 * indicator and no fallback between platforms.
 */

import { Platform } from 'react-native';

import { createIosLiveActivityBackend } from './iosLiveActivity';
import type { ActivityBackend } from './types';

/** A backend that does nothing — used on every platform without an indicator. */
export const noopActivityBackend: ActivityBackend = {
  start() {},
  update() {},
  stop() {},
};

export function resolveActivityBackend(os: string = Platform.OS): ActivityBackend {
  if (os === 'ios') return createIosLiveActivityBackend();
  return noopActivityBackend;
}
