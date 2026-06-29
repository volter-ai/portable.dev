/**
 * ViewModel for the GitHub Organizations settings section.
 *
 * Joins three concerns:
 *   1. the org list — server state via the existing `useOrganizations()` query
 *      (`GET /api/user/organizations`);
 *   2. per-org visibility — the MMKV-persisted `useBlockedOrgsStore`
 *      (client-side only — no backend call);
 *   3. the grant-access OAuth flow — `POST /auth/github/org-access-url` (a
 *      SANDBOX route: the api client routes non-RN `/auth/*` paths to the
 *      sandbox base) → open the returned URL in the in-app system browser via
 *      `expo-web-browser`'s `openAuthSessionAsync` (lazy-required) → on settle,
 *      refetch organizations (the native replacement for the popup-poll /
 *      postMessage round-trip).
 *
 * Every I/O seam is injectable so the section is fully testable with the mock
 * gateway and no native browser/linking module.
 */

import { useCallback, useRef, useState } from 'react';

import type { GetUserOrganizationsResponse } from '@vgit2/shared/types';

import { useApi } from '../../../api/ApiProvider';
import { useOrganizations } from '../../../api/hooks';
import { useBlockedOrgsStore } from './blockedOrgsStore';

/** One organization row (`GET /api/user/organizations` element). */
export type Organization = GetUserOrganizationsResponse['organizations'][number];

/** Result of an in-app browser auth session (subset of expo-web-browser's). */
export interface AuthSessionResult {
  type: string;
  url?: string;
}

/** Deep-link path the grant flow returns to (the settings page itself). */
export const ORG_ACCESS_RETURN_PATH = '/settings/organizations';

export interface OrganizationsViewModelDeps {
  /** `POST /auth/github/org-access-url` → `{ url }` (default: `useApi().post`). */
  requestOrgAccessUrl?: () => Promise<{ url?: string }>;
  /** Open the OAuth URL in the in-app browser (default: lazy `openAuthSessionAsync`). */
  openAuthSession?: (url: string, returnTo: string) => Promise<AuthSessionResult>;
  /** Build the RN deep-link `returnTo` (default: lazy `Linking.createURL`). */
  createReturnToUrl?: () => string;
}

export interface OrganizationsViewModel {
  organizations: Organization[];
  /** Initial fetch in flight. */
  isLoading: boolean;
  /** Fetch failed. */
  error: string | null;
  /** Org logins currently blocked (hidden from display). */
  blockedOrgs: string[];
  /** Checkbox state: checked = NOT blocked. */
  isOrgVisible: (login: string) => boolean;
  /** Toggle block/unblock — MMKV-persisted, client-side only. */
  toggleOrg: (login: string) => void;
  /** Grant-access OAuth round-trip in flight. */
  grantBusy: boolean;
  /** Start the grant-organization-access OAuth flow. */
  grantAccess: () => Promise<void>;
}

/** Default browser seam — lazy `require` so Jest/Metro never load it at import. */
function defaultOpenAuthSession(url: string, returnTo: string): Promise<AuthSessionResult> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const WebBrowser = require('expo-web-browser') as {
    openAuthSessionAsync: (u: string, r: string) => Promise<AuthSessionResult>;
  };
  return WebBrowser.openAuthSessionAsync(url, returnTo);
}

/** Default deep-link seam — lazy `require` (same rationale as the browser). */
function defaultCreateReturnToUrl(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Linking = require('expo-linking') as { createURL: (path: string) => string };
  return Linking.createURL(ORG_ACCESS_RETURN_PATH);
}

export function useOrganizationsViewModel(
  deps: OrganizationsViewModelDeps = {}
): OrganizationsViewModel {
  const api = useApi();
  const query = useOrganizations();

  const blockedOrgs = useBlockedOrgsStore((s) => s.blockedOrgs);
  const toggleBlocked = useBlockedOrgsStore((s) => s.toggleBlocked);

  const [grantBusy, setGrantBusy] = useState(false);
  // Re-entrancy guard (state lags a fast double-tap).
  const grantBusyRef = useRef(false);

  const requestOrgAccessUrl =
    deps.requestOrgAccessUrl ?? (() => api.post<{ url?: string }>('/auth/github/org-access-url'));
  const openAuthSession = deps.openAuthSession ?? defaultOpenAuthSession;
  const createReturnToUrl = deps.createReturnToUrl ?? defaultCreateReturnToUrl;

  const refetch = query.refetch;
  const grantAccess = useCallback(async () => {
    if (grantBusyRef.current) return;
    grantBusyRef.current = true;
    setGrantBusy(true);
    try {
      const { url } = await requestOrgAccessUrl();
      if (url) {
        // The in-app session settles when the OAuth flow redirects back (or the
        // user dismisses the browser) — either way, re-pull the org list.
        await openAuthSession(url, createReturnToUrl());
        await refetch();
      }
    } catch {
      // Failures are logged-and-swallowed; the button just re-enables.
    } finally {
      grantBusyRef.current = false;
      setGrantBusy(false);
    }
  }, [requestOrgAccessUrl, openAuthSession, createReturnToUrl, refetch]);

  return {
    organizations: query.data?.organizations ?? [],
    // v5 `isPending` (not `isLoading`) so an offline-paused cold start still spins.
    isLoading: query.isPending,
    error: query.isError ? 'Failed to load organizations' : null,
    blockedOrgs,
    isOrgVisible: (login) => !blockedOrgs.includes(login),
    toggleOrg: toggleBlocked,
    grantBusy,
    grantAccess,
  };
}
