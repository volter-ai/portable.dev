/**
 * Git provider abstraction — types + pure host-URL helpers.
 *
 * The runtime is local-first and was originally hardwired to GitHub (Octokit
 * against api.github.com, `github.com` for every git URL). These types let a
 * connection carry WHICH git host it targets, so the local git path
 * (clone/push/pull) and the REST layer can work against GitHub, a self-hosted
 * GitHub-API-compatible host (GitHub Enterprise, Gitea), GitLab, or any generic
 * git host.
 *
 * GitHub stays the DEFAULT everywhere ({@link DEFAULT_GIT_HOST}), so an existing
 * connection with no host is byte-for-byte unchanged. Everything here is pure
 * (no I/O) and unit-tested in `packages/shared/tests/git.test.ts`.
 */

/** Which git host / API flavour a connection targets. GitHub is the default. */
export type GitProvider = 'github' | 'gitea' | 'gitlab' | 'generic';

/** All known providers, in menu order. */
export const GIT_PROVIDERS: readonly GitProvider[] = [
  'github',
  'gitea',
  'gitlab',
  'generic',
] as const;

/**
 * A resolved git host.
 * - `webBaseUrl` — the browser origin (e.g. `https://github.com`,
 *   `https://gitea.example.com`). Absolute, no trailing slash.
 * - `apiBaseUrl` — the REST API root the Octokit client / provider adapters
 *   talk to (e.g. `https://api.github.com`, `https://gitea.example.com/api/v1`).
 *   Absolute, no trailing slash.
 */
export interface GitHost {
  provider: GitProvider;
  webBaseUrl: string;
  apiBaseUrl: string;
}

/** The canonical public GitHub host — the default for every existing connection. */
export const DEFAULT_GIT_HOST: GitHost = {
  provider: 'github',
  webBaseUrl: 'https://github.com',
  apiBaseUrl: 'https://api.github.com',
};

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Derive the REST API base URL for a host from its web origin, per provider
 * convention:
 * - github:  `https://api.github.com` (public) or `<web>/api/v3` (Enterprise)
 * - gitea:   `<web>/api/v1`
 * - gitlab:  `<web>/api/v4`
 * - generic: `<web>` (no assumption)
 */
export function defaultApiBaseUrl(provider: GitProvider, webBaseUrl: string): string {
  const web = stripTrailingSlash(webBaseUrl);
  switch (provider) {
    case 'github':
      return web === DEFAULT_GIT_HOST.webBaseUrl ? DEFAULT_GIT_HOST.apiBaseUrl : `${web}/api/v3`;
    case 'gitea':
      return `${web}/api/v1`;
    case 'gitlab':
      return `${web}/api/v4`;
    case 'generic':
    default:
      return web;
  }
}

/**
 * Build a fully-resolved {@link GitHost} from a provider + optional web base
 * URL (and an optional explicit API base URL). Omitting everything yields the
 * public GitHub host, so `resolveGitHost()` === {@link DEFAULT_GIT_HOST}.
 */
export function resolveGitHost(
  provider: GitProvider = 'github',
  webBaseUrl?: string,
  apiBaseUrl?: string
): GitHost {
  if (provider === 'github' && !webBaseUrl && !apiBaseUrl) {
    return DEFAULT_GIT_HOST;
  }
  const web = stripTrailingSlash(webBaseUrl ?? DEFAULT_GIT_HOST.webBaseUrl);
  return {
    provider,
    webBaseUrl: web,
    apiBaseUrl: apiBaseUrl ? stripTrailingSlash(apiBaseUrl) : defaultApiBaseUrl(provider, web),
  };
}

/** Hostname (no scheme, no path) of a host's web origin — e.g. `github.com`. */
export function gitHostname(host: GitHost): string {
  try {
    return new URL(host.webBaseUrl).host;
  } catch {
    return new URL(DEFAULT_GIT_HOST.webBaseUrl).host;
  }
}

/**
 * HTTPS clone URL for `owner/repo` on the given host. The token is NEVER
 * embedded here — auth rides in the git credential helper / env (see
 * `SourceControlService`), never in the URL or logs.
 */
export function buildCloneUrl(host: GitHost, owner: string, repo: string): string {
  return `${host.webBaseUrl}/${owner}/${repo}.git`;
}

/**
 * Owner avatar URL. GitHub exposes the `https://github.com/<owner>.png`
 * convenience redirect and Gitea mirrors it at `/<owner>.png`. GitLab avatars
 * are not addressable by username and generic hosts make no promise, so those
 * return `undefined` — callers should render an initials placeholder instead.
 */
export function ownerAvatarUrl(host: GitHost, owner: string, size?: number): string | undefined {
  if (host.provider === 'gitlab' || host.provider === 'generic') {
    return undefined;
  }
  const suffix = size ? `?size=${size}` : '';
  return `${host.webBaseUrl}/${owner}.png${suffix}`;
}

/**
 * The git credential-helper username each provider expects when authenticating
 * an HTTPS remote with a token as the password:
 * - github / gitea / generic: `x-access-token`
 * - gitlab: `oauth2`
 */
export function gitCredentialUsername(provider: GitProvider): string {
  return provider === 'gitlab' ? 'oauth2' : 'x-access-token';
}

/**
 * The `<login>@…` no-reply email domain used when authoring commits, per
 * provider. GitHub uses `users.noreply.github.com`; others fall back to the
 * host's own domain so attribution is at least host-correct.
 */
export function noreplyEmailDomain(host: GitHost): string {
  if (host.provider === 'github' && host.webBaseUrl === DEFAULT_GIT_HOST.webBaseUrl) {
    return 'users.noreply.github.com';
  }
  return gitHostname(host);
}

/**
 * Parse an `owner/repo` slug from a remote URL for the given host. Handles
 * https(s), ssh, and scp-like (`git@host:owner/repo.git`) forms, with or
 * without a trailing `.git` / slash. Returns `null` when the remote does not
 * belong to `host`.
 */
export function parseRepoSlug(
  host: GitHost,
  remoteUrl: string
): { owner: string; repo: string } | null {
  const s = remoteUrl.trim();
  const hostname = gitHostname(host).replace(/^www\./, '');
  const esc = hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // https://host/owner/repo(.git) | git@host:owner/repo(.git) | ssh://git@host/owner/repo(.git)
  const re = new RegExp(
    `(?:https?://|git@|ssh://git@)(?:www\\.)?${esc}[/:]([^/]+)/([^/]+?)(?:\\.git)?/?$`,
    'i'
  );
  const m = s.match(re);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}
