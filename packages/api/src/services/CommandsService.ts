import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { slashCommandRegistry } from './ClaudeService/slashCommandRegistry.js';

import type { SlashCommandInfo } from '@vgit2/shared/types';

/**
 * Core built-in slash commands that ship with claude-code and WORK in the SDK's
 * programmatic (non-interactive) `query()` mode — so they're always offered, with
 * no prior run needed (matching the normal claude-code experience). Kept to the
 * universally-present, doc-confirmed non-interactive set; the SDK's `system/init`
 * `slash_commands` (captured per-repo after a run) refines this with the full real
 * list (incl. any plugin/skill commands), and the SDK already omits interactive
 * commands from that list. See https://code.claude.com/docs/en/agent-sdk/slash-commands.
 */
const BUILTIN_COMMANDS: { name: string; description: string; argumentHint?: string }[] = [
  {
    name: 'compact',
    description: 'Summarize the conversation to free up context',
    // Built-in arg hints are NOT exposed by the SDK init or any frontmatter file, so we
    // carry the (only) one a built-in takes here, matching the claude-code UI.
    argumentHint: '<optional custom summarization instructions>',
  },
  { name: 'clear', description: 'Start a new conversation with empty context' },
  { name: 'context', description: 'Show current context usage' },
  { name: 'usage', description: 'Show session cost and plan usage limits' },
  { name: 'cost', description: 'Show session cost and usage stats' },
];

/**
 * CommandsService — enumerates the slash commands + Agent Skills available to a
 * chat/repo, for the mobile composer's `/` picker (`GET /api/chats/:chatId/commands`
 * and `GET /api/repos/:owner/:repo/commands`).
 *
 * It UNIONS three sources — every entry is something that actually executes, so the
 * picker never offers a no-op:
 *
 *  1. **Built-ins** ({@link BUILTIN_COMMANDS}) — always included (no run needed), like
 *     normal claude-code.
 *  2. **Disk scan** — the cwd repo's `.claude/commands/*.md` (project tier) +
 *     `.claude/skills/<skill>/SKILL.md`, and the user's global
 *     `~/.claude/skills/<skill>/SKILL.md` (enabled via `skills: 'all'`, orthogonal to
 *     `settingSources`). Global `~/.claude/commands` are **deliberately excluded** —
 *     `settingSources: ['project']` means the SDK never loads them.
 *  3. **Authoritative capture** — the SDK's `system/init` `slash_commands` + `skills`
 *     for this repo cwd, recorded by {@link slashCommandRegistry} once a chat has run.
 *     Adds the full real set (incl. plugin commands) and confirms skills.
 *
 * Stateless aside from the shared registry; `homeDir` is injectable for tests.
 */
export class CommandsService {
  private readonly homeDir: string;

  constructor(deps: { homeDir?: string } = {}) {
    this.homeDir = deps.homeDir ?? os.homedir();
  }

  /**
   * The commands + skills available to a chat/repo whose working directory is
   * `repoPath`. The UNION of built-ins (always), the disk scan, and the SDK-captured
   * list. Built-ins are returned even with no `repoPath` (they're always available);
   * repo-scoped commands/skills need the cwd. Never throws — a missing `.claude` dir
   * is the normal "nothing here yet" case.
   */
  async getCommandsForChat(repoPath: string | undefined | null): Promise<SlashCommandInfo[]> {
    const cwd = (repoPath ?? '').trim();
    const byName = new Map<string, SlashCommandInfo>();

    // 1) Core built-ins — always available in normal claude-code, no prior run needed.
    for (const b of BUILTIN_COMMANDS) {
      byName.set(b.name, {
        name: b.name,
        kind: 'builtin',
        scope: 'builtin',
        description: b.description,
        argumentHint: b.argumentHint,
      });
    }

    if (cwd) {
      // 2) Project commands + project/global skills the SDK actually loads (with
      //    descriptions). First-writer-wins, so a built-in name is never overwritten.
      for (const c of await this.scanDisk(cwd)) if (!byName.has(c.name)) byName.set(c.name, c);

      // 3) The SDK's authoritative list captured from a prior run — additive (every
      //    entry is something the SDK reported, so it runs). Names already covered by
      //    a built-in/disk entry keep their richer description.
      const captured = slashCommandRegistry.get(cwd);
      if (captured) {
        const skillSet = new Set(captured.skills);
        for (const name of [...captured.slashCommands, ...captured.skills]) {
          if (!name || byName.has(name)) continue;
          const isSkill = skillSet.has(name);
          byName.set(name, {
            name,
            kind: isSkill ? 'skill' : 'builtin',
            scope: isSkill ? 'global' : 'builtin',
          });
        }
      }
    }

    return this.sort([...byName.values()]);
  }

  /** Scan the dirs the SDK genuinely discovers (see class docblock). */
  private async scanDisk(repoPath: string): Promise<SlashCommandInfo[]> {
    const byName = new Map<string, SlashCommandInfo>();
    // Project tier wins over global on a name clash (added first, never overwritten).
    if (repoPath) {
      for (const c of await this.scanCommandDir(
        path.join(repoPath, '.claude', 'commands'),
        'project'
      ))
        if (!byName.has(c.name)) byName.set(c.name, c);
      for (const s of await this.scanSkillDir(path.join(repoPath, '.claude', 'skills'), 'project'))
        if (!byName.has(s.name)) byName.set(s.name, s);
    }
    if (this.homeDir) {
      // Global SKILLS only — global commands are NOT loaded with settingSources:['project'].
      for (const s of await this.scanSkillDir(
        path.join(this.homeDir, '.claude', 'skills'),
        'global'
      ))
        if (!byName.has(s.name)) byName.set(s.name, s);
    }
    return [...byName.values()];
  }

  /** Each `*.md` under a commands dir → a slash command named after the file. */
  private async scanCommandDir(
    dir: string,
    scope: 'project' | 'global'
  ): Promise<SlashCommandInfo[]> {
    const entries = await this.readDirSafe(dir);
    const out: SlashCommandInfo[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const name = entry.name.replace(/\.md$/i, '');
      const fm = await this.parseFrontmatter(path.join(dir, entry.name));
      out.push({
        name,
        kind: 'command',
        scope,
        description: fm?.description,
        argumentHint: fm?.argumentHint,
      });
    }
    return out;
  }

  /** Each `<name>/SKILL.md` under a skills dir → a skill named after the dir. */
  private async scanSkillDir(
    dir: string,
    scope: 'project' | 'global'
  ): Promise<SlashCommandInfo[]> {
    const entries = await this.readDirSafe(dir);
    const out: SlashCommandInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(dir, entry.name, 'SKILL.md');
      const fm = await this.parseFrontmatter(skillFile);
      if (fm === null) continue; // no SKILL.md → not a skill dir
      // The frontmatter `name` wins over the directory name (Claude Code convention).
      out.push({
        name: fm.name || entry.name,
        kind: 'skill',
        scope,
        description: fm.description,
        argumentHint: fm.argumentHint,
      });
    }
    return out;
  }

  /** `readdir(withFileTypes)`; missing/unreadable dir → `[]` (the normal empty case). */
  private async readDirSafe(dir: string) {
    try {
      return await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  /**
   * Parse the leading `--- … ---` YAML-ish frontmatter for `name`/`description`.
   * Returns `{}` for a file with no frontmatter, and `null` when the file does not
   * exist (the caller uses `null` to mean "not a skill dir"). No YAML dependency —
   * a simple `key: value` line scan, which covers the Claude Code frontmatter.
   */
  private async parseFrontmatter(
    file: string
  ): Promise<{ name?: string; description?: string; argumentHint?: string } | null> {
    let content: string;
    try {
      content = await fs.readFile(file, 'utf-8');
    } catch {
      return null;
    }
    const result: { name?: string; description?: string; argumentHint?: string } = {};
    const lines = content.split(/\r?\n/);
    if (lines[0]?.trim() !== '---') return result;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '---') break;
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line
        .slice(idx + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '');
      if (!value) continue;
      // `argument-hint` (hyphenated, per the Claude Code command/SKILL.md frontmatter)
      // is the grey "what args this takes" hint shown after the command — surfaced as
      // ghost text in the composer + beside the picker option.
      if (key === 'name' || key === 'description') result[key] = value;
      else if (key === 'argument-hint') result.argumentHint = value;
    }
    return result;
  }

  /** Stable order for the picker: skills first, then commands, then built-ins; A→Z within. */
  private sort(items: SlashCommandInfo[]): SlashCommandInfo[] {
    const rank: Record<SlashCommandInfo['kind'], number> = { skill: 0, command: 1, builtin: 2 };
    return [...items].sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
  }
}
