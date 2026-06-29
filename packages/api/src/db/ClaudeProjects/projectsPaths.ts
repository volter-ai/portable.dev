/**
 * ClaudeProjects path helpers (rev9 Feature 3 / D29).
 *
 * Locate + enumerate the Claude Agent SDK's `~/.claude/projects/<slug>/<session>.jsonl`
 * transcripts. The slug is the chat's `cwd` with EVERY non-`[A-Za-z0-9]` char replaced
 * by `-` — LOSSY and IRREVERSIBLE (`/`, `.`, `_`, `\`, `:` all collapse to `-`), so:
 *  - to LOCATE a transcript from a known (repo_path, session_id) you slug FORWARD, and
 *  - to DISCOVER chats you scan the dirs and read `cwd` from a line INSIDE each file
 *    (never reconstruct the path from the dir name).
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

/** The SDK's lossy slug: every non-alphanumeric char → '-' (matches the CLI on every OS). */
export function slugForCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The Claude config dir the SDK reads/writes. rev9 D30 LOCKS "inherit HOME, never set
 * CLAUDE_CONFIG_DIR", so this resolves the host user's REAL `~/.claude` — the shared
 * store that makes terminal `claude` ⇄ portable transcripts visible to each other. A
 * defensive `CLAUDE_CONFIG_DIR` override is honored if ever set (Q-X1).
 */
export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), '.claude');
}

/** Absolute path to the `projects` dir under the config dir. */
export function projectsDir(configDir: string): string {
  return path.join(configDir, 'projects');
}

/** Absolute path to a chat's transcript, slugging the repo_path forward. */
export function transcriptPath(configDir: string, repoPath: string, sessionId: string): string {
  return path.join(projectsDir(configDir), slugForCwd(repoPath), `${sessionId}.jsonl`);
}

export interface DiscoveredTranscript {
  /** The project dir name (the lossy cwd slug) — NOT a real path; read cwd from inside. */
  slug: string;
  /** The session id == the `<session>.jsonl` filename (sans extension). */
  sessionId: string;
  /** Absolute path to the top-level transcript file. */
  filePath: string;
  /** File mtime (ms) — drives the mtime-indexed cache (re-parse only changed files). */
  mtimeMs: number;
}

/**
 * Enumerate every TOP-LEVEL `<session>.jsonl` transcript under `projects/` (D29b).
 * EXCLUDES sub-agent / workflow sub-sessions — those live UNDER `<session>/subagents/`
 * + `<session>/workflows/` (and a project-level `memory/` dir), so a depth-1-file scan
 * naturally drops them and we never surface a `Task`/workflow as a phantom chat.
 * Returns [] (never throws) when the projects dir is absent.
 */
export async function listProjectTranscripts(configDir: string): Promise<DiscoveredTranscript[]> {
  const root = projectsDir(configDir);
  const out: DiscoveredTranscript[] = [];
  let projectDirs: import('fs').Dirent[];
  try {
    projectDirs = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out; // no projects dir yet
  }
  for (const proj of projectDirs) {
    if (!proj.isDirectory()) continue;
    const slug = proj.name;
    const projPath = path.join(root, slug);
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(projPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Top-level files only: `<session>.jsonl`. Sub-agent/workflow transcripts are
      // nested in subdirs (entry.isDirectory()) and are skipped here.
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionId = entry.name.slice(0, -'.jsonl'.length);
      if (!sessionId) continue;
      const filePath = path.join(projPath, entry.name);
      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.stat(filePath)).mtimeMs;
      } catch {
        continue;
      }
      out.push({ slug, sessionId, filePath, mtimeMs });
    }
  }
  return out;
}
