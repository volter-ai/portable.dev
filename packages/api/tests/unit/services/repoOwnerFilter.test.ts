/**
 * Unit tests for the server-side repo owner filter (local-first decluttering).
 *
 * Covers `applyRepoOwnerFilter` (the wildcard "hide all orgs" + per-login block,
 * with local repos always exempt) and `loadRepoOwnerFilter` (tolerant parsing of
 * ~/.portable/repo-filter.json — missing/invalid → no filtering).
 */
import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  applyRepoOwnerFilter,
  loadRepoOwnerFilter,
  type RepoOwnerFilterConfig,
} from '../../../src/services/GitHubApiService/utils/repoOwnerFilter';

type Repo = { full_name: string; isLocal?: boolean; owner: { login: string; type: string } };

const personal: Repo = { full_name: 'me/personal', owner: { login: 'me', type: 'User' } };
const orgRemote: Repo = {
  full_name: 'acme/widget',
  owner: { login: 'acme', type: 'Organization' },
};
const orgLocal: Repo = {
  full_name: 'acme/tool',
  isLocal: true,
  owner: { login: 'acme', type: 'Organization' },
};
const otherOrg: Repo = {
  full_name: 'globex/app',
  owner: { login: 'globex', type: 'Organization' },
};

const WILDCARD: RepoOwnerFilterConfig = { blockAllOrgs: true, blockedLogins: [] };

describe('applyRepoOwnerFilter', () => {
  it('wildcard hides org-owned remote repos but KEEPS personal + local repos', () => {
    const out = applyRepoOwnerFilter([personal, orgRemote, orgLocal, otherOrg], WILDCARD);
    expect(out.map((r) => r.full_name)).toEqual(['me/personal', 'acme/tool']);
  });

  it('per-login block hides matching non-local owners, keeps a local one', () => {
    const out = applyRepoOwnerFilter([personal, orgRemote, orgLocal, otherOrg], {
      blockAllOrgs: false,
      blockedLogins: ['acme'],
    });
    // acme/widget hidden; acme/tool kept (local); globex + personal kept.
    expect(out.map((r) => r.full_name)).toEqual(['me/personal', 'acme/tool', 'globex/app']);
  });

  it('empty config returns the list unchanged (same reference)', () => {
    const input = [personal, orgRemote];
    const out = applyRepoOwnerFilter(input, { blockAllOrgs: false, blockedLogins: [] });
    expect(out).toBe(input);
  });
});

describe('loadRepoOwnerFilter', () => {
  async function withTempConfig(
    contents: string | null,
    run: (configPath: string) => Promise<void>
  ): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-filter-'));
    const configPath = path.join(dir, 'repo-filter.json');
    if (contents !== null) await fs.writeFile(configPath, contents, 'utf8');
    try {
      await run(configPath);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it('parses ["*"] as blockAllOrgs', async () => {
    await withTempConfig('["*"]', async (p) => {
      expect(await loadRepoOwnerFilter(p)).toEqual({ blockAllOrgs: true, blockedLogins: [] });
    });
  });

  it('parses a login list (trimming + dropping the wildcard from blockedLogins)', async () => {
    await withTempConfig('["acme", " globex ", "*"]', async (p) => {
      expect(await loadRepoOwnerFilter(p)).toEqual({
        blockAllOrgs: true,
        blockedLogins: ['acme', 'globex'],
      });
    });
  });

  it('returns no-filter for a missing file', async () => {
    await withTempConfig(null, async (p) => {
      expect(await loadRepoOwnerFilter(p)).toEqual({ blockAllOrgs: false, blockedLogins: [] });
    });
  });

  it('returns no-filter for malformed JSON / non-array', async () => {
    await withTempConfig('{ not: valid', async (p) => {
      expect(await loadRepoOwnerFilter(p)).toEqual({ blockAllOrgs: false, blockedLogins: [] });
    });
    await withTempConfig('"just a string"', async (p) => {
      expect(await loadRepoOwnerFilter(p)).toEqual({ blockAllOrgs: false, blockedLogins: [] });
    });
  });
});
