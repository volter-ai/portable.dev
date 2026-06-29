/**
 * workspaceScaffold — make the Portable WORKSPACE a Claude project.
 *
 * The workspace root (`WORKSPACE_DIR`) is mounted as the cwd for chats, and the Claude
 * Agent SDK auto-reads a `CLAUDE.md` from its cwd (plus we inject it into the system
 * prompt via `getClaudeMdContent`). So we drop two managed `CLAUDE.md` files:
 *
 *   <workspace>/CLAUDE.md       — what Portable is + the workspace taxonomy.
 *   <workspace>/tmp/CLAUDE.md   — how to use the scratch folder for one-off tasks.
 *
 * A home-widget message that isn't about a specific repo is evaluated in `<workspace>/tmp`
 * (see `getWorkspaceTmpDir` + `ChatExecutionService`), so `tmp/CLAUDE.md` is the project
 * context for those one-off / scratch chats.
 *
 * `ensureWorkspaceScaffold` is **idempotent + write-if-absent** (it NEVER overwrites a
 * file the user has edited) and **best-effort** (it never throws — scaffolding must never
 * block chat creation).
 */
import { execFileSync } from 'child_process';
import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';

import { WORKSPACE_TMP_DIR } from '@vgit2/shared/browserConstants';

/** Marker line at the top of a managed file, for humans (we still never clobber edits). */
const MANAGED_MARKER =
  '<!-- Managed by Portable. Safe to edit — Portable will not overwrite it. -->';

const WORKSPACE_CLAUDE_MD = `${MANAGED_MARKER}

# The Portable workspace

You are running inside the **Portable** workspace. Portable is a mobile-first AI IDE: the
backend runs on the user's own PC and the user drives it from the Portable mobile app. When
the user sends a message, the message is "routed" — a request about a specific repository is
evaluated inside that repo's directory, and a generic one-off task is evaluated in the
\`tmp/\` scratch folder below.

## Workspace taxonomy

| Path | What it is |
| ---- | ---------- |
| \`<owner>/<repo>/\` | The user's GitHub repositories (cloned or junctioned here). Each is a Portable project and may have its OWN \`CLAUDE.md\` with project-specific rules — prefer working inside the relevant repo for anything about that codebase. |
| \`tmp/\` | **Scratch space** for one-off tasks, quick experiments, and computer-level work that doesn't belong to any repository (see \`tmp/CLAUDE.md\`). NOT a Portable project. |
| \`.vgit/\` | Portable's project-view metadata (\`repo-views.json\`). Do not edit. |
| \`.chat-data/\` | Portable's chat database. Do not edit. |
| \`data/\` | Generated media. Do not edit. |

## How to work here

- If the task is about a specific repository, do the work **inside that repository's
  directory** (each repo carries its own context/\`CLAUDE.md\`).
- If the task is a generic one-off — a quick script, an experiment, a computer-level task,
  or something that just needs a place to keep documents/state — use \`tmp/\`.
- The repositories above are the user's real projects; treat anything under \`tmp/\` as
  disposable scratch unless the user says otherwise.
`;

const TMP_CLAUDE_MD = `${MANAGED_MARKER}

# Portable workspace — scratch (\`tmp\`)

This is the Portable workspace **scratch folder**. Use it for:

- arbitrary **one-off tasks** that don't belong to any repository,
- quick **code execution** / experiments / throwaway scripts,
- any **computer-level task** (system commands, data wrangling) that just needs a place to
  run and, optionally, to store documents or state.

## Notes

- Anything here is **NOT a Portable project** — it does not appear in the repository list,
  and chats started here show up under the synthetic **"Workspace"** project (they have no
  associated Portable project).
- It's fine to create files and subfolders here; clean up scratch you no longer need.
- The user's real repositories live in the **parent** directory (\`..\`); see \`../CLAUDE.md\`
  for the full workspace layout. If a task turns out to be about a specific repo, prefer
  working inside that repo instead of here.
`;

/** Write `content` to `filePath` only if the file does not already exist. */
async function writeIfAbsent(filePath: string, content: string): Promise<void> {
  if (fsSync.existsSync(filePath)) return;
  await fs.writeFile(filePath, content, 'utf8');
  console.log(`[workspaceScaffold] Wrote ${filePath}`);
}

/**
 * `git init` a directory if it isn't already a git repo (idempotent, best-effort).
 *
 * The scratch (`tmp`) folder is the cwd for one-off chats, and `ExecutionHandler` sets a
 * LOCAL git identity in the cwd before every Claude run — which HARD-THROWS on a non-git
 * directory ("Not a git repository … Cannot configure git user identity"). So the scratch
 * must be a real git repo (the old `simple-task` path created a git-initialised
 * `local/<folder>` project — this restores that for the `tmp` route). Initialising it also
 * lets the agent commit/track scratch work. It is excluded from repo discovery by name
 * (`GitLocalService` skips `tmp`), so it never surfaces as a Portable project.
 */
function ensureGitRepo(dir: string): void {
  if (fsSync.existsSync(path.join(dir, '.git'))) return;
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    console.log(`[workspaceScaffold] git init ${dir}`);
  } catch (error) {
    console.warn(`[workspaceScaffold] git init failed at ${dir}:`, error);
  }
}

/**
 * Ensure the workspace is set up as a Claude project: create the workspace root + the
 * `tmp/` scratch dir and drop the two managed `CLAUDE.md` files if they're missing.
 *
 * Best-effort: any failure is logged and swallowed (never blocks chat creation).
 *
 * @param workspaceDir - The workspace root (`getUserWorkspaceDir()` / `WORKSPACE_DIR`).
 */
export async function ensureWorkspaceScaffold(workspaceDir: string): Promise<void> {
  try {
    const tmpDir = path.join(workspaceDir, WORKSPACE_TMP_DIR);
    await fs.mkdir(tmpDir, { recursive: true }); // also creates the workspace root
    await writeIfAbsent(path.join(workspaceDir, 'CLAUDE.md'), WORKSPACE_CLAUDE_MD);
    await writeIfAbsent(path.join(tmpDir, 'CLAUDE.md'), TMP_CLAUDE_MD);
    // The scratch dir is the cwd for one-off chats; it must be a git repo or the
    // pre-run git-identity config in ExecutionHandler throws (see ensureGitRepo).
    ensureGitRepo(tmpDir);
  } catch (error) {
    console.warn(`[workspaceScaffold] Failed to scaffold workspace at ${workspaceDir}:`, error);
  }
}
