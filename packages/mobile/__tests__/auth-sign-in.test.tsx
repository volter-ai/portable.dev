/**
 * Native Clerk sign-in (`@clerk/clerk-expo`).
 *
 * With `@clerk/clerk-expo` mocked, render the sign-in screen via React Native
 * Testing Library, trigger the GitHub social sign-in interaction, and assert:
 *   1. a NATIVE Clerk session token is produced (via the SSO flow + `getToken`),
 *   2. `Browser.open` (an external-browser web-redirect — here represented by
 *      `expo-web-browser`'s `openBrowserAsync`) is NEVER invoked.
 *
 * Email/password sign-in and the cancelled-flow path are covered too. The
 * email/password form is DEV-MODE-ONLY (prod default is SSO-only), so
 * the form tests pre-enable `devModeStore`; `dev-mode.test.tsx` owns the toggle
 * gesture + gateway-switch coverage.
 */

// Hoisted mocks (must precede the SUT import).
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(),
  openAuthSessionAsync: jest.fn(),
  maybeCompleteAuthSession: jest.fn(),
  warmUpAsync: jest.fn(),
  coolDownAsync: jest.fn(),
  dismissBrowser: jest.fn(),
  dismissAuthSession: jest.fn(),
}));

jest.mock('expo-linking', () => ({
  createURL: jest.fn((path: string) => `portable://app${path}`),
}));

jest.mock('@clerk/clerk-expo', () => {
  const ssoSetActive = jest.fn(async () => {});
  const setActive = jest.fn(async () => {});
  const getToken = jest.fn(async () => 'clerk_session_token_abc');
  const startSSOFlow = jest.fn(async () => ({
    createdSessionId: 'sess_clerk_123',
    setActive: ssoSetActive,
    authSessionResult: { type: 'success' },
  }));
  const signInCreate = jest.fn(async () => ({
    status: 'complete',
    createdSessionId: 'sess_email_456',
  }));
  return {
    __mock: { ssoSetActive, setActive, getToken, startSSOFlow, signInCreate },
    ClerkProvider: ({ children }: { children: React.ReactNode }) => children,
    useSSO: () => ({ startSSOFlow }),
    useSignIn: () => ({ isLoaded: true, signIn: { create: signInCreate }, setActive }),
    useAuth: () => ({ getToken, isSignedIn: false, isLoaded: true, signOut: jest.fn() }),
  };
});

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SignInScreen } from '../src/features/auth/SignInScreen';
import { useDevModeStore } from '../src/features/state/devModeStore';
import { GatewayClient, GatewayHttpError } from '../src/services/gatewayClient';

// Explicit metrics so `useSafeAreaInsets()` resolves synchronously in tests
// (no async device measurement).
const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function renderScreen(onAuthenticated: jest.Mock) {
  return render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <SignInScreen onAuthenticated={onAuthenticated} />
    </SafeAreaProvider>
  );
}

interface ClerkMock {
  __mock: {
    ssoSetActive: jest.Mock;
    setActive: jest.Mock;
    getToken: jest.Mock;
    startSSOFlow: jest.Mock;
    signInCreate: jest.Mock;
  };
}

const clerk = jest.requireMock('@clerk/clerk-expo') as ClerkMock;

// The email/password form is dev-mode-only — pre-set the store BEFORE
// rendering (no mounted subscribers yet, so no act() needed).
function enableDevMode() {
  useDevModeStore.setState({ enabled: true });
}

afterEach(() => {
  act(() => {
    useDevModeStore.setState({ enabled: false });
  });
});

describe('native Clerk sign-in', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Restore the default happy-path implementations cleared above.
    clerk.__mock.getToken.mockResolvedValue('clerk_session_token_abc');
    clerk.__mock.startSSOFlow.mockResolvedValue({
      createdSessionId: 'sess_clerk_123',
      setActive: clerk.__mock.ssoSetActive,
      authSessionResult: { type: 'success' },
    });
    clerk.__mock.signInCreate.mockResolvedValue({
      status: 'complete',
      createdSessionId: 'sess_email_456',
    });
  });

  it('GitHub social sign-in produces a native session token without an external browser redirect', async () => {
    const onAuthenticated = jest.fn();
    renderScreen(onAuthenticated);

    // Title renders with its parity testID.
    expect(screen.getByTestId('sign-in-title')).toBeTruthy();

    fireEvent.press(screen.getByTestId('sign-in-social-github'));

    // (1) A native Clerk session token is produced and surfaced.
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith('clerk_session_token_abc'));

    // The native SSO flow was used (GitHub strategy), the session was activated,
    // and the token was read from the active session.
    expect(clerk.__mock.startSSOFlow).toHaveBeenCalledTimes(1);
    expect(clerk.__mock.startSSOFlow.mock.calls[0][0]).toMatchObject({ strategy: 'oauth_github' });
    expect(clerk.__mock.ssoSetActive).toHaveBeenCalledWith({ session: 'sess_clerk_123' });
    expect(clerk.__mock.getToken).toHaveBeenCalled();

    // (2) No external-browser web-redirect ("Browser.open") was ever invoked.
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
  });

  it('hides the email/password form in prod mode (SSO only)', () => {
    renderScreen(jest.fn());

    expect(screen.queryByTestId('sign-in-email')).toBeNull();
    expect(screen.queryByTestId('sign-in-password')).toBeNull();
    expect(screen.queryByTestId('sign-in-submit')).toBeNull();
    expect(screen.queryByTestId('dev-mode-banner')).toBeNull();
    expect(screen.getByTestId('sign-in-social-github')).toBeTruthy();
  });

  it('email/password sign-in activates the session and produces a token natively', async () => {
    enableDevMode();
    const onAuthenticated = jest.fn();
    renderScreen(onAuthenticated);

    fireEvent.changeText(screen.getByTestId('sign-in-email'), 'user@example.com');
    fireEvent.changeText(screen.getByTestId('sign-in-password'), 'hunter2');
    fireEvent.press(screen.getByTestId('sign-in-submit'));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith('clerk_session_token_abc'));
    expect(clerk.__mock.signInCreate).toHaveBeenCalledWith({
      identifier: 'user@example.com',
      password: 'hunter2',
    });
    expect(clerk.__mock.setActive).toHaveBeenCalledWith({ session: 'sess_email_456' });
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
  });

  it('shows an error and does not authenticate when the SSO flow is cancelled', async () => {
    clerk.__mock.startSSOFlow.mockResolvedValueOnce({
      createdSessionId: null,
      setActive: undefined,
      authSessionResult: { type: 'cancel' },
    });
    const onAuthenticated = jest.fn();
    renderScreen(onAuthenticated);

    fireEvent.press(screen.getByTestId('sign-in-social-github'));

    await waitFor(() => expect(screen.getByTestId('sign-in-error')).toBeTruthy());
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(clerk.__mock.getToken).not.toHaveBeenCalled();
  });

  it('surfaces the gateway exchange error (status + message) when the phase-2 exchange fails', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // Clerk sign-in succeeds (default mocks), but the server-side exchange rejects.
    const onAuthenticated = jest
      .fn()
      .mockRejectedValue(new GatewayHttpError(401, 'Session not found'));
    renderScreen(onAuthenticated);

    fireEvent.press(screen.getByTestId('sign-in-social-github'));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    await waitFor(() => {
      const box = screen.getByTestId('sign-in-error');
      // The distinct exchange message carries BOTH the status and the server text
      // (previously collapsed into an indistinguishable generic message).
      expect(box).toHaveTextContent(/401/);
      expect(box).toHaveTextContent(/Session not found/);
    });
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('[SignIn]'))).toBe(true);
    errSpy.mockRestore();
  });

  it('surfaces an error when Clerk activates a session but returns a null token', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    clerk.__mock.getToken.mockResolvedValueOnce(null);
    // Mirror app/sign-in.tsx's onAuthenticated, which throws on a null token
    // instead of silently stalling the sign-in.
    const onAuthenticated = jest.fn((token: string | null) => {
      if (!token) throw new Error('Clerk returned no session token after sign-in.');
    });
    renderScreen(onAuthenticated);

    fireEvent.press(screen.getByTestId('sign-in-social-github'));

    // The null token flowed through (no silent return), and the thrown error is
    // caught by the VM phase-2 handler → logged + surfaced (not a stuck button).
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(null));
    await waitFor(() => expect(screen.getByTestId('sign-in-error')).toBeTruthy());
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('[SignIn]'))).toBe(true);
    errSpy.mockRestore();
  });

  it('reuses an existing Clerk session (email) instead of failing with session_exists', async () => {
    // Simulate `signIn.create()` throwing Clerk's session_exists error — the same
    // shape the SDK surfaces: a `clerkError` with an `errors[]` carrying the code.
    clerk.__mock.signInCreate.mockRejectedValueOnce({
      clerkError: true,
      code: 'api_response_error',
      status: 400,
      errors: [{ code: 'session_exists', message: "You're already signed in." }],
    });
    enableDevMode();
    const onAuthenticated = jest.fn();
    renderScreen(onAuthenticated);

    fireEvent.changeText(screen.getByTestId('sign-in-email'), 'user@example.com');
    fireEvent.changeText(screen.getByTestId('sign-in-password'), 'hunter2');
    fireEvent.press(screen.getByTestId('sign-in-submit'));

    // The live session is reused: the token is read + exchanged, no error shown.
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith('clerk_session_token_abc'));
    expect(screen.queryByTestId('sign-in-error')).toBeNull();
  });

  it('skips the SSO flow entirely when Clerk already has a session', async () => {
    // Re-mock useAuth so isSignedIn is true for this render.
    const useAuthSpy = jest
      .spyOn(clerk as unknown as { useAuth: () => unknown }, 'useAuth')
      .mockReturnValue({
        getToken: clerk.__mock.getToken,
        isSignedIn: true,
        isLoaded: true,
        signOut: jest.fn(),
      });
    const onAuthenticated = jest.fn();
    renderScreen(onAuthenticated);

    fireEvent.press(screen.getByTestId('sign-in-social-github'));

    // No new SSO flow is started — the existing session's token is exchanged directly.
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith('clerk_session_token_abc'));
    expect(clerk.__mock.startSSOFlow).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sign-in-error')).toBeNull();
    useAuthSpy.mockRestore();
  });

  it('logs and shows a generic error when the Clerk SSO flow itself throws', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    clerk.__mock.startSSOFlow.mockRejectedValueOnce(new Error('clerk network down'));
    const onAuthenticated = jest.fn();
    renderScreen(onAuthenticated);

    fireEvent.press(screen.getByTestId('sign-in-social-github'));

    await waitFor(() =>
      expect(screen.getByTestId('sign-in-error')).toHaveTextContent(/Could not sign in/)
    );
    // Phase 1 failed → the exchange (phase 2) is never reached.
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('[SignIn]'))).toBe(true);
    errSpy.mockRestore();
  });
});

describe('GatewayClient base-URL guard', () => {
  // The #1 silent sign-in failure: an empty base URL (EXPO_PUBLIC_GATEWAY_URL unset)
  // makes every request hit a relative path. The constructor must log loudly.
  it('logs a tagged error when constructed with an empty base URL', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    new GatewayClient({ gatewayUrl: '' });
    expect(spy.mock.calls.some((c) => String(c[0]).includes('gatewayUrl is empty'))).toBe(true);
    spy.mockRestore();
  });

  it('does not log for a valid base URL', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    new GatewayClient({ gatewayUrl: 'https://gw.example.com' });
    expect(spy.mock.calls.some((c) => String(c[0]).includes('gatewayUrl is empty'))).toBe(false);
    spy.mockRestore();
  });
});
