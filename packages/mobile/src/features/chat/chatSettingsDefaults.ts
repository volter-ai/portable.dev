/**
 * Per-chat settings defaults + resolution.
 *
 * The defaults a NEW chat gets when no server-side record exists yet — the
 * canonical new-chat fallbacks reproduced below.
 *
 * Resolution precedence (lowest → highest): defaults → server-persisted →
 * local Zustand override (the user's optimistic in-app change wins until synced).
 */

import { DEFAULT_MODEL_MODE } from '@vgit2/shared/models';
import type { ChatSettings } from '../state';

/**
 * New-chat defaults:
 *   model = DEFAULT_MODEL_MODE ('opus'), permissions = 'bypass_permissions',
 *   agentSetupId = 'freestyle' (the unopinionated direct-execution agent).
 */
export const NEW_CHAT_SETTINGS: Required<ChatSettings> = {
  model: DEFAULT_MODEL_MODE,
  permissions: 'bypass_permissions',
  agentSetupId: 'freestyle',
};

/** Drop `undefined` keys so a partial source never clobbers a lower layer. */
function defined(settings?: Partial<ChatSettings>): Partial<ChatSettings> {
  if (!settings) return {};
  const out: Partial<ChatSettings> = {};
  if (settings.model !== undefined) out.model = settings.model;
  if (settings.permissions !== undefined) out.permissions = settings.permissions;
  if (settings.agentSetupId !== undefined) out.agentSetupId = settings.agentSetupId;
  return out;
}

/**
 * Merge the three layers into a fully-resolved settings object. A new chat
 * (no `server`, no `local`) resolves to `defaults` — by default the global
 * {@link NEW_CHAT_SETTINGS}, but a caller that knows the chat's project passes
 * the per-project sticky base (see `resolveNewChatSettings` in `state/chatStore`)
 * so a brand-new chat opens with that project's last-used mode.
 */
export function resolveChatSettings(
  local?: Partial<ChatSettings>,
  server?: Partial<ChatSettings>,
  defaults: Required<ChatSettings> = NEW_CHAT_SETTINGS
): Required<ChatSettings> {
  return {
    ...defaults,
    ...defined(server),
    ...defined(local),
  };
}
