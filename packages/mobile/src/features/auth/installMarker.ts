/**
 * Fresh-install detection.
 *
 * iOS Keychain (expo-secure-store) SURVIVES app uninstall/reinstall, but MMKV
 * does not. After a reinstall the app can therefore boot holding a PREVIOUS
 * install's credentials — e.g. a dev-mode session: the `portable.devMode`
 * MMKV flag is gone (app boots in prod) while the dev environment's authToken /
 * sandbox URL / identity are still in the Keychain. That cross-environment mix
 * wedges provisioning (the prod gateway answers the SSE with its SPA HTML and
 * the watch used to hang forever).
 *
 * The marker is a plain MMKV flag written on the first startup-gate run of an
 * install: marker absent ⇒ this process is the first run of a FRESH install, so
 * any Keychain credentials it finds belong to a previous install and must be
 * wiped before anything trusts them.
 *
 * MMKV access follows the `devModeStore` lazy-require pattern (this module sits
 * in the startup-gate graph): an environment where MMKV is unavailable degrades
 * to "marker present" — we NEVER wipe credentials when we cannot know.
 */

/** MMKV key marking that this install has launched at least once. */
export const INSTALL_MARKER_KEY = 'portable.installMarker';

/** Whether this install has launched before (fail-safe: `true` when unknowable). */
export function hasInstallMarker(): boolean {
  try {
    // Lazy require — never pull react-native-mmkv into the static import graph.
    const { getMmkv } = require('../state/storage') as typeof import('../state/storage');
    return getMmkv().getString(INSTALL_MARKER_KEY) === 'true';
  } catch {
    return true;
  }
}

/** Record that this install has launched (idempotent). */
export function writeInstallMarker(): void {
  try {
    const { getMmkv } = require('../state/storage') as typeof import('../state/storage');
    getMmkv().set(INSTALL_MARKER_KEY, 'true');
  } catch {
    // MMKV unavailable — the next launch simply re-runs the check.
  }
}
