/**
 * Auth slice — client auth state.
 *
 * Persisted via the SecureStore adapter (the "auth / sandbox-URL / Clerk" slice).
 * It holds the NON-secret signed-in identity + auth flags + a mirror of the
 * mutable sandbox URL. The actual secrets — the Portable `authToken` and the
 * Clerk session token — are NEVER kept in this slice; they live in the dedicated
 * `secureAuthStore.ts` (authToken) and Clerk `tokenCache.ts`. Persisting this
 * slice through SecureStore is defense-in-depth so even the identity never lands
 * in plain AsyncStorage.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { secureStateStorage } from './storage';

/** Non-secret signed-in identity (from the gateway clerk-exchange). */
export interface AuthUser {
  userId: string;
  username: string;
  email: string;
}

export interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  onWaitlist: boolean;
  /** Mirror of the mutable sandbox base URL (canonical secret copy in relayUrlStore). */
  sandboxUrl: string | null;

  setUser: (user: AuthUser | null) => void;
  updateUser: (patch: Partial<AuthUser>) => void;
  setAuthenticated: (isAuthenticated: boolean) => void;
  setOnWaitlist: (onWaitlist: boolean) => void;
  setSandboxUrl: (sandboxUrl: string | null) => void;
  /** Clear all auth state (sign-out). */
  reset: () => void;
}

const initialAuthState = {
  user: null as AuthUser | null,
  isAuthenticated: false,
  onWaitlist: false,
  sandboxUrl: null as string | null,
};

/** SecureStore persist key for the auth slice. */
export const AUTH_PERSIST_KEY = 'portable.auth';

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      ...initialAuthState,
      setUser: (user) => set({ user, isAuthenticated: user !== null }),
      updateUser: (patch) => {
        const current = get().user;
        set({ user: current ? { ...current, ...patch } : current });
      },
      setAuthenticated: (isAuthenticated) => set({ isAuthenticated }),
      setOnWaitlist: (onWaitlist) => set({ onWaitlist }),
      setSandboxUrl: (sandboxUrl) => set({ sandboxUrl }),
      reset: () => set({ ...initialAuthState }),
    }),
    {
      name: AUTH_PERSIST_KEY,
      storage: createJSONStorage(() => secureStateStorage),
      // Persist only data, never the action functions.
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        onWaitlist: state.onWaitlist,
        sandboxUrl: state.sandboxUrl,
      }),
    }
  )
);
