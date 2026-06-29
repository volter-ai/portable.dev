/**
 * In-memory registry of the slash commands + skills the Claude Agent SDK reported
 * for a given repo (cwd), captured from each session's `system/init` message
 * (`slash_commands` + `skills`).
 *
 * This is the AUTHORITATIVE list of what will actually execute: it reflects the
 * SDK's real discovery given our `settingSources: ['project']` + `skills: 'all'`
 * config (see ExecutionHandler). A naive disk scrape could list global
 * `~/.claude/commands/*.md`, which the SDK does NOT load with `['project']` — so
 * those would render in the picker yet never run. The init list never has that gap.
 *
 * Process-local + single-user (the api runs on the user's own PC, one identity).
 * Keyed by the repo cwd so every chat in the same repo reuses the captured list.
 * Powers `GET /api/chats/:chatId/commands` (the mobile `/` picker).
 */

export interface CapturedCommands {
  /** Names from the SDK init `slash_commands` array (built-in + custom + skills). */
  slashCommands: string[];
  /** Names from the SDK init `skills` array (enabled Agent Skills). */
  skills: string[];
}

const byRepo = new Map<string, CapturedCommands>();

function normalizeKey(repoPath: string | undefined | null): string {
  return (repoPath ?? '').trim();
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export const slashCommandRegistry = {
  /**
   * Record the SDK-reported commands/skills for a repo cwd (called once per session
   * at `system/init`). No-op when `repoPath` is empty. Tolerant of missing fields.
   */
  record(repoPath: string | undefined | null, captured: Partial<CapturedCommands>): void {
    const key = normalizeKey(repoPath);
    if (!key) return;
    byRepo.set(key, {
      slashCommands: toStringArray(captured.slashCommands),
      skills: toStringArray(captured.skills),
    });
  },

  /** The captured list for a repo cwd, or `null` if no session has run there yet. */
  get(repoPath: string | undefined | null): CapturedCommands | null {
    const key = normalizeKey(repoPath);
    if (!key) return null;
    return byRepo.get(key) ?? null;
  },

  /** Test helper — clears all captured entries. */
  clear(): void {
    byRepo.clear();
  },
};
