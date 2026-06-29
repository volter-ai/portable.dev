/**
 * Version-update feature — the cold-start force-update gate.
 *
 * Checks the app version against the gateway's public `GET /api/min-version-v2`
 * and blocks with an "update required" screen
 * when the app is behind on major.minor. Mounted as the OUTERMOST gate by the
 * app shell (`AppShell`), ahead of the startup/onboarding/provisioning gates.
 */

export { VersionGate, type VersionGateProps } from './VersionGate';
export {
  UpdateRequiredScreen,
  type UpdateRequiredScreenProps,
  APP_STORE_URL,
  PLAY_STORE_URL,
} from './UpdateRequiredScreen';
export {
  useVersionGate,
  getCurrentAppVersion,
  type VersionGateDeps,
  type VersionGateStatus,
} from './useVersionGate';
export {
  meetsMinimumVersion,
  runVersionGate,
  type VersionGateVerdict,
  type RunVersionGateDeps,
} from './versionCheck';
