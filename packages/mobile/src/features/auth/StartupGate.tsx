import { Redirect } from 'expo-router';

import { useStartupGate, type StartupGateDeps } from './useStartupGate';
import { LoadingSplash } from '../../components/LoadingSplash';

interface StartupGateProps {
  /** The app tree to render once the user is authenticated. */
  children: React.ReactNode;
  /**
   * Startup-check dependencies. Omitted in production (the default reads the
   * persisted authToken from SecureStore); tests inject a fake `getRnAuthToken`.
   */
  deps?: StartupGateDeps;
  /** Route to send a re-auth user to (default `/sign-in`). */
  signInHref?: string;
}

/**
 * Startup gate. On cold launch it checks for a persisted Portable authToken and
 * then either renders the app (`authenticated`) or redirects to Clerk sign-in
 * (`needs-sign-in`). It is a thin view over {@link useStartupGate}.
 *
 * Wired as the OUTERMOST gate of the authenticated tree by the app-shell
 * (`AppShell`), ahead of the onboarding/provisioning gates.
 */
export function StartupGate({ children, deps, signInHref = '/sign-in' }: StartupGateProps) {
  const { status } = useStartupGate(deps ?? {});

  if (status === 'checking') {
    return <LoadingSplash testID="startup-gate-loading" />;
  }

  if (status === 'needs-sign-in') {
    return <Redirect href={signInHref} />;
  }

  return <>{children}</>;
}
