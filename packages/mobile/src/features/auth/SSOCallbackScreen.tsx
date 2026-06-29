import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';

import { SIGN_IN_COLORS } from './signInTheme';

// Same faint whale + dark field as `SignInScreen`, so this transient screen reads
// as a continuation of sign-in ("we're finishing signing you in"), never a flash.
const WHALE_IMAGE = require('../../../assets/images/whale-white.png');

/**
 * Native Clerk SSO auth-session callback screen.
 *
 * `useSSO().startSSOFlow` opens the OAuth provider in an in-app browser with
 * `redirectUrl = Linking.createURL('/sso-callback')` (`portable:///sso-callback`).
 * On iOS the `ASWebAuthenticationSession` captures that redirect by SCHEME and this
 * screen is never reached; on Android the Chrome-Custom-Tabs redirect arrives as a
 * real app DEEP LINK, which Expo Router navigates to `/sso-callback`. Without a route
 * file at that path Expo Router renders its "Unmatched Route" screen for the few
 * seconds the post-OAuth Clerk→Portable exchange takes — the reported "flash of a
 * broken route".
 *
 * This route gives Expo Router a valid, branded screen to show during the handshake.
 * It owns NO navigation: the sign-in flow is the single source of truth — once
 * `signInWithProvider` resolves, `app/sign-in.tsx`'s `onAuthenticated` runs the
 * server-side exchange and `router.replace('/')` (the in-flight closure survives this
 * screen's mount), and the `(app)` gate ladder takes over. This matches the canonical
 * Clerk-Expo SSO fix.
 *
 * Styled with the dark `signInTheme` tokens (NOT `useAppTheme`) so it (a) is visually
 * continuous with the sign-in screen the user just left and (b) pulls no theme-store /
 * MMKV dependency into a route that renders before the authenticated providers mount.
 */
export function SSOCallbackScreen() {
  return (
    <View testID="sso-callback" style={styles.root}>
      <Image
        source={WHALE_IMAGE}
        style={styles.whale}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
      />
      <ActivityIndicator size="large" color={SIGN_IN_COLORS.primary} />
      <Text testID="sso-callback-label" style={styles.label}>
        Signing you in…
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: SIGN_IN_COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
  },
  whale: {
    position: 'absolute',
    top: '6%',
    alignSelf: 'center',
    width: '90%',
    height: '45%',
    opacity: 0.3,
    pointerEvents: 'none',
  },
  label: {
    fontSize: 16,
    color: SIGN_IN_COLORS.textSubtitle,
  },
});
