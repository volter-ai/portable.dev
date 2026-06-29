/**
 * CommandsService unit tests — the enumerator behind the mobile `/` slash-command
 * picker (GET /api/chats/:chatId/commands).
 *
 * Boundary: REAL temp dirs for the repo cwd + the user's global `~/.claude`, plus
 * the in-memory slashCommandRegistry. No SDK, no network.
 *
 * Covers:
 *  - Cold start (no captured session): disk scan of project `.claude/commands` +
 *    project/global `.claude/skills`, with frontmatter descriptions + `name` override.
 *  - CORRECTNESS INVARIANT: global `~/.claude/commands` are NEVER listed (the SDK
 *    doesn't load them under settingSources:['project'] — listing them would offer
 *    commands that silently no-op).
 *  - Authoritative path: when a session has reported its real command set, that set
 *    governs (built-ins surface, disk-only extras drop out), enriched by disk descriptions.
 *  - No repo path → [].
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CommandsService } from '../../../src/services/CommandsService';
import { slashCommandRegistry } from '../../../src/services/ClaudeService/slashCommandRegistry';

let repoDir: string;
let homeDir: string;
let service: CommandsService;

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  slashCommandRegistry.clear();
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-cmds-repo-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-cmds-home-'));

  // Project commands (project tier → loaded).
  write(
    path.join(repoDir, '.claude', 'commands', 'deploy.md'),
    '---\ndescription: Ship the app\nargument-hint: [env] [tag]\n---\nrun the deploy'
  );
  write(path.join(repoDir, '.claude', 'commands', 'bare.md'), 'no frontmatter here');

  // Project skill.
  write(
    path.join(repoDir, '.claude', 'skills', 'pdf-tools', 'SKILL.md'),
    '---\nname: pdf-tools\ndescription: Work with PDFs\n---\nbody'
  );

  // Global skill — frontmatter `name` overrides the directory name.
  write(
    path.join(homeDir, '.claude', 'skills', 'aurora-dir', 'SKILL.md'),
    '---\nname: aurora\ndescription: Global helper\n---\nbody'
  );

  // Global COMMAND — must NEVER be listed (settingSources:['project'] won't load it).
  write(path.join(homeDir, '.claude', 'commands', 'ghost.md'), '---\ndescription: nope\n---\n');

  service = new CommandsService({ homeDir });
});

afterEach(() => {
  slashCommandRegistry.clear();
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('CommandsService cold start (disk scan)', () => {
  it('lists project commands + project/global skills with descriptions', async () => {
    const result = await service.getCommandsForChat(repoDir);
    const byName = Object.fromEntries(result.map((c) => [c.name, c]));

    expect(byName.deploy).toEqual({
      name: 'deploy',
      kind: 'command',
      scope: 'project',
      description: 'Ship the app',
      // `argument-hint` frontmatter → the grey arg hint surfaced in the picker + composer.
      argumentHint: '[env] [tag]',
    });
    // No frontmatter → no description, still listed.
    expect(byName.bare).toEqual({
      name: 'bare',
      kind: 'command',
      scope: 'project',
      description: undefined,
    });
    expect(byName['pdf-tools']).toEqual({
      name: 'pdf-tools',
      kind: 'skill',
      scope: 'project',
      description: 'Work with PDFs',
    });
    // Global skill: frontmatter `name` overrides the dir name `aurora-dir`.
    expect(byName.aurora).toEqual({
      name: 'aurora',
      kind: 'skill',
      scope: 'global',
      description: 'Global helper',
    });
  });

  it('NEVER lists global ~/.claude/commands (correctness invariant)', async () => {
    const result = await service.getCommandsForChat(repoDir);
    expect(result.find((c) => c.name === 'ghost')).toBeUndefined();
  });

  it('orders repo skills, then repo commands, then built-ins (alphabetical within)', async () => {
    const names = (await service.getCommandsForChat(repoDir)).map((c) => c.name);
    // skills → commands → built-ins
    expect(names.slice(0, 4)).toEqual(['aurora', 'pdf-tools', 'bare', 'deploy']);
    expect(names.slice(4)).toEqual(['clear', 'compact', 'context', 'cost', 'usage']);
  });

  it('returns ONLY the built-ins when there is no repo path (always available)', async () => {
    const builtins = ['clear', 'compact', 'context', 'cost', 'usage'];
    const a = await service.getCommandsForChat(undefined);
    expect(a.map((c) => c.name)).toEqual(builtins);
    expect(a.every((c) => c.kind === 'builtin')).toBe(true);
    expect((await service.getCommandsForChat('')).map((c) => c.name)).toEqual(builtins);
    // /compact carries the built-in argument hint (the SDK init / frontmatter never expose it).
    expect(a.find((c) => c.name === 'compact')?.argumentHint).toBe(
      '<optional custom summarization instructions>'
    );
  });
});

describe('CommandsService union with the SDK-captured list', () => {
  it('adds SDK-reported names (incl. plugin commands) without dropping disk/built-ins', async () => {
    slashCommandRegistry.record(repoDir, {
      // `plugin-x` is reported by the SDK but not on disk; `pdf-tools` is a skill.
      slashCommands: ['deploy', 'compact', 'pdf-tools', 'plugin-x'],
      skills: ['pdf-tools'],
    });

    const result = await service.getCommandsForChat(repoDir);
    const byName = Object.fromEntries(result.map((c) => [c.name, c]));

    // Disk command keeps its frontmatter description.
    expect(byName.deploy).toMatchObject({
      name: 'deploy',
      kind: 'command',
      description: 'Ship the app',
    });
    // Built-in keeps its static description (the registry name doesn't overwrite it).
    expect(byName.compact).toMatchObject({ name: 'compact', kind: 'builtin' });
    expect(byName.compact.description).toBeTruthy();
    // Skill flagged from the init `skills` array.
    expect(byName['pdf-tools']).toMatchObject({ name: 'pdf-tools', kind: 'skill' });
    // Registry-only command the SDK reported but not on disk → still offered (it runs).
    expect(byName['plugin-x']).toMatchObject({ name: 'plugin-x', kind: 'builtin' });
    // Disk extras are KEPT — the union never filters out something that loads.
    expect(byName.bare).toBeDefined();
    expect(byName.aurora).toBeDefined();
  });

  it('still returns built-ins + disk when the captured set is empty', async () => {
    slashCommandRegistry.record(repoDir, { slashCommands: [], skills: [] });
    const names = (await service.getCommandsForChat(repoDir)).map((c) => c.name);
    for (const n of ['aurora', 'bare', 'deploy', 'pdf-tools', 'compact', 'clear']) {
      expect(names).toContain(n);
    }
  });
});
