/**
 * useChatUnseen — is this chat CHANGED-but-not-yet-opened on this device?
 *
 * Reads the persisted per-chat seen marker ({@link useChatSeenStore}) and compares it
 * to the chat's current `lastUpdated`. Returns `true` when the chat has advanced past
 * the value the client last saw — the signal that drives the orange row highlight.
 *
 * The hook also lazily BASELINES a chat the first time this device sees it (via an
 * effect), so a pre-existing chat never lights up retroactively: only changes AFTER the
 * baseline (or after the last open) glow. A chat with no marker yet reads as "seen"
 * (no glow) until the baseline effect commits.
 */

import { useEffect } from 'react';

import type { ChatListItem } from '@vgit2/shared/types';
import type { ViewStyle } from 'react-native';

import { mixColors, type Theme } from '../../theme';

import { useChatSeenStore } from './chatSeenStore';

export function useChatUnseen(chat: Pick<ChatListItem, 'id' | 'lastUpdated'>): boolean {
  const lastUpdated = chat.lastUpdated ?? 0;
  const seen = useChatSeenStore((s) => s.seen[chat.id]);
  const noteBaseline = useChatSeenStore((s) => s.noteBaseline);

  useEffect(() => {
    if (lastUpdated > 0) noteBaseline(chat.id, lastUpdated);
  }, [chat.id, lastUpdated, noteBaseline]);

  if (lastUpdated <= 0) return false;
  // No marker yet → the baseline effect is about to record this exact value, so treat
  // it as seen (avoids a one-frame glow flash on a brand-new/first-seen chat).
  if (seen === undefined) return false;
  return lastUpdated > seen;
}

/**
 * The orange "unseen change" highlight for a chat card container: an accent-tinted
 * border + a faint accent wash + a soft accent glow (the colored shadow shows on the
 * un-clipped home/repo cards; the border + wash carry the cue where the row is clipped,
 * e.g. the swipeable chat-directory row). Layer it OVER the base card style.
 *
 * The wash is an OPAQUE blend of the accent into the surface — NOT a translucent
 * `withAlpha` wash, which made the card see-through: the swipe row's always-mounted
 * action buttons tinted the row's right edge while the text sat over the page
 * background, so the highlighted card rendered two-tone.
 */
export function unseenGlowStyle(theme: Theme): ViewStyle {
  return {
    borderColor: theme.colors.primary,
    backgroundColor: mixColors(theme.colors.surface, theme.colors.primary, 0.12),
    shadowColor: theme.colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.55,
    shadowRadius: 6,
    elevation: 4,
  };
}
