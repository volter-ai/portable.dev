import fs from 'fs';
import path from 'path';

import { resolveGitAuthorIdentity } from './ClaudeService/gitAuthorIdentity.js';
import { runGit, GitResourceLimitError } from './git/runGit.js';

import type { AuthService } from './AuthService.js';
import type { ConnectionsService } from './ConnectionsService.js';
import type { RunGitOptions } from './git/runGit.js';
import type { GitLocalService } from './GitLocalService.js';
import type {
  ChangedFile,
  CommitGraphNode,
  CommitRef,
  CommitResponse,
  GetCommitDetailResponse,
  GetCommitGraphResponse,
  GetFileDiffResponse,
  GetWorkingTreeChangesResponse,
  GetWorktreesResponse,
  PullResponse,
  PushResponse,
  StageResponse,
  Worktree,
} from '@vgit2/shared/types';

/**
 * Thrown when a caller-supplied path resolves outside the repo checkout
 * (path-traversal attempt). Routes map this to a deterministic 400, distinct
 * from a genuine git failure (500).
 */
export class PathTraversalError extends Error {
  constructor(readonly suppliedPath: string) {
    super(`Path escapes repository: ${suppliedPath}`);
    this.name = 'PathTraversalError';
  }
}

/**
 * Thrown when a caller-supplied commit-ish is not a plain hex SHA. Guards
 * against git option-injection (e.g. a value beginning with `-`). Routes map
 * this to a deterministic 400.
 */
export class InvalidShaError extends Error {
  constructor(readonly suppliedSha: string) {
    super(`Invalid commit sha: ${suppliedSha}`);
    this.name = 'InvalidShaError';
  }
}

/**
 * Thrown by a stage/unstage mutation when the caller supplies no paths (an
 * empty or non-array `paths`). Routes map this to a deterministic 400 — a
 * no-op mutation is a client error, not a silent success.
 */
export class EmptyPathsError extends Error {
  constructor() {
    super('No paths supplied');
    this.name = 'EmptyPathsError';
  }
}

/**
 * Thrown by {@link SourceControlService.commit} when the supplied commit message
 * is empty (or whitespace-only). Routes map this to a deterministic 400 — an
 * empty-message commit is a client error.
 */
export class EmptyCommitMessageError extends Error {
  constructor() {
    super('Commit message is required');
    this.name = 'EmptyCommitMessageError';
  }
}

/**
 * Thrown by {@link SourceControlService.commit} when nothing is staged. Routes
 * map this to a deterministic 400 — `git commit` would otherwise fail opaquely,
 * so we surface "nothing staged" explicitly.
 */
export class NothingStagedError extends Error {
  constructor() {
    super('Nothing staged to commit');
    this.name = 'NothingStagedError';
  }
}

/**
 * Thrown by {@link SourceControlService.commit} when the resolved repo path is
 * not a git checkout (no `.git`). Routes map this to a deterministic 400.
 */
export class NotAGitRepoError extends Error {
  constructor(readonly repoPath: string) {
    super(`Not a git repository: ${repoPath}`);
    this.name = 'NotAGitRepoError';
  }
}

/**
 * Thrown by {@link SourceControlService.push} when the caller-supplied branch is
 * not a valid ref name (e.g. a value beginning with `-`, which git would parse
 * as an option). Mirrors the {@link InvalidShaError} option-injection guard so
 * every user-supplied argv token in this service is either `--`-separated or
 * validated. Routes map this to a deterministic 400.
 */
export class InvalidBranchError extends Error {
  constructor(readonly suppliedBranch: string) {
    super(`Invalid branch name: ${suppliedBranch}`);
    this.name = 'InvalidBranchError';
  }
}

/**
 * Thrown by {@link SourceControlService.push} while the working tree has
 * unresolved merge conflicts (e.g. after a conflicting pull). Pushing a
 * half-merged tree is never what the user wants — the client must resolve the
 * conflicts (and commit) first. Routes map this to a deterministic 409.
 */
export class MergeConflictsError extends Error {
  constructor() {
    super('Resolve merge conflicts before pushing');
    this.name = 'MergeConflictsError';
  }
}

/** Resource bounds for the commit-graph `git log`. */
const GRAPH_TIMEOUT_MS = 15_000;
const GRAPH_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB
const GRAPH_DEFAULT_LIMIT = 200;

/** Resource bounds for `git status`. */
const STATUS_TIMEOUT_MS = 15_000;
const STATUS_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB

/** Resource bounds for per-file / per-commit diffs (US-006). */
const DIFF_TIMEOUT_MS = 15_000;
const DIFF_MAX_OUTPUT_BYTES = 20 * 1024 * 1024; // 20 MB — diffs can be large

/** Resource bounds for `git worktree list` (US-007). */
const WORKTREE_TIMEOUT_MS = 15_000;
const WORKTREE_MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // 5 MB

/** Resource bounds for stage/unstage mutations (US-013) — index ops, tiny output. */
const MUTATION_TIMEOUT_MS = 15_000;
const MUTATION_MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // 5 MB

/** Resource bounds for push/pull (US-016) — network ops, longer timeout. */
const REMOTE_TIMEOUT_MS = 120_000; // 2 min — network transfer can be slow
const REMOTE_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * The per-command argv prefix for `git push`/`git pull` (US-016): a one-shot
 * inline credential helper that answers with the device-flow token from the
 * `GITHUB_TOKEN` env. The EMPTY first helper clears any ambient helpers
 * (osxkeychain, gh, …) so Portable's token is authoritative; the token itself
 * rides ONLY in the env ({@link gitAuthEnv}) — never in the argv, the remote
 * URL, or logs. Harmless for ssh remotes (the helper is simply never invoked).
 */
const PUSH_PULL_CREDENTIAL_ARGS = [
  '-c',
  'credential.helper=',
  '-c',
  'credential.helper=!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f',
];

/**
 * The env handed to `git push`/`git pull` (US-016). The GitHub token is passed
 * as `GITHUB_TOKEN` (never embedded in the remote URL or logged) for the
 * inline credential helper ({@link PUSH_PULL_CREDENTIAL_ARGS}) to read;
 * `GIT_TERMINAL_PROMPT=0` turns a stale/missing credential into a fast failure
 * instead of a terminal re-prompt that would hang forever.
 */
function gitAuthEnv(token: string): NodeJS.ProcessEnv {
  return {
    GITHUB_TOKEN: token,
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** Prefix git uses for a checked-out local branch in `worktree list --porcelain`. */
const BRANCH_REF_PREFIX = 'refs/heads/';

/** A plain hex commit sha (short or full), used to reject option-injection. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

// A conservative git branch/ref name for the push argv (US-016). Must NOT start
// with `-` (option-injection into `git push origin <branch>`) and is limited to
// the characters a real branch/ref uses. Deliberately stricter than
// git-check-ref-format — it only needs to fence the one value we interpolate.
const BRANCH_NAME_RE = /^(?!-)[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

// `git log` field/record separators. ASCII unit-separator (\x1f) between fields,
// record-separator (\x1e) between commits — chosen over '|' because commit
// subjects, author names, and refs can all legitimately contain a pipe.
const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';
const GRAPH_PRETTY = `format:%H${FIELD_SEP}%P${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%D${FIELD_SEP}%s${RECORD_SEP}`;

export interface GetCommitGraphParams {
  /** Walk all refs (true, default) or just HEAD's history. */
  all?: boolean;
  /** Max commits per page (default 200). */
  limit?: number;
  /** Offset-based cursor (a stringified row offset) for pagination. */
  cursor?: string;
}

/**
 * Identity inputs for {@link SourceControlService.commit} (US-015). The commit
 * is authored as the user's GitHub login, resolved via the connections service
 * (`resolveGitAuthorIdentity`); `jwtUsername` is the fallback when no GitHub
 * login can be resolved.
 */
export interface CommitIdentity {
  /** The authenticated user id (email) — used to resolve the GitHub connection. */
  userId: string;
  /** The user's JWT for fetching connection credentials. */
  authToken?: string;
  /** Fallback author login when the GitHub connection can't be resolved. */
  jwtUsername?: string;
}

/**
 * SourceControlService — isolated git read/write service backing the mobile
 * Source Control + Worktrees tabs (portable.dev#17).
 *
 * Deliberately a NEW, standalone factory: it does NOT modify GitLocalService or
 * any existing route. All plumbing reuses the shared {@link runGit} runner so we
 * inherit its hardened spawn / timeout-SIGKILL / maxOutputBytes behavior without
 * duplicating it.
 *
 * Authentication model: read operations run against the repo's local clone
 * under the workspace dir; write operations (push/pull/commit) authenticate as
 * the user's GitHub identity (token for push/pull, GitHub login for commit
 * authorship), resolved via the injected connectionsService / authService.
 *
 * Endpoint methods (getCommitGraph, getWorkingTreeChanges, getFileDiff,
 * getCommitDetail, listWorktrees, stage/unstage/discard/commit/push/pull) are
 * added incrementally in US-004..US-016.
 */
export class SourceControlService {
  constructor(
    private readonly connectionsService: ConnectionsService,
    private readonly authService: AuthService,
    private readonly gitLocalService?: GitLocalService
  ) {}

  /**
   * Seam for running git against a repo checkout. Centralized so every endpoint
   * method (and tests via a stubbed runner) goes through one place. Mirrors the
   * `gitRunner` seam pattern in GitLocalService.
   */
  protected gitRunner: typeof runGit = runGit;

  /**
   * Run a git command in `repoPath` via the shared runner. Thin wrapper so the
   * endpoint methods don't each repeat cwd wiring; resource limits (timeout,
   * maxOutputBytes) are passed per-call by the caller.
   */
  protected async git(
    repoPath: string,
    args: string[],
    options: RunGitOptions = {}
  ): Promise<string> {
    return this.gitRunner(args, { cwd: repoPath, ...options });
  }

  /**
   * Read the commit DAG (US-004). Walks every ref by default so the mobile graph
   * view can render all branches, not just HEAD's first-parent line.
   *
   * Pagination is offset-based: we request `limit + 1` rows (skipping `cursor`
   * rows) and, if the extra row exists, drop it and expose the next offset as
   * `nextCursor`. A {@link GitResourceLimitError} (timeout / output cap on a huge
   * repo) is caught and surfaced as a degraded empty result rather than a 500 —
   * the caller can distinguish it from a genuine git failure.
   */
  async getCommitGraph(
    repoPath: string,
    params: GetCommitGraphParams = {}
  ): Promise<GetCommitGraphResponse> {
    const all = params.all ?? true;
    const limit =
      Number.isFinite(params.limit) && (params.limit as number) > 0
        ? Math.floor(params.limit as number)
        : GRAPH_DEFAULT_LIMIT;
    const offset = this.parseCursor(params.cursor);

    const args = ['log', all ? '--all' : 'HEAD', '--topo-order', `--max-count=${limit + 1}`];
    if (offset > 0) args.push(`--skip=${offset}`);
    args.push(`--pretty=${GRAPH_PRETTY}`);

    let stdout: string;
    try {
      stdout = await this.git(repoPath, args, {
        timeoutMs: GRAPH_TIMEOUT_MS,
        maxOutputBytes: GRAPH_MAX_OUTPUT_BYTES,
      });
    } catch (err) {
      if (err instanceof GitResourceLimitError) {
        return { nodes: [], degraded: true };
      }
      throw err;
    }

    const parsed = this.parseGraph(stdout);

    // One extra row signals more history — drop it and emit the next offset.
    let nextCursor: string | undefined;
    if (parsed.length > limit) {
      parsed.length = limit;
      nextCursor = String(offset + limit);
    }

    return { nodes: parsed, nextCursor };
  }

  /** Coerce a cursor string into a non-negative integer offset. */
  private parseCursor(cursor?: string): number {
    if (!cursor) return 0;
    const n = Number.parseInt(cursor, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** Parse `git log` output emitted with FIELD_SEP / RECORD_SEP separators. */
  private parseGraph(stdout: string): CommitGraphNode[] {
    const nodes: CommitGraphNode[] = [];
    for (const rawRecord of stdout.split(RECORD_SEP)) {
      const record = rawRecord.replace(/^\s+/, '');
      if (!record) continue;

      const [sha, parentsStr = '', author = '', date = '', decorate = '', subject = ''] =
        record.split(FIELD_SEP);
      if (!sha) continue;

      const trimmedParents = parentsStr.trim();
      nodes.push({
        sha,
        parents: trimmedParents ? trimmedParents.split(' ') : [],
        author,
        date,
        subject,
        refs: this.parseRefs(decorate),
      });
    }
    return nodes;
  }

  /**
   * Parse the `%D` decoration list into typed refs. Examples of a single token:
   *   "HEAD -> main"   → { name: 'main',   type: 'head'   }
   *   "tag: v1.0.0"    → { name: 'v1.0.0', type: 'tag'    }
   *   "origin/main"    → { name: 'origin/main', type: 'remote' }
   *   "feature/x"      → { name: 'feature/x',   type: 'branch' }
   */
  private parseRefs(decorate: string): CommitRef[] {
    const trimmed = decorate.trim();
    if (!trimmed) return [];

    const refs: CommitRef[] = [];
    for (const rawToken of trimmed.split(', ')) {
      const token = rawToken.trim();
      if (!token) continue;

      if (token.startsWith('HEAD -> ')) {
        refs.push({ name: token.slice('HEAD -> '.length), type: 'head' });
      } else if (token === 'HEAD') {
        // Detached HEAD.
        refs.push({ name: 'HEAD', type: 'head' });
      } else if (token.startsWith('tag: ')) {
        refs.push({ name: token.slice('tag: '.length), type: 'tag' });
      } else if (token.startsWith('origin/')) {
        refs.push({ name: token, type: 'remote' });
      } else {
        refs.push({ name: token, type: 'branch' });
      }
    }
    return refs;
  }

  /**
   * Read the working-tree changes (US-005), grouped into the four buckets the
   * mobile Changes surface renders: Conflicts / Staged / Unstaged / Untracked.
   *
   * Uses `git status --porcelain=v2 --branch` — the v2 porcelain is a stable,
   * machine-readable format that exposes the index (staged) and worktree
   * (unstaged) status columns separately, rename pairs, and the branch
   * ahead/behind counters in one call. A file modified both in the index and the
   * worktree (e.g. `MM`) legitimately appears in BOTH the staged and unstaged
   * groups.
   */
  async getWorkingTreeChanges(
    repoPath: string,
    options: { worktree?: string } = {}
  ): Promise<GetWorkingTreeChangesResponse> {
    const cwd = await this.resolveWorktreeCwd(repoPath, options.worktree);
    const stdout = await this.git(cwd, ['status', '--porcelain=v2', '--branch'], {
      timeoutMs: STATUS_TIMEOUT_MS,
      maxOutputBytes: STATUS_MAX_OUTPUT_BYTES,
    });
    return this.parseStatus(stdout);
  }

  /** Map a porcelain v2 status letter (X or Y column) to a ChangedFile status. */
  private mapStatusCode(code: string): ChangedFile['status'] {
    switch (code) {
      case 'A':
        return 'added';
      case 'D':
        return 'deleted';
      case 'R':
      case 'C': // copy carries a previousPath, same shape as a rename
        return 'renamed';
      case 'M':
      case 'T': // type change (e.g. file → symlink) — surfaced as a modification
      default:
        return 'modified';
    }
  }

  /**
   * Parse `git status --porcelain=v2 --branch` output into the grouped response.
   *
   * Header lines (`# branch.head`, `# branch.ab`) give branch + ahead/behind.
   * Entry lines:
   *   `1 <XY> …      <path>`              ordinary change
   *   `2 <XY> … <Xscore> <path>\t<orig>`  rename/copy
   *   `u <XY> …      <path>`              unmerged (conflict)
   *   `? <path>`                          untracked
   *   `! <path>`                          ignored (skipped)
   * X = index/staged column, Y = worktree/unstaged column; `.` means unchanged.
   */
  private parseStatus(stdout: string): GetWorkingTreeChangesResponse {
    const result: GetWorkingTreeChangesResponse = {
      branch: '',
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
    };

    for (const line of stdout.split('\n')) {
      if (!line) continue;

      if (line.startsWith('# ')) {
        if (line.startsWith('# branch.head ')) {
          result.branch = line.slice('# branch.head '.length).trim();
        } else if (line.startsWith('# branch.ab ')) {
          const ab = line.slice('# branch.ab '.length).match(/\+(-?\d+)\s+-(-?\d+)/);
          if (ab) {
            result.ahead = Number.parseInt(ab[1], 10);
            result.behind = Number.parseInt(ab[2], 10);
          }
        }
        continue;
      }

      const kind = line[0];

      if (kind === '?') {
        // `? <path>`
        result.untracked.push({
          path: line.slice(2),
          status: 'untracked',
          staged: false,
        });
        continue;
      }

      if (kind === '!') continue; // ignored

      if (kind === 'u') {
        // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
        const tokens = line.split(' ');
        const path = tokens.slice(10).join(' ');
        if (!path) continue;
        result.conflicted.push({ path, status: 'conflicted', staged: false });
        continue;
      }

      if (kind === '1' || kind === '2') {
        const tokens = line.split(' ');
        const xy = tokens[1] ?? '..';
        const x = xy[0];
        const y = xy[1];

        let path: string;
        let previousPath: string | undefined;
        if (kind === '2') {
          // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\t<origPath>`
          const pair = tokens.slice(9).join(' ');
          const [newPath, origPath] = pair.split('\t');
          path = newPath;
          previousPath = origPath;
        } else {
          // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
          path = tokens.slice(8).join(' ');
        }
        if (!path) continue;

        // X column → staged change; Y column → unstaged change. A file can be in
        // both (the index and worktree differ independently).
        if (x && x !== '.') {
          const file: ChangedFile = {
            path,
            status: this.mapStatusCode(x),
            staged: true,
          };
          if (previousPath) file.previousPath = previousPath;
          result.staged.push(file);
        }
        if (y && y !== '.') {
          result.unstaged.push({
            path,
            status: this.mapStatusCode(y),
            staged: false,
          });
        }
      }
    }

    return result;
  }

  /**
   * The unified diff for a single file (US-006).
   *
   * `staged: true` diffs the index against HEAD (`git diff --cached`); otherwise
   * the worktree against the index (`git diff`). `filePath` is repo-relative and
   * is path-traversal-guarded against the checkout before it is handed to git.
   *
   * `options.worktree` (US-007) optionally scopes the diff to a linked git
   * worktree (an absolute path inside the main checkout); `filePath` is then
   * relative to — and guarded against — that worktree. Omitted = the main
   * checkout.
   */
  async getFileDiff(
    repoPath: string,
    filePath: string,
    options: { staged?: boolean; worktree?: string } = {}
  ): Promise<GetFileDiffResponse> {
    const cwd = await this.resolveWorktreeCwd(repoPath, options.worktree);
    const relPath = this.assertInsideRepo(cwd, filePath);

    const args = ['diff'];
    if (options.staged) args.push('--cached');
    args.push('--', relPath);

    let diff = await this.git(cwd, args, {
      timeoutMs: DIFF_TIMEOUT_MS,
      maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
    });

    // A brand-new UNTRACKED file isn't in the index/HEAD, so `git diff` is empty
    // and the diff screen would show nothing. Fall back to an all-additions diff
    // (`git diff --no-index`) so the user sees the new file's content. Gated on
    // the file actually being untracked — an UNCHANGED tracked file must stay
    // empty, not render its whole body as additions.
    if (!options.staged && diff.trim() === '' && !(await this.isTracked(cwd, relPath))) {
      diff = await this.untrackedFileDiff(cwd, relPath);
    }

    return { path: relPath, diff };
  }

  /**
   * Is `relPath` tracked in the index? (`git ls-files --error-unmatch` exits
   * non-zero — which {@link git} rejects — for an untracked path.)
   */
  private async isTracked(cwd: string, relPath: string): Promise<boolean> {
    try {
      await this.git(cwd, ['ls-files', '--error-unmatch', '--', relPath], {
        timeoutMs: STATUS_TIMEOUT_MS,
        maxOutputBytes: STATUS_MAX_OUTPUT_BYTES,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * An all-additions diff for an untracked file: `git diff --no-index` compares
   * it against `/dev/null`. That command exits 1 when the files differ (the
   * normal case for a non-empty new file), so exit 1 is allowed; any genuine
   * failure (missing file, binary) degrades to an empty diff.
   */
  private async untrackedFileDiff(cwd: string, relPath: string): Promise<string> {
    try {
      return await this.git(cwd, ['diff', '--no-index', '--', '/dev/null', relPath], {
        timeoutMs: DIFF_TIMEOUT_MS,
        maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
        allowExitCodes: [0, 1],
      });
    } catch {
      return '';
    }
  }

  /**
   * Stage the given repo-relative paths (US-013) — `git add -- <paths>`. Each
   * path is path-traversal-guarded against the checkout before it reaches git,
   * and the `--` separator stops a path beginning with `-` from being parsed as
   * a git option. `options.worktree` scopes the op to a linked worktree (the
   * same containment guard as the reads); omitted → the main checkout.
   */
  async stage(
    repoPath: string,
    paths: string[],
    options: { worktree?: string } = {}
  ): Promise<StageResponse> {
    return this.runPathMutation(repoPath, paths, options.worktree, (rel) => ['add', '--', ...rel]);
  }

  /**
   * Unstage the given repo-relative paths (US-013) — `git restore --staged --
   * <paths>` (restores the index entries from HEAD). Same path guarding +
   * worktree scoping as {@link stage}.
   */
  async unstage(
    repoPath: string,
    paths: string[],
    options: { worktree?: string } = {}
  ): Promise<StageResponse> {
    return this.runPathMutation(repoPath, paths, options.worktree, (rel) => [
      'restore',
      '--staged',
      '--',
      ...rel,
    ]);
  }

  /**
   * Discard the working-tree changes for the given repo-relative paths (US-014,
   * DESTRUCTIVE). Per file status:
   *   - a tracked file's unstaged changes are reverted — `git restore -- <paths>`;
   *   - an untracked file is deleted — `git clean -fd -- <paths>`.
   * The split is decided by a {@link getWorkingTreeChanges} read (the untracked
   * group), so `git restore` — which errors on an unknown pathspec — is only ever
   * handed tracked paths. Every path is path-traversal-guarded and each argv leads
   * with the `--` pathspec separator. `options.worktree` scopes the op to a linked
   * worktree (same containment guard as the reads); omitted → the main checkout.
   */
  async discard(
    repoPath: string,
    paths: string[],
    options: { worktree?: string } = {}
  ): Promise<StageResponse> {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new EmptyPathsError();
    }
    const cwd = await this.resolveWorktreeCwd(repoPath, options.worktree);
    const relPaths = paths.map((p) => this.assertInsideRepo(cwd, p));

    // Classify each requested path: untracked files are deleted (`git clean`),
    // everything else (modified/deleted tracked files) is reverted (`git restore`).
    const changes = await this.getWorkingTreeChanges(repoPath, options);
    const untracked = new Set(changes.untracked.map((f) => f.path));
    const toRestore = relPaths.filter((p) => !untracked.has(p));
    const toClean = relPaths.filter((p) => untracked.has(p));

    const opts: RunGitOptions = {
      timeoutMs: MUTATION_TIMEOUT_MS,
      maxOutputBytes: MUTATION_MAX_OUTPUT_BYTES,
    };

    if (toRestore.length > 0) {
      await this.git(cwd, ['restore', '--', ...toRestore], opts);
    }
    if (toClean.length > 0) {
      await this.git(cwd, ['clean', '-fd', '--', ...toClean], opts);
    }

    return { ok: true, paths: relPaths };
  }

  /**
   * Commit the staged changes (US-015), authored as the user's GitHub identity.
   *
   * The author is resolved via the shared `resolveGitAuthorIdentity` helper (the
   * active GitHub connection's login, falling back to the JWT username) and
   * applied as a PER-COMMAND identity
   * (`git -c user.name=<login> -c user.email=<login>@users.noreply.github.com
   * commit -m <message>`) — we NEVER mutate the repo's shared git config. The
   * `<login>@users.noreply.github.com` form is GitHub's noreply email, so the
   * commit is correctly attributed to the user's GitHub account.
   *
   * Validates that the path is a git checkout and that something is staged before
   * committing, so the failure modes are deterministic (empty message → 400,
   * nothing staged → 400) rather than an opaque git error.
   */
  async commit(
    repoPath: string,
    message: string,
    identity: CommitIdentity
  ): Promise<CommitResponse> {
    const trimmed = (message ?? '').trim();
    if (!trimmed) throw new EmptyCommitMessageError();

    // Validate this is a git checkout (the route already 404s a missing repo dir).
    if (!fs.existsSync(path.join(repoPath, '.git'))) {
      throw new NotAGitRepoError(repoPath);
    }

    // Nothing staged → deterministic 400 (rather than letting `git commit` fail).
    const status = await this.getWorkingTreeChanges(repoPath);
    if (status.staged.length === 0) throw new NothingStagedError();

    const author = await resolveGitAuthorIdentity(this.connectionsService, {
      userId: identity.userId,
      authToken: identity.authToken,
      fallbackUsername: identity.jwtUsername || identity.userId,
    });

    const opts: RunGitOptions = {
      timeoutMs: MUTATION_TIMEOUT_MS,
      maxOutputBytes: MUTATION_MAX_OUTPUT_BYTES,
    };

    // Per-command identity — never mutate the repo's shared user.name/user.email.
    await this.git(
      repoPath,
      [
        '-c',
        `user.name=${author.name}`,
        '-c',
        `user.email=${author.email}`,
        'commit',
        '-m',
        trimmed,
      ],
      opts
    );

    const sha = (await this.git(repoPath, ['rev-parse', 'HEAD'], opts)).trim();
    return { sha, branch: status.branch, author: author.name };
  }

  /**
   * Push the local branch to its remote (US-016), authenticating as the user's
   * GitHub identity. The token is passed to git via the `GITHUB_TOKEN` env only
   * ({@link gitAuthEnv}), read by the one-shot inline credential helper
   * ({@link PUSH_PULL_CREDENTIAL_ARGS}) — never embedded in the remote URL or
   * logged.
   *
   * `options.branch` + `options.setUpstream` push that branch to `origin` and
   * set its upstream (the first push of a new branch); omitted pushes the current
   * branch to its configured upstream — and when that branch has NO upstream yet
   * (the normal state of a fresh worktree branch) the push automatically becomes
   * `git push --set-upstream origin <current branch>` instead of failing.
   * `options.worktree` scopes the push to a linked worktree (same containment
   * guard as the reads); omitted → the main checkout.
   *
   * A tree with unresolved merge conflicts (e.g. after a conflicting pull)
   * refuses to push ({@link MergeConflictsError}) — resolve first. After the
   * push we re-read the working-tree status so the response carries the updated
   * ahead/behind counters.
   */
  async push(
    repoPath: string,
    options: { branch?: string; setUpstream?: boolean; worktree?: string },
    token: string
  ): Promise<PushResponse> {
    if (options.branch !== undefined && !BRANCH_NAME_RE.test(options.branch)) {
      throw new InvalidBranchError(options.branch);
    }
    const cwd = await this.resolveWorktreeCwd(repoPath, options.worktree);

    // Conflict gate: pushing a half-merged tree is never right — the client
    // shows the Conflicts group and blocks Push, this is the server-side guard.
    const preStatus = await this.getWorkingTreeChanges(cwd);
    if (preStatus.conflicted.length > 0) {
      throw new MergeConflictsError();
    }

    const args = [...PUSH_PULL_CREDENTIAL_ARGS, 'push'];
    if (options.setUpstream && options.branch) {
      args.push('--set-upstream', 'origin', options.branch);
    } else if (options.branch) {
      args.push('origin', options.branch);
    } else if (
      !(await this.hasUpstream(cwd)) &&
      preStatus.branch &&
      BRANCH_NAME_RE.test(preStatus.branch)
    ) {
      // No configured upstream (a fresh worktree branch): publish it instead of
      // surfacing git's "no upstream branch" failure. A detached/unnameable HEAD
      // falls through to the plain push and keeps git's own error.
      args.push('--set-upstream', 'origin', preStatus.branch);
    }

    await this.git(cwd, args, {
      timeoutMs: REMOTE_TIMEOUT_MS,
      maxOutputBytes: REMOTE_MAX_OUTPUT_BYTES,
      env: gitAuthEnv(token),
    });

    const status = await this.getWorkingTreeChanges(cwd);
    return { pushed: true, branch: status.branch, ahead: status.ahead, behind: status.behind };
  }

  /** Whether the checkout's current branch has a configured upstream. */
  private async hasUpstream(cwd: string): Promise<boolean> {
    try {
      await this.git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
        timeoutMs: MUTATION_TIMEOUT_MS,
        maxOutputBytes: MUTATION_MAX_OUTPUT_BYTES,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pull (fetch + merge) the current branch from its remote (US-016),
   * authenticating as the user's GitHub identity via {@link gitAuthEnv} + the
   * inline credential helper. `options.worktree` scopes the pull to a linked
   * worktree; omitted → the main checkout.
   *
   * A pull that stops on MERGE CONFLICTS is a first-class outcome, not a 500:
   * git exits non-zero but leaves the tree in the unmerged state, so we re-read
   * the status and — when unmerged files exist — resolve
   * `{ pulled: false, conflicts: true }` (the client surfaces the Conflicts
   * group and blocks Push until they are resolved). Any other pull failure
   * (network, auth, no tracking branch) still throws. After a clean pull we
   * re-read the status so the response carries the updated ahead/behind.
   */
  async pull(
    repoPath: string,
    token: string,
    options: { worktree?: string } = {}
  ): Promise<PullResponse> {
    const cwd = await this.resolveWorktreeCwd(repoPath, options.worktree);

    try {
      await this.git(cwd, [...PUSH_PULL_CREDENTIAL_ARGS, 'pull'], {
        timeoutMs: REMOTE_TIMEOUT_MS,
        maxOutputBytes: REMOTE_MAX_OUTPUT_BYTES,
        env: gitAuthEnv(token),
      });
    } catch (err) {
      const status = await this.tryGetWorkingTreeChanges(cwd);
      if (status && status.conflicted.length > 0) {
        return {
          pulled: false,
          conflicts: true,
          branch: status.branch,
          ahead: status.ahead,
          behind: status.behind,
        };
      }
      throw err;
    }

    const status = await this.getWorkingTreeChanges(cwd);
    return { pulled: true, branch: status.branch, ahead: status.ahead, behind: status.behind };
  }

  /**
   * A status read that never throws — used to classify a failed pull (conflict
   * vs genuine error) without masking the original pull failure.
   */
  private async tryGetWorkingTreeChanges(
    cwd: string
  ): Promise<GetWorkingTreeChangesResponse | null> {
    try {
      return await this.getWorkingTreeChanges(cwd);
    } catch {
      return null;
    }
  }

  /**
   * Shared core of {@link stage}/{@link unstage}: validate the paths, resolve
   * the cwd (main checkout or scoped worktree), path-traversal-guard every path,
   * run the built git command, and echo back the relative paths. The `buildArgs`
   * callback receives the guarded relative paths and returns the full argv —
   * always with a leading `--` pathspec separator so a `-`-prefixed path can
   * never be parsed as an option.
   */
  private async runPathMutation(
    repoPath: string,
    paths: string[],
    worktree: string | undefined,
    buildArgs: (relPaths: string[]) => string[]
  ): Promise<StageResponse> {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new EmptyPathsError();
    }
    const cwd = await this.resolveWorktreeCwd(repoPath, worktree);
    const relPaths = paths.map((p) => this.assertInsideRepo(cwd, p));

    await this.git(cwd, buildArgs(relPaths), {
      timeoutMs: MUTATION_TIMEOUT_MS,
      maxOutputBytes: MUTATION_MAX_OUTPUT_BYTES,
    });

    return { ok: true, paths: relPaths };
  }

  /**
   * The changed files, per-commit unified diff, and additive/deletive stats for
   * a single commit (US-006).
   *
   * Three `git show` invocations keep the parse unambiguous (git collapses to a
   * single stat format when `--name-status` and `--numstat` are combined):
   *   1. `--name-status` → status letter + path(s) (rename = old + new paths)
   *   2. `--numstat`     → per-file insertions/deletions (binary = `-`)
   *   3. patch           → the full unified diff text
   * Status (1) and numstat (2) list files in the SAME order, so we zip by index
   * — this sidesteps git's brace-notation rename paths in numstat by always
   * taking the clean path/previousPath from `--name-status`.
   *
   * No `--no-patch` on (1)/(2): each stat format itself replaces the patch
   * output, and git ≥ 2.39 makes `-s`/`--no-patch` + `--name-status` a fatal
   * "cannot be used together" error (every commit-detail read would 500).
   */
  async getCommitDetail(repoPath: string, sha: string): Promise<GetCommitDetailResponse> {
    if (!SHA_RE.test(sha)) throw new InvalidShaError(sha);

    const opts: RunGitOptions = {
      timeoutMs: DIFF_TIMEOUT_MS,
      maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
    };

    const [statusOut, numstatOut, diff] = await Promise.all([
      this.git(repoPath, ['show', sha, '-M', '--format=', '--name-status'], opts),
      this.git(repoPath, ['show', sha, '-M', '--format=', '--numstat'], opts),
      this.git(repoPath, ['show', sha, '-M', '--format='], opts),
    ]);

    const { files, stats } = this.parseCommitFiles(statusOut, numstatOut);
    return { sha, files, diff: diff.replace(/^\n+/, ''), stats };
  }

  /**
   * Zip `git show --name-status` and `--numstat` output (same file order) into
   * ChangedFile[] + total stats. name-status drives status + path/previousPath;
   * numstat supplies per-file insertion/deletion counts (`-` for binary).
   */
  private parseCommitFiles(
    statusOut: string,
    numstatOut: string
  ): { files: ChangedFile[]; stats: { additions: number; deletions: number } } {
    const statusLines = statusOut.split('\n').filter((l) => l.length > 0);
    const numstatLines = numstatOut.split('\n').filter((l) => l.length > 0);

    const files: ChangedFile[] = [];
    let additions = 0;
    let deletions = 0;

    for (let i = 0; i < statusLines.length; i++) {
      const parts = statusLines[i].split('\t');
      const code = parts[0] ?? '';
      const letter = code[0] ?? 'M';

      let filePath: string;
      let previousPath: string | undefined;
      if ((letter === 'R' || letter === 'C') && parts.length >= 3) {
        previousPath = parts[1];
        filePath = parts[2];
      } else {
        filePath = parts[1] ?? '';
      }
      if (!filePath) continue;

      const file: ChangedFile = {
        path: filePath,
        status: this.mapStatusCode(letter),
        staged: false,
      };
      if (previousPath) file.previousPath = previousPath;

      const num = numstatLines[i]?.split('\t');
      if (num) {
        if (num[0] !== '-') {
          const ins = Number.parseInt(num[0], 10);
          if (Number.isFinite(ins)) {
            file.insertions = ins;
            additions += ins;
          }
        }
        if (num[1] !== '-') {
          const del = Number.parseInt(num[1], 10);
          if (Number.isFinite(del)) {
            file.deletions = del;
            deletions += del;
          }
        }
      }

      files.push(file);
    }

    return { files, stats: { additions, deletions } };
  }

  /**
   * List the repo's git worktrees (US-007, READ-ONLY).
   *
   * `git worktree list --porcelain` emits one blank-line-separated record per
   * worktree; the FIRST record is always the primary checkout, which we flag as
   * `isMain`. A normal single-clone repo therefore returns exactly one entry.
   */
  async listWorktrees(repoPath: string): Promise<GetWorktreesResponse> {
    const stdout = await this.git(repoPath, ['worktree', 'list', '--porcelain'], {
      timeoutMs: WORKTREE_TIMEOUT_MS,
      maxOutputBytes: WORKTREE_MAX_OUTPUT_BYTES,
    });
    return { worktrees: this.parseWorktrees(stdout) };
  }

  /**
   * Parse `git worktree list --porcelain` into Worktree[].
   *
   * Each attribute is its own line (`worktree <path>`, `HEAD <sha>`,
   * `branch refs/heads/<name>`, `bare`, `detached`, `locked [reason]`,
   * `prunable [reason]`); a `worktree` line (or a blank line) starts the next
   * record. The first parsed worktree is the primary checkout (`isMain`).
   */
  private parseWorktrees(stdout: string): Worktree[] {
    const worktrees: Worktree[] = [];
    let current: Worktree | null = null;

    const flush = (): void => {
      if (current && current.path) {
        current.isMain = worktrees.length === 0;
        worktrees.push(current);
      }
      current = null;
    };

    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.replace(/\s+$/, '');
      if (!line) {
        flush();
        continue;
      }

      const spaceIdx = line.indexOf(' ');
      const key = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
      const value = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1);

      if (key === 'worktree') {
        flush(); // finalize any in-progress record
        current = {
          path: value,
          head: '',
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
          isMain: false,
        };
        continue;
      }
      if (!current) continue;

      switch (key) {
        case 'HEAD':
          current.head = value;
          break;
        case 'branch':
          current.branch = value.startsWith(BRANCH_REF_PREFIX)
            ? value.slice(BRANCH_REF_PREFIX.length)
            : value;
          break;
        case 'bare':
          current.bare = true;
          break;
        case 'detached':
          current.detached = true;
          break;
        case 'locked':
          current.locked = true;
          if (value) current.lockedReason = value;
          break;
        case 'prunable':
          current.prunable = true;
          if (value) current.prunableReason = value;
          break;
      }
    }
    flush();

    return worktrees;
  }

  /**
   * Resolve + validate a caller-supplied worktree path against this repo
   * (public wrapper over the {@link resolveWorktreeCwd} containment guard).
   * Used by chat creation to start a chat INSIDE a worktree: returns the
   * absolute path to persist as the chat's cwd, throws
   * {@link PathTraversalError} for anything that is neither inside the checkout
   * nor listed by `git worktree list`.
   */
  async resolveWorktreePath(repoPath: string, worktree: string): Promise<string> {
    return this.resolveWorktreeCwd(repoPath, worktree);
  }

  /**
   * Resolve the cwd a read should run in (US-007). With no `worktree` param this
   * is the main checkout.
   *
   * A linked worktree legitimately lives OUTSIDE the main checkout — git's
   * idiomatic `git worktree add ../feature` layout puts it in a SIBLING dir — so
   * a plain repoPath-containment check (which we keep as the fast path for the
   * nested `.worktrees/<id>` convention) would wrongly reject the standard
   * layout. The `worktree` param is not free text: it is one of the absolute
   * paths git itself reported via {@link listWorktrees}, so an out-of-checkout
   * candidate is accepted ONLY when it matches one of those authoritative paths
   * (canonicalized) — arbitrary directories still throw {@link PathTraversalError}.
   */
  private async resolveWorktreeCwd(repoPath: string, worktree?: string): Promise<string> {
    if (!worktree) return repoPath;
    const normalizedRepo = path.resolve(repoPath);
    const resolved = path.resolve(normalizedRepo, worktree);

    // Fast path: a worktree nested inside the main checkout is trivially safe
    // (no extra git call) — covers Portable's own `.worktrees/<id>` layout.
    if (resolved === normalizedRepo || resolved.startsWith(normalizedRepo + path.sep)) {
      return resolved;
    }

    // Out-of-checkout candidate: accept only if git lists it as a real worktree
    // of THIS repo. Canonicalize both sides so a symlinked path (e.g. macOS
    // /var → /private/var) still matches.
    const canonical = (p: string): string => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    const target = canonical(resolved);
    const { worktrees } = await this.listWorktrees(repoPath);
    const known = worktrees.some((w) => canonical(w.path) === target);
    if (!known) {
      throw new PathTraversalError(worktree);
    }
    return resolved;
  }

  /**
   * Path-traversal guard mirroring GitLocalService.readEnvFile: resolve a
   * repo-relative path against the checkout and reject anything that escapes it.
   * Returns the (relative) path to hand to git as a pathspec.
   */
  private assertInsideRepo(repoPath: string, relPath: string): string {
    const normalizedRepo = path.resolve(repoPath);
    const resolved = path.resolve(normalizedRepo, relPath);
    if (resolved !== normalizedRepo && !resolved.startsWith(normalizedRepo + path.sep)) {
      throw new PathTraversalError(relPath);
    }
    return relPath;
  }
}
