/**
 * useBottomInset — the system bottom inset (Android nav bar / iOS home
 * indicator) for bottom-pinned sheets, read via `SafeAreaInsetsContext` so a
 * component rendered WITHOUT a `SafeAreaProvider` (isolated tests, storybook)
 * degrades to 0 instead of throwing like `useSafeAreaInsets` does. In the app
 * the provider is always mounted at the root, so this equals `insets.bottom`.
 */

import { useContext, type Context } from 'react';
import { SafeAreaInsetsContext, type EdgeInsets } from 'react-native-safe-area-context';

// safe-area-context peer-types against React 18's type tree; re-type the context
// to this package's React 19 once (the ClerkAuthProvider / sentryErrorBoundary
// precedent) so `useContext` accepts it.
const InsetsContext = SafeAreaInsetsContext as unknown as Context<EdgeInsets | null>;

export function useBottomInset(): number {
  return useContext(InsetsContext)?.bottom ?? 0;
}
