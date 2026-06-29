import { SSOCallbackScreen } from '@/features/auth/SSOCallbackScreen';

/**
 * `/sso-callback` route — the Clerk native-SSO auth-session callback target
 * (`redirectUrl: Linking.createURL('/sso-callback')` in `useSignInViewModel`).
 *
 * A SIBLING of `sign-in` and the `(app)` group (NOT under the gate ladder): the user
 * is mid-sign-in and not yet authenticated, so the `(app)` StartupGate would redirect
 * it straight back to sign-in. Its only job is to give Expo Router a valid screen
 * during the OAuth handshake so the Android deep-link redirect doesn't flash the
 * "Unmatched Route" screen; navigation is owned by `app/sign-in.tsx`. See
 * {@link SSOCallbackScreen}.
 */
export default function SSOCallback() {
  return <SSOCallbackScreen />;
}
