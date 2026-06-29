/**
 * Window-level safe-area insets, immune to in-flow inset overrides.
 *
 * Some hosts consume the top safe-area inset IN FLOW (padding it themselves) and
 * override `SafeAreaInsetsContext` with `top: 0` for the screens below, so screen
 * headers sit flush instead of double-padding. A full-screen RN `Modal` ESCAPES
 * that layout — it covers the entire window — so a modal padding by the
 * overridden insets would render under the status bar.
 *
 * `useWindowInsets()` returns the ORIGINAL window insets when a host captured
 * them via `WindowInsetsContext`, else falls back to the ambient
 * `useSafeAreaInsets()` (identical when no inset-overriding host is mounted). Use
 * it inside full-screen/transparent `Modal` content; keep the normal
 * `useSafeAreaInsets()` everywhere else.
 */

import { createContext, useContext } from 'react';
import { useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context';

/** Original window insets captured by an inset-overriding host (else null). */
export const WindowInsetsContext = createContext<EdgeInsets | null>(null);

/** The window's safe-area insets, even under a banner-host inset override. */
export function useWindowInsets(): EdgeInsets {
  const window = useContext(WindowInsetsContext);
  const ambient = useSafeAreaInsets();
  return window ?? ambient;
}
