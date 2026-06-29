/**
 * Settings ViewModel (MVVM ViewModel-as-hook) for the settings/profile root.
 * Keeps `SettingsScreen` a thin view.
 *
 * Owns, all with injectable seams so the screen + its tests run with no native
 * modules / network:
 *   1. Identity + section navigation — native Clerk user, the section catalog
 *      with search filtering, and `openSection(route)`.
 *   2. Profile photo get/update/delete via Clerk behind an avatar action sheet.
 *   3. Account deletion — the inline Danger-Zone confirm (email re-type
 *      gate), then `DELETE /auth/account`, sign-out, and route to sign-in.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { useClerk, useUser } from '@clerk/clerk-expo';

import type { MobileRnDeleteAccountResponse } from '@vgit2/shared/types';

import { GatewayClient } from '../../services/gatewayClient';
import { forceSignOut } from '../auth/forceSignOut';
import { getGatewayUrl } from '../auth/gatewayConfig';
import { getAuthToken } from '../auth/secureAuthStore';
import { useDevModeStore } from '../state/devModeStore';
import { pickAvatarImage } from './avatarPicker';
import { filterSections, SETTINGS_SECTIONS, type SettingsSection } from './settingsSections';

export interface SettingsViewModelDeps {
  /** Pick a profile photo from the photo library → data URI (or null if cancelled). */
  pickAvatar?: () => Promise<string | null>;
  /** Issue the account-deletion request (default: gateway `DELETE /auth/account`). */
  deleteAccountRequest?: (authToken: string) => Promise<MobileRnDeleteAccountResponse>;
  /** Read the Portable authToken (default: SecureStore). */
  readAuthToken?: () => Promise<string | null>;
  /** Clear local credentials + Clerk session (default: composes both). */
  signOut?: () => Promise<void>;
  /** Navigate (default: Expo Router imperative singleton). */
  navigate?: (path: string) => void;
  /**
   * Platform tag (default `Platform.OS`). On iOS the photo pick is DEFERRED to
   * the avatar sheet's `onDismiss` — presenting the native image picker while
   * the RN `Modal` is mid-dismissal intermittently fails ("view is not in the
   * window hierarchy" class) or hangs the picker promise. Android runs it
   * immediately (`onDismiss` is iOS-only and Android has no such race).
   */
  platform?: string;
}

export interface SettingsViewModel {
  // Identity
  displayName: string;
  /** GitHub-ish handle shown as `@login` (Clerk username, name fallback). */
  login: string;
  email: string;
  /** Current avatar URL (Clerk GET), or null when the user has no photo. */
  avatarUrl: string | null;

  // Sections + search
  sections: SettingsSection[];
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  openSection: (route: string) => void;
  /** Open a legal document (ToS / Privacy footer links). */
  openLegal: (doc: 'tos' | 'privacy') => void;
  /** Hidden dev mode is on → surface dev-only entries (Sentry Test). */
  devModeEnabled: boolean;

  /** Sign out: clear local creds + Clerk session, then route to /sign-in. */
  signOut: () => Promise<void>;

  // User menu (⋯ dropdown: Usage / Logout)
  menuVisible: boolean;
  openMenu: () => void;
  closeMenu: () => void;

  // Profile photo (avatar press → action sheet → change/remove)
  avatarSheetVisible: boolean;
  openAvatarSheet: () => void;
  closeAvatarSheet: () => void;
  /** The avatar-sheet `Modal` `onDismiss` — runs a pick deferred on iOS. */
  handleAvatarSheetDismissed: () => void;
  photoBusy: boolean;
  photoError: string | null;
  /** "Choose photo": closes the sheet, then runs the pick (iOS: after dismiss). */
  requestPhotoPick: () => void;
  /** Run the native pick → Clerk `setProfileImage({ file })` (already desheeted). */
  updatePhoto: () => Promise<void>;
  removePhoto: () => Promise<void>;

  // Account deletion (inline Danger-Zone confirm)
  deleteVisible: boolean;
  confirmEmail: string;
  setConfirmEmail: (value: string) => void;
  emailMatches: boolean;
  isDeleting: boolean;
  deleteError: string | null;
  openDeleteConfirm: () => void;
  cancelDelete: () => void;
  confirmDelete: () => Promise<void>;
}

/** Default account-deletion request: gateway `DELETE /auth/account`. */
function defaultDeleteAccountRequest(authToken: string): Promise<MobileRnDeleteAccountResponse> {
  return new GatewayClient({ gatewayUrl: getGatewayUrl() }).deleteAccount(authToken);
}

export function useSettingsViewModel(deps: SettingsViewModelDeps = {}): SettingsViewModel {
  const {
    pickAvatar = pickAvatarImage,
    deleteAccountRequest = defaultDeleteAccountRequest,
    readAuthToken = getAuthToken,
    // Sections/legal DRILL IN (push keeps the back stack); sign-in REPLACES
    // (post-sign-out there is no authenticated stack to return to).
    navigate = (path: string) =>
      path === '/sign-in' ? router.replace(path as never) : router.push(path as never),
  } = deps;

  const { user } = useUser();
  const { signOut: clerkSignOut } = useClerk();

  // Default sign-out: the shared wipe composition + the Clerk session.
  const signOut = useMemo(
    () => deps.signOut ?? (() => forceSignOut({ clerkSignOut: () => clerkSignOut() })),
    [deps.signOut, clerkSignOut]
  );

  // ── User menu (⋯ dropdown) ────────────────────────────────────────────────
  const [menuVisible, setMenuVisible] = useState(false);
  const openMenu = useCallback(() => setMenuVisible(true), []);
  const closeMenu = useCallback(() => setMenuVisible(false), []);

  // ── Profile photo ────────────────────────────────────────────────────────
  const [avatarSheetVisible, setAvatarSheetVisible] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const openAvatarSheet = useCallback(() => setAvatarSheetVisible(true), []);
  const closeAvatarSheet = useCallback(() => setAvatarSheetVisible(false), []);

  // GET: the current photo URL (Clerk), null when the user has no image.
  const avatarUrl = user?.hasImage ? (user.imageUrl ?? null) : null;

  const updatePhoto = useCallback(async () => {
    if (photoBusy || !user) return;
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      const file = await pickAvatar();
      if (!file) return; // cancelled / permission denied — no-op
      await user.setProfileImage({ file });
    } catch {
      setPhotoError('Could not update your photo. Please try again.');
    } finally {
      setPhotoBusy(false);
    }
  }, [photoBusy, user, pickAvatar]);

  // "Choose photo": the native picker must NOT be presented while the avatar
  // sheet's Modal is mid-dismissal (iOS UIKit presentation race — the picker
  // intermittently fails or its promise never settles). On iOS the pick is
  // deferred to the Modal's `onDismiss`; Android (no `onDismiss`, no such
  // race) runs it right away.
  const platform = deps.platform ?? Platform.OS;
  const pendingPickRef = useRef(false);

  const requestPhotoPick = useCallback(() => {
    if (photoBusy) return;
    setAvatarSheetVisible(false);
    if (platform === 'ios') {
      pendingPickRef.current = true;
    } else {
      void updatePhoto();
    }
  }, [photoBusy, platform, updatePhoto]);

  const handleAvatarSheetDismissed = useCallback(() => {
    if (!pendingPickRef.current) return;
    pendingPickRef.current = false;
    void updatePhoto();
  }, [updatePhoto]);

  const removePhoto = useCallback(async () => {
    if (photoBusy || !user) return;
    setAvatarSheetVisible(false);
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      await user.setProfileImage({ file: null });
    } catch {
      setPhotoError('Could not remove your photo. Please try again.');
    } finally {
      setPhotoBusy(false);
    }
  }, [photoBusy, user]);

  // ── Account deletion (inline Danger-Zone confirm) ────────────────────────
  const email = user?.primaryEmailAddress?.emailAddress ?? '';
  const [deleteVisible, setDeleteVisible] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const emailMatches =
    confirmEmail.trim().length > 0 &&
    confirmEmail.trim().toLowerCase() === email.trim().toLowerCase();

  const openDeleteConfirm = useCallback(() => {
    setConfirmEmail('');
    setDeleteError(null);
    setDeleteVisible(true);
  }, []);

  const cancelDelete = useCallback(() => {
    if (isDeleting) return;
    setDeleteVisible(false);
    setConfirmEmail('');
    setDeleteError(null);
  }, [isDeleting]);

  const confirmDelete = useCallback(async () => {
    if (!emailMatches || isDeleting) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const token = await readAuthToken();
      if (!token) {
        setDeleteError('You are not signed in.');
        setIsDeleting(false);
        return;
      }
      const result = await deleteAccountRequest(token);
      if (!result.success) {
        setDeleteError(result.error ?? 'Failed to delete account.');
        setIsDeleting(false);
        return;
      }
      // Success — sign out (clear local creds + Clerk) and route to sign-in.
      await signOut();
      setDeleteVisible(false);
      navigate('/sign-in');
    } catch {
      setDeleteError('Network error. Please try again.');
      setIsDeleting(false);
    }
  }, [emailMatches, isDeleting, readAuthToken, deleteAccountRequest, signOut, navigate]);

  // ── Sign out ─────────────────────────────────────────────────────────────
  // Clears the local sandbox credentials + Clerk session and routes to /sign-in.
  // The StartupGate then redirects any subsequent launch back to sign-in.
  const handleSignOut = useCallback(async () => {
    setMenuVisible(false);
    await signOut();
    navigate('/sign-in');
  }, [signOut, navigate]);

  // ── Sections + search ────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const sections = useMemo(() => filterSections(SETTINGS_SECTIONS, searchQuery), [searchQuery]);
  const openSection = useCallback((route: string) => navigate(route), [navigate]);
  const openLegal = useCallback(
    (doc: 'tos' | 'privacy') => navigate(`/settings/legal?doc=${doc}`),
    [navigate]
  );

  // Reactive read of the hidden dev-mode flag — gates the dev-only
  // entries (e.g. the Sentry test page) in `SettingsScreen`.
  const devModeEnabled = useDevModeStore((s) => s.enabled);

  return {
    displayName: user?.fullName ?? user?.username ?? email ?? 'Account',
    login: user?.username ?? user?.fullName ?? email,
    email,
    avatarUrl,
    sections,
    searchQuery,
    setSearchQuery,
    openSection,
    openLegal,
    devModeEnabled,
    signOut: handleSignOut,
    menuVisible,
    openMenu,
    closeMenu,
    avatarSheetVisible,
    openAvatarSheet,
    closeAvatarSheet,
    handleAvatarSheetDismissed,
    photoBusy,
    photoError,
    requestPhotoPick,
    updatePhoto,
    removePhoto,
    deleteVisible,
    confirmEmail,
    setConfirmEmail,
    emailMatches,
    isDeleting,
    deleteError,
    openDeleteConfirm,
    cancelDelete,
    confirmDelete,
  };
}
