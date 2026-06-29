import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveOperatorWorkspaceDir } from './config.js';

/**
 * Project linking for the `portable` CLI (`portable link` / `unlink`, and the
 * silent auto-link on `portable` / `portable connect`).
 *
 * "Linking" a directory surfaces it in the Portable app exactly the way the app
 * already discovers local repos — there is NO new storage format:
 *   1. A two-level junction `WORKSPACE_DIR/<owner>/<repo>` → the real dir (owner
 *      from the git remote, else the `local` placeholder). The api's
 *      `GitLocalService.getLocalRepositoriesIn` walks `WORKSPACE_DIR` and accepts
 *      junctions, deriving `owner/repo` from the two dir names — so the link makes
 *      the dir show up as a local repo (and unifies its `~/.claude/projects`
 *      transcripts via realpath).
 *   2. An `owner/repo` entry in `WORKSPACE_DIR/.vgit/repo-views.json` — the app's
 *      "viewed repos" list (`RepoViewTrackerService`).
 *
 * The junction is created with `fs.symlink(target, link, 'junction')`: a real
 * Windows junction (no admin needed) and a plain symlink on POSIX. The api
 * discovers local repos by walking `WORKSPACE_DIR` LIVE per request, so the
 * junction itself is seen on the next repos fetch — but an already-running api
 * keeps two in-memory caches (the repos-list cache + the viewed-repos cache) that
 * hide the change until restart. `runLinkCommand`/`runUnlinkCommand` therefore
 * fire a best-effort loopback `POST /api/repos/rescan`
 * (`notifyRunningInstanceOfRepoChange`) to drop those caches, so a link/unlink
 * shows up WITHOUT a restart when `portable` is running (falling back to a
 * "restart" hint only when it isn't).
 *
 * Every filesystem effect is injectable ({@link ProjectLinkFs}) so the logic is
 * unit-tested against a temp dir / fakes.
 */

/** The owner segment used when a dir has no git remote (mirrors the api's scanner). */
export const LOCAL_PLACEHOLDER_OWNER = 'local';

/** The injectable slice of `fs` this module uses (sync). Defaults to node `fs`. */
export interface ProjectLinkFs {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => string;
  writeFileSync: (p: string, data: string) => void;
  mkdirSync: (p: string, opts: { recursive: boolean }) => void;
  symlinkSync: (target: string, link: string, type: 'junction') => void;
  lstatSync: (p: string) => { isSymbolicLink: () => boolean; isDirectory: () => boolean };
  realpathSync: (p: string) => string;
  /** Remove a file or POSIX symlink. */
  unlinkSync: (p: string) => void;
  /** Remove a directory entry / Windows junction (without touching its target). */
  rmdirSync: (p: string) => void;
  readdirSync: (p: string) => string[];
}

const realFs: ProjectLinkFs = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p) => fs.readFileSync(p, 'utf8'),
  writeFileSync: (p, data) => fs.writeFileSync(p, data),
  mkdirSync: (p, opts) => {
    fs.mkdirSync(p, opts);
  },
  symlinkSync: (target, link, type) => fs.symlinkSync(target, link, type),
  lstatSync: (p) => fs.lstatSync(p),
  realpathSync: (p) => fs.realpathSync(p),
  unlinkSync: (p) => fs.unlinkSync(p),
  rmdirSync: (p) => fs.rmdirSync(p),
  readdirSync: (p) => fs.readdirSync(p),
};

/**
 * Remove a symlink / Windows junction WITHOUT following it into its target.
 *
 * ⚠️ SAFETY (load-bearing): this is the ONLY destructive filesystem op in this
 * module, and it must only ever destroy a LINK — a piece of metadata that points
 * elsewhere — never real data. So it re-asserts, immediately before removing, that
 * the path is a symlink/junction; if it's a real directory (or anything that isn't
 * a link) it THROWS and removes nothing. This is independent of the call-site
 * guards (defense in depth) and closes the gap where `rmdir` on an empty REAL
 * directory would silently delete it. A missing path is a no-op.
 *
 * Removal itself: POSIX symlinks `unlink`; a Windows junction is a directory
 * reparse point that `unlink` rejects (EPERM) but `rmdir` removes safely (the
 * target's contents are untouched). NEVER a recursive remove — that would delete
 * THROUGH the junction into the real target.
 */
function removeLink(p: string, fsi: ProjectLinkFs): void {
  let stat: { isSymbolicLink: () => boolean } | null = null;
  try {
    stat = fsi.lstatSync(p);
  } catch {
    return; // nothing there → nothing to remove
  }
  if (!stat.isSymbolicLink()) {
    // A REAL directory/file is sitting here — refuse. We only ever remove links.
    throw new Error(`refusing to remove ${p}: not a symlink/junction (real path, not metadata)`);
  }
  try {
    fsi.unlinkSync(p);
  } catch {
    fsi.rmdirSync(p);
  }
}

/** Resolve WORKSPACE_DIR the SAME way the api does: env → root .env → ~/claude-workspace. */
export function resolveWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir()
): string {
  const operator = resolveOperatorWorkspaceDir(env);
  const raw = operator && operator.length > 0 ? operator : path.join(homedir, 'claude-workspace');
  const expanded = raw.startsWith('~/') ? path.join(homedir, raw.slice(2)) : raw;
  return path.resolve(expanded);
}

/** A resolved project identity for a directory. */
export interface ProjectName {
  owner: string;
  repo: string;
  /** `owner/repo` — the junction path tail AND the repo-views.json entry. */
  fullName: string;
  /** Whether owner/repo came from the git remote or the `local` placeholder. */
  source: 'remote' | 'placeholder';
}

/** Parse `owner/repo` from a git remote URL (github/ssh/https forms). */
export function parseOwnerRepoFromUrl(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  let m = trimmed.match(/^[a-z0-9_-]+@[^:]+:(.+?)(?:\.git)?\/?$/i); // scp-like: git@host:owner/repo
  if (!m) m = trimmed.match(/^(?:https?|ssh|git):\/\/[^/]+\/(.+?)(?:\.git)?\/?$/i); // url form
  if (!m) return null;
  const parts = m[1].split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
}

/** Read the `origin` remote URL from a repo's `.git/config` (no subprocess). */
function readOriginUrl(dir: string, fsi: ProjectLinkFs): string | null {
  const cfg = path.join(dir, '.git', 'config');
  if (!fsi.existsSync(cfg)) return null;
  let text: string;
  try {
    text = fsi.readFileSync(cfg);
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  let inOrigin = false;
  let url: string | null = null;
  for (const line of lines) {
    const section = line.match(/^\s*\[\s*remote\s+"([^"]+)"\s*\]/i);
    if (section) {
      inOrigin = section[1] === 'origin';
      continue;
    }
    if (/^\s*\[/.test(line)) {
      inOrigin = false;
      continue;
    }
    if (inOrigin) {
      const u = line.match(/^\s*url\s*=\s*(.+?)\s*$/i);
      if (u) url = u[1];
    }
  }
  return url;
}

/**
 * Derive the `owner/repo` for a directory: the git `origin` remote when present,
 * else the `local/<basename>` placeholder (which the api's scanner also uses).
 */
export function deriveProjectName(dir: string, fsi: ProjectLinkFs = realFs): ProjectName {
  const url = readOriginUrl(dir, fsi);
  const parsed = url ? parseOwnerRepoFromUrl(url) : null;
  if (parsed) {
    return {
      owner: parsed.owner,
      repo: parsed.repo,
      fullName: `${parsed.owner}/${parsed.repo}`,
      source: 'remote',
    };
  }
  const base = path.basename(path.resolve(dir));
  return {
    owner: LOCAL_PLACEHOLDER_OWNER,
    repo: base,
    fullName: `${LOCAL_PLACEHOLDER_OWNER}/${base}`,
    source: 'placeholder',
  };
}

/** Case-fold a path for comparison (Windows paths are case-insensitive). */
function foldPath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True if `child` is the same as or nested under `parent`. */
export function isUnder(child: string, parent: string): boolean {
  const c = foldPath(child);
  const p = foldPath(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** True if `dir` resolves to a filesystem / drive root (`/`, `C:\`). */
export function isFilesystemRoot(dir: string): boolean {
  const resolved = path.resolve(dir);
  return path.parse(resolved).root === resolved;
}

/**
 * True if `dir` is (or is under) a protected system directory we must never link:
 * the Windows install dir (covers `C:\WINDOWS\System32`, the cmd/PowerShell cwd),
 * or a common POSIX system root. Drive/fs roots are handled by {@link isFilesystemRoot}.
 */
export function isSystemDir(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const winRoots = [env.SystemRoot, env.windir, 'C:\\Windows'].filter((v): v is string => !!v);
  for (const root of winRoots) {
    if (isUnder(dir, root)) return true;
  }
  const posixRoots = [
    '/usr',
    '/bin',
    '/sbin',
    '/etc',
    '/var',
    '/lib',
    '/opt',
    '/System',
    '/Library',
  ];
  for (const root of posixRoots) {
    if (isUnder(dir, root)) return true;
  }
  return false;
}

/** Classification of a directory for linking decisions. */
export interface DirClassification {
  /** `<dir>/.git` exists (a git repo — required for Portable to display it). */
  isGitRepo: boolean;
  /** `dir` IS the home directory. */
  isHome: boolean;
  /** `dir` is nested under home (and not home itself). */
  isUnderHome: boolean;
  /** `dir` is a filesystem/drive root or a protected system directory. */
  isProtected: boolean;
  /**
   * Eligible for the SILENT auto-link (bare `portable` / `connect`): a git repo
   * UNDER home but not home itself. By construction this excludes `/`, `C:\`,
   * `C:\WINDOWS\System32` (not under home) and home itself.
   */
  autoEligible: boolean;
}

/** Classify a directory against the home dir + system/root exclusions. */
export function classifyDir(
  dir: string,
  opts: { homedir?: string; env?: NodeJS.ProcessEnv; fsi?: ProjectLinkFs } = {}
): DirClassification {
  const home = opts.homedir ?? os.homedir();
  const fsi = opts.fsi ?? realFs;
  const isGitRepo = fsi.existsSync(path.join(dir, '.git'));
  const isHome = foldPath(dir) === foldPath(home);
  const underHome = !isHome && isUnder(dir, home);
  const isProtected = isFilesystemRoot(dir) || isSystemDir(dir, opts.env);
  return {
    isGitRepo,
    isHome,
    isUnderHome: underHome,
    isProtected,
    autoEligible: isGitRepo && underHome && !isHome && !isProtected,
  };
}

// ── repo-views.json helpers ────────────────────────────────────────────────

function repoViewsPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.vgit', 'repo-views.json');
}

function readRepoViews(workspaceDir: string, fsi: ProjectLinkFs): string[] {
  const p = repoViewsPath(workspaceDir);
  if (!fsi.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fsi.readFileSync(p)) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeRepoViews(workspaceDir: string, entries: string[], fsi: ProjectLinkFs): void {
  fsi.mkdirSync(path.join(workspaceDir, '.vgit'), { recursive: true });
  fsi.writeFileSync(repoViewsPath(workspaceDir), `${JSON.stringify(entries, null, 2)}\n`);
}

// ── link / unlink ───────────────────────────────────────────────────────────

export interface LinkResult {
  ok: boolean;
  fullName: string;
  /** The junction path created (or that already existed), if any. */
  junctionPath?: string;
  /** True when the dir was already inside WORKSPACE_DIR (no junction needed). */
  alreadyInWorkspace?: boolean;
  /** True when the junction already existed pointing at the dir (idempotent). */
  alreadyLinked?: boolean;
  /** A human message describing the outcome / why it failed. */
  message: string;
}

export interface LinkProjectOptions {
  dir: string;
  workspaceDir: string;
  fsi?: ProjectLinkFs;
}

/**
 * Low-level link: create the junction (unless the dir already lives under the
 * workspace) and add the repo-views entry. Idempotent. Refuses to clobber a REAL
 * directory sitting at the junction path (a real clone), but replaces a stale link.
 */
export function linkProject(opts: LinkProjectOptions): LinkResult {
  const fsi = opts.fsi ?? realFs;
  const dir = path.resolve(opts.dir);
  const name = deriveProjectName(dir, fsi);

  // Already inside the workspace → the scanner finds it directly; just pin it.
  if (isUnder(dir, opts.workspaceDir)) {
    addRepoView(opts.workspaceDir, name.fullName, fsi);
    return {
      ok: true,
      fullName: name.fullName,
      alreadyInWorkspace: true,
      message: `${name.fullName} is already inside the workspace — pinned it.`,
    };
  }

  const ownerDir = path.join(opts.workspaceDir, name.owner);
  const junctionPath = path.join(ownerDir, name.repo);

  if (fsi.existsSync(junctionPath)) {
    // Resolve what's there. A link to the same dir → idempotent success.
    let isLink = false;
    try {
      isLink = fsi.lstatSync(junctionPath).isSymbolicLink();
    } catch {
      isLink = false;
    }
    if (isLink) {
      if (pointsAt(junctionPath, dir, fsi)) {
        addRepoView(opts.workspaceDir, name.fullName, fsi);
        return {
          ok: true,
          fullName: name.fullName,
          junctionPath,
          alreadyLinked: true,
          message: `${name.fullName} is already linked.`,
        };
      }
      // Stale link to a different target — replace it.
      try {
        removeLink(junctionPath, fsi);
      } catch {
        return {
          ok: false,
          fullName: name.fullName,
          junctionPath,
          message: `A different link already exists at ${junctionPath} and could not be replaced.`,
        };
      }
    } else {
      // A REAL directory (e.g. a real clone) — never clobber it.
      return {
        ok: false,
        fullName: name.fullName,
        junctionPath,
        message: `A real directory already exists at ${junctionPath}; refusing to overwrite it.`,
      };
    }
  }

  try {
    fsi.mkdirSync(ownerDir, { recursive: true });
    fsi.symlinkSync(dir, junctionPath, 'junction');
  } catch (err) {
    return {
      ok: false,
      fullName: name.fullName,
      junctionPath,
      message: `Failed to create the junction: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  addRepoView(opts.workspaceDir, name.fullName, fsi);
  return {
    ok: true,
    fullName: name.fullName,
    junctionPath,
    message: `Linked ${name.fullName}.`,
  };
}

export interface UnlinkResult {
  ok: boolean;
  fullName: string;
  removedJunction: boolean;
  removedView: boolean;
  message: string;
}

/**
 * Low-level unlink: remove the junction IF it is a link pointing at this dir (never
 * deletes a real directory) and drop the repo-views entry. Idempotent.
 */
export function unlinkProject(opts: LinkProjectOptions): UnlinkResult {
  const fsi = opts.fsi ?? realFs;
  const dir = path.resolve(opts.dir);
  const name = deriveProjectName(dir, fsi);
  const junctionPath = path.join(opts.workspaceDir, name.owner, name.repo);

  let removedJunction = false;
  if (fsi.existsSync(junctionPath)) {
    let isLink = false;
    try {
      isLink = fsi.lstatSync(junctionPath).isSymbolicLink();
    } catch {
      isLink = false;
    }
    // Only remove a LINK that points at this dir — never a real directory.
    if (isLink && pointsAt(junctionPath, dir, fsi)) {
      try {
        removeLink(junctionPath, fsi);
        removedJunction = true;
      } catch {
        // leave it; report below
      }
    }
  }

  const removedView = removeRepoView(opts.workspaceDir, name.fullName, fsi);

  const ok = removedJunction || removedView;
  return {
    ok,
    fullName: name.fullName,
    removedJunction,
    removedView,
    message: ok ? `Unlinked ${name.fullName}.` : `${name.fullName} was not linked.`,
  };
}

/** True if the symlink/junction at `linkPath` resolves to the same dir as `dir`. */
function pointsAt(linkPath: string, dir: string, fsi: ProjectLinkFs): boolean {
  try {
    return foldPath(fsi.realpathSync(linkPath)) === foldPath(fsi.realpathSync(dir));
  } catch {
    return false;
  }
}

function addRepoView(workspaceDir: string, fullName: string, fsi: ProjectLinkFs): void {
  const entries = readRepoViews(workspaceDir, fsi);
  if (!entries.includes(fullName)) {
    entries.push(fullName);
    writeRepoViews(workspaceDir, entries, fsi);
  }
}

function removeRepoView(workspaceDir: string, fullName: string, fsi: ProjectLinkFs): boolean {
  const entries = readRepoViews(workspaceDir, fsi);
  const next = entries.filter((e) => e !== fullName);
  if (next.length === entries.length) return false;
  writeRepoViews(workspaceDir, next, fsi);
  return true;
}
