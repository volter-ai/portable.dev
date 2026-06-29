/**
 * Blocked-organizations slice.
 *
 * The blocklist is stored on-device (no "block" mutation is sent to a server),
 * but it DOES filter the repo lists: {@link useBlockedOrgsParam} feeds the
 * `blockedOrgs` query param to `GET /api/repos` (home grid + Repos tab), and the
 * backend `RepoHandler` filters out repos whose `owner.login` is blocked. The
 * org SETTINGS list itself always shows every org
 * (`GET /api/user/organizations`) as a checkbox row. Persisted via the MMKV
 * adapter (non-secret UI pref — same `persist`/`createJSONStorage` pattern as
 * `themeStore`).
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { mmkvStateStorage } from '../../../state/storage';

/** MMKV persist key for the blocked-orgs slice. */
export const BLOCKED_ORGS_PERSIST_KEY = 'portable.blockedOrgs';

export interface BlockedOrgsState {
  /** Org logins the user has hidden. */
  blockedOrgs: string[];
  /** Toggle an org login in/out of the blocked list. */
  toggleBlocked: (login: string) => void;
  /** Clear the blocked list (sign-out — `forceSignOut`). */
  reset: () => void;
}

export const useBlockedOrgsStore = create<BlockedOrgsState>()(
  persist(
    (set) => ({
      blockedOrgs: [],
      toggleBlocked: (login) =>
        set((state) => ({
          blockedOrgs: state.blockedOrgs.includes(login)
            ? state.blockedOrgs.filter((o) => o !== login)
            : [...state.blockedOrgs, login],
        })),
      reset: () => set({ blockedOrgs: [] }),
    }),
    {
      name: BLOCKED_ORGS_PERSIST_KEY,
      storage: createJSONStorage(() => mmkvStateStorage),
    }
  )
);

/**
 * The value for the `/api/repos` `blockedOrgs` query param: the blocked logins
 * as a SORTED JSON array (sorted so the value — and therefore the TanStack query
 * key + the backend cache key — is stable regardless of toggle order), or
 * `undefined` when nothing is blocked (so the param is omitted and the URL/key
 * are unchanged for the common "no orgs blocked" case). The backend parses this
 * with `JSON.parse(req.query.blockedOrgs)` and filters out matching
 * `repo.owner.login` (`RepoHandler`). Reactive — toggling an org refetches the
 * repos list.
 */
export function useBlockedOrgsParam(): string | undefined {
  return useBlockedOrgsStore((s) =>
    s.blockedOrgs.length ? JSON.stringify([...s.blockedOrgs].sort()) : undefined
  );
}
