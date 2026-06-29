/**
 * Server-side repo owner filter (local-first decluttering).
 *
 * The api runs on the user's OWN PC (single-user), so it can hide repos the user
 * doesn't want to see in the lists WITHOUT any mobile-app change — the Play Store
 * client never sends a `blockedOrgs` param, but the PC can apply its own filter.
 *
 * Config lives in a plain JSON file under DATA_DIR (`~/.portable/repo-filter.json`)
 * = a JSON array of owner logins to hide, where the literal `"*"` means "hide
 * EVERY organization-owned repo". Examples:
 *   ["*"]                       → only personal + local repos show (hide all orgs)
 *   ["acme", "widgets-inc"]     → hide just those two orgs
 *   []  / missing / invalid     → no filtering
 *
 * LOCAL repos are ALWAYS kept (so a locally-cloned/linked org repo still shows),
 * and personal (User-owned) repos are kept unless their login is explicitly
 * listed. The user edits the file and restarts `portable start` to apply it.
 */
import { promises as fs } from 'fs';
import path from 'path';

import { resolveDataDir } from '@vgit2/shared/secrets';

/** File name (under DATA_DIR) holding the owner-filter config. */
export const REPO_FILTER_FILENAME = 'repo-filter.json';

export interface RepoOwnerFilterConfig {
  /** Hide ALL organization-owned repos (the `"*"` wildcard entry). */
  blockAllOrgs: boolean;
  /** Specific owner logins to hide (non-wildcard entries). */
  blockedLogins: string[];
}

const EMPTY_CONFIG: RepoOwnerFilterConfig = { blockAllOrgs: false, blockedLogins: [] };

/** Absolute path to the repo-filter config file (under DATA_DIR). */
export function repoFilterConfigPath(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, REPO_FILTER_FILENAME);
}

/**
 * Read + parse the owner-filter config. Accepts a JSON array of strings; the
 * literal `"*"` enables {@link RepoOwnerFilterConfig.blockAllOrgs}. A missing,
 * unreadable, or malformed file resolves to {@link EMPTY_CONFIG} — NEVER throws
 * (a bad config must never break the repos list).
 */
export async function loadRepoOwnerFilter(
  configPath: string = repoFilterConfigPath()
): Promise<RepoOwnerFilterConfig> {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY_CONFIG;
    const entries = parsed
      .filter((e): e is string => typeof e === 'string')
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
    return {
      blockAllOrgs: entries.includes('*'),
      blockedLogins: entries.filter((e) => e !== '*'),
    };
  } catch {
    return EMPTY_CONFIG;
  }
}

/** The minimal repo shape the owner-filter inspects. */
interface FilterableRepo {
  isLocal?: boolean;
  owner?: { login?: string; type?: string } | null;
}

/**
 * Apply the owner filter to an (already locally-enriched) repo list. A repo is
 * HIDDEN when it is NOT local AND either:
 *   - {@link RepoOwnerFilterConfig.blockAllOrgs} is on and its owner is an
 *     Organization (`owner.type === 'Organization'`), or
 *   - its owner login is in {@link RepoOwnerFilterConfig.blockedLogins}.
 * Local repos are always kept. Returns the input unchanged when nothing is
 * configured (no allocation in the common case).
 */
export function applyRepoOwnerFilter<T extends FilterableRepo>(
  repos: T[],
  config: RepoOwnerFilterConfig
): T[] {
  if (!config.blockAllOrgs && config.blockedLogins.length === 0) return repos;
  return repos.filter((repo) => {
    if (repo.isLocal) return true; // never hide a local repo
    const login = repo.owner?.login;
    if (config.blockAllOrgs && repo.owner?.type === 'Organization') return false;
    if (login && config.blockedLogins.includes(login)) return false;
    return true;
  });
}
