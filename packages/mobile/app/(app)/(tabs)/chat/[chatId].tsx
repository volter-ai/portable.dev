import { useMemo } from 'react';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ActiveChatScreen } from '@/features/chat';

// `/chat/:chatId` route — a single active chat (US-E4-001). Thin shell; the
// screen reads the `chatId` param via Expo Router.
//
// Lives INSIDE the `(tabs)` group as a HIDDEN tab screen (`href: null` in the
// tab layout) so the bottom tab bar stays visible while a chat is open (#1372);
// route groups are invisible in the path, so the URL is unchanged.
//
// The bottom-tabs bar already absorbs the bottom safe-area inset, so the
// subtree is re-provided `bottom: 0` (the `SafeAreaInsetsContext` override
// pattern) — otherwise the composer would double-pad above the bar.
export default function ActiveChat() {
  const insets = useSafeAreaInsets();
  const tabInsets = useMemo(() => ({ ...insets, bottom: 0 }), [insets]);
  return (
    <SafeAreaInsetsContext.Provider value={tabInsets}>
      <ActiveChatScreen />
    </SafeAreaInsetsContext.Provider>
  );
}
