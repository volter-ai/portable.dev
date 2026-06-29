/**
 * Runtime route path builders (Expo Router). The overview is the `/runtime` TAB;
 * the list/detail screens live under `app/(app)/runtime/*` and push OVER the tab
 * bar (sibling file+dir trick, like `repos.tsx` + `repos/`). Centralising the
 * paths keeps the screens + tests in lockstep.
 */

export const runtimeRoutes = {
  overview: '/runtime' as const,
  tunnels: '/runtime/tunnels' as const,
  tunnel: (port: number | string) => `/runtime/tunnel/${port}` as const,
  processes: '/runtime/processes' as const,
  process: (id: string) => `/runtime/process/${encodeURIComponent(id)}` as const,
};

/** Default navigate seam (Expo Router imperative singleton) — injectable in tests. */
export type RuntimeNavigate = (path: string) => void;
