/**
 * Version-update feature — the cold-start update-available prompt (#1522).
 *
 * Checks the app version against the gateway's public `GET /api/min-version-v2`
 * and, when the app is behind on major.minor, overlays a DISMISSIBLE
 * "Update available" card (Update → platform store, Later → 24h snooze persisted
 * in MMKV) over the fully-usable app — never a hard block. Mounted as the
 * OUTERMOST gate by the app shell (`AppShell`), ahead of the
 * startup/onboarding/provisioning gates.
 */

export { VersionGate, type VersionGateProps } from './VersionGate';
export {
  UpdateAvailableCard,
  type UpdateAvailableCardProps,
  APP_STORE_URL,
  PLAY_STORE_URL,
} from './UpdateAvailableCard';
export {
  shouldShowUpdatePrompt,
  useUpdatePromptStore,
  UPDATE_PROMPT_PERSIST_KEY,
  UPDATE_PROMPT_SNOOZE_MS,
  type UpdatePromptState,
} from './updatePromptStore';
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
