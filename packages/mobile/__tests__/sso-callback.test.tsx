/**
 * SSO callback screen (Clerk native-SSO auth-session target).
 *
 * The `/sso-callback` route exists ONLY to give Expo Router a valid screen during
 * the OAuth handshake so the Android Custom-Tabs deep-link redirect doesn't flash
 * the "Unmatched Route" screen (navigation is owned by `app/sign-in.tsx`). It is a
 * purely presentational loading screen built on the dark `signInTheme` tokens — no
 * theme store / MMKV / Clerk, so it renders with a plain `render` and no mocks.
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';

import { SSOCallbackScreen } from '../src/features/auth/SSOCallbackScreen';

describe('SSOCallbackScreen', () => {
  it('renders the branded loading callback screen', () => {
    render(<SSOCallbackScreen />);

    // The route target node (matches the deep-link path Expo Router navigates to).
    expect(screen.getByTestId('sso-callback')).toBeTruthy();
    // A visible "we're working" affordance instead of the unmatched-route screen.
    expect(screen.getByTestId('sso-callback-label')).toHaveTextContent(/signing you in/i);
  });
});
