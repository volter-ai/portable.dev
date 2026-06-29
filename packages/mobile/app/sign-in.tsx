import { router } from 'expo-router';
import { useCallback } from 'react';

import { SignInScreen } from '@/features/auth/SignInScreen';
import { exchangeClerkSession } from '@/features/auth/exchangeClerkSession';
import { getGatewayUrl } from '@/features/auth/gatewayConfig';
import { useAuthStore } from '@/features/state/authStore';
import { GatewayClient } from '@/services/gatewayClient';

/**
 * `/sign-in` route — thin shell over the native Clerk sign-in screen (US-E1-001),
 * now wired into the app shell (US-008).
 *
 * On a completed native Clerk sign-in the screen hands back the Clerk session
 * token; we exchange it server-side for the Portable JWT (`exchangeClerkSession`
 * persists the minted authToken to SecureStore as a side effect), mirror the
 * non-secret identity into the authStore, and route to `/`. The StartupGate then
 * finds the persisted authToken and lets the shell proceed to the PC-connect gate
 * (US-E6-001 unwrapped onboarding — there is no questionnaire anymore).
 */
export default function SignIn() {
  const onAuthenticated = useCallback(async (token: string | null) => {
    // Clerk activated a session but returned no token — surface it (the VM's
    // phase-2 catch logs + shows it) instead of silently stalling on sign-in.
    if (!token) throw new Error('Clerk returned no session token after sign-in.');
    const gateway = new GatewayClient({ gatewayUrl: getGatewayUrl() });
    const identity = await exchangeClerkSession(token, gateway);
    // Mirror the non-secret identity (the authToken stays in SecureStore only).
    useAuthStore.getState().setUser({
      userId: identity.userId,
      username: identity.username,
      email: identity.email,
    });
    router.replace('/');
  }, []);

  return <SignInScreen onAuthenticated={onAuthenticated} />;
}
