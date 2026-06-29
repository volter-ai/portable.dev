/**
 * useRepoSettings — repo metadata + collaborators for the Settings tab.
 *
 * MVVM ViewModel-as-hook over the authed TanStack Query layer. The
 * Settings tab is read-only repo settings:
 * repository details + the collaborator list.
 *   - details       → `GET /api/repos/:owner/:repo`  → a BARE repo object
 *   - collaborators → `GET /api/repos/:owner/:repo/collaborators` → `{ team_members }`
 *
 * ⚠️ `GET /api/repos/:owner/:repo` returns the repo fields at the TOP LEVEL
 * (GitHub repo shape spread + local-status fields), NOT the `{ repo }`-wrapped
 * `GetRepoResponse` shared type (the type lies about this endpoint — same as the
 * README `contents` endpoint). Declared locally as a superset.
 */

import { useQuery } from '@tanstack/react-query';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';

/** Bare repo-details shape (`GET /api/repos/:owner/:repo`, top-level fields). */
export interface RepoDetails {
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  fork?: boolean;
  language: string | null;
  default_branch: string;
  visibility?: string;
  stargazers_count?: number;
  watchers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  created_at?: string;
  updated_at?: string;
  pushed_at?: string;
  html_url?: string;
  owner?: { login: string; avatar_url?: string };
  /** Local-clone status (backend-supplied; the RN client never shells out to git). */
  isLocal?: boolean;
}

/** A repo collaborator (`{ name, username }`). */
export interface Collaborator {
  name: string;
  username: string;
}

interface CollaboratorsResponse {
  team_members?: Collaborator[];
}

export interface UseRepoSettings {
  details: RepoDetails | undefined;
  collaborators: Collaborator[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useRepoSettings(owner: string, repo: string): UseRepoSettings {
  const api = useApi();

  const detailsQuery = useQuery({
    queryKey: queryKeys.repo(owner, repo),
    enabled: !!owner && !!repo,
    queryFn: () => api.get<RepoDetails>(`/api/repos/${owner}/${repo}`),
  });

  // Collaborators may legitimately 403/404 for a repo you can read but don't
  // admin; the backend falls back to assignees, so a failure leaves the list
  // empty without breaking the tab.
  const collaboratorsQuery = useQuery({
    queryKey: queryKeys.collaborators(owner, repo),
    enabled: !!owner && !!repo,
    retry: false,
    queryFn: () => api.get<CollaboratorsResponse>(`/api/repos/${owner}/${repo}/collaborators`),
  });

  return {
    details: detailsQuery.data,
    collaborators: collaboratorsQuery.data?.team_members ?? [],
    isLoading: detailsQuery.isLoading,
    isError: detailsQuery.isError,
    refetch: () => {
      void detailsQuery.refetch();
      void collaboratorsQuery.refetch();
    },
  };
}
