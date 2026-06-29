/**
 * RepoHandler `localOnly` listing.
 *
 * The Home grid AND the Repos tab must list ONLY the repos discovered under
 * WORKSPACE_DIR (`getLocalRepositories`, flat-aware) — never the GitHub account list.
 * `fetchReposWithLocalStatus(localOnly: true)` therefore:
 *   - never touches GitHub (octokit may be null; no token required), and
 *   - returns exactly the discovered local repos (flat + two-level), enriched isLocal,
 *   - honoring the `search` name filter, with hasMore=false (whole set on page 1).
 *
 * Pure unit test (temp dirs + a fake gitLocalService); no network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { RepoHandler } from '../../../src/services/GitHubApiService/handlers/RepoHandler';
import { MockReposCacheService } from '../../setup/mocks/MockReposCacheService.js';

import type { HandlerDependencies } from '../../../src/services/GitHubApiService/types.js';

const USER = 'local@host';

describe('RepoHandler.fetchReposWithLocalStatus — localOnly', () => {
  let tmp: string;
  let handler: RepoHandler;
  let githubTouched = 0;

  // Mix of layouts the flat-aware discovery surfaces: a two-level portable clone,
  // a flat clone whose owner came from the git remote, and a flat clone with no
  // derivable remote (placeholder `local` owner).
  const fixture = [
    { full_name: 'acme/widget', localPath: '' },
    { full_name: 'bruno/emr-rewrite', localPath: '' },
    { full_name: 'local/scratch', localPath: '' },
  ];

  const gitLocalService = {
    getLocalRepositories: async () => fixture,
  };

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-local-only-'));
    for (const r of fixture) {
      const dir = path.join(tmp, r.full_name.replace('/', '__'));
      await fs.mkdir(path.join(dir, '.git'), { recursive: true });
      r.localPath = dir;
    }

    githubTouched = 0;
    const fail = () => {
      githubTouched++;
      throw new Error('localOnly must not touch GitHub');
    };
    const deps: HandlerDependencies = {
      getUserOctokit: fail as any,
      getOctokitForUser: fail as any,
      getCachedToken: () => undefined,
      getGitHubConnectionType: () => undefined,
      handleGitHubApiError: () => false,
    };
    handler = new RepoHandler(new MockReposCacheService() as any, null, null, deps);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('returns ONLY the discovered workspace repos and never calls GitHub', async () => {
    const result = await handler.fetchReposWithLocalStatus(
      null, // no octokit — GitHub is irrelevant
      USER,
      1,
      20,
      undefined, // search
      undefined, // language
      'updated',
      gitLocalService,
      undefined, // authToken
      true, // skipGitOperations (no real git)
      undefined, // blockedOrgs
      true // localOnly
    );

    const names = result.repos.map((r: any) => r.full_name).sort();
    expect(names).toEqual(['acme/widget', 'bruno/emr-rewrite', 'local/scratch']);
    // Every returned repo is a real local clone (enrichment found its `.git`).
    expect(result.repos.every((r: any) => r.isLocal === true)).toBe(true);
    expect(result.hasMore).toBe(false);
    expect(githubTouched).toBe(0);
  });

  it('honors the search name filter in localOnly mode', async () => {
    const result = await handler.fetchReposWithLocalStatus(
      null,
      USER,
      1,
      20,
      'emr', // search
      undefined,
      'updated',
      gitLocalService,
      undefined,
      true,
      undefined,
      true
    );

    expect(result.repos.map((r: any) => r.full_name)).toEqual(['bruno/emr-rewrite']);
    expect(githubTouched).toBe(0);
  });
});
