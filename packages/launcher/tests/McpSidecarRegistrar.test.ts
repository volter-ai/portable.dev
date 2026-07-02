/**
 * McpSidecarRegistrar — rev12 D58/D61.
 *
 * The registrar edits Claude Code's OWN state file (~/.claude.json), so the
 * contract is caution: untouched when already current, `claude mcp add`
 * preferred over a direct write, direct-edit fallback preserves everything
 * else, and an unparseable file is never rewritten.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  desiredSidecarEntry,
  ensureSidecarRegistration,
  SIDECAR_SERVER_NAME,
} from '../src/McpSidecarRegistrar.js';

let dir: string;
let claudeJsonPath: string;

const ENTRY = { command: '/opt/bun', args: ['/opt/portable/cli.ts', 'mcp-sidecar'] };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-mcpreg-'));
  claudeJsonPath = path.join(dir, '.claude.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('desiredSidecarEntry', () => {
  test('re-enters this install via absolute runtime + cli paths', () => {
    expect(desiredSidecarEntry('/usr/bin/bun', '/a/cli.ts')).toEqual({
      command: '/usr/bin/bun',
      args: ['/a/cli.ts', 'mcp-sidecar'],
    });
  });

  test('appends the absolute bridge path as --bridge args (B2)', () => {
    expect(
      desiredSidecarEntry('/usr/bin/bun', '/a/cli.ts', '/home/u/.portable/bridge.json')
    ).toEqual({
      command: '/usr/bin/bun',
      args: ['/a/cli.ts', 'mcp-sidecar', '--bridge', '/home/u/.portable/bridge.json'],
    });
  });
});

describe('ensureSidecarRegistration', () => {
  test('unchanged when the exact entry is already registered (no exec, no write)', () => {
    fs.writeFileSync(
      claudeJsonPath,
      JSON.stringify({ mcpServers: { [SIDECAR_SERVER_NAME]: ENTRY } })
    );
    const before = fs.readFileSync(claudeJsonPath, 'utf8');
    let execs = 0;
    const result = ensureSidecarRegistration({
      claudeJsonPath,
      entry: ENTRY,
      execClaudeMcpAdd: () => {
        execs += 1;
      },
    });
    expect(result.status).toBe('unchanged');
    expect(execs).toBe(0);
    expect(fs.readFileSync(claudeJsonPath, 'utf8')).toBe(before);
  });

  test("prefers `claude mcp add` (the CLI's own writer) — no direct file write", () => {
    fs.writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: {} }));
    const before = fs.readFileSync(claudeJsonPath, 'utf8');
    const added: unknown[] = [];
    const result = ensureSidecarRegistration({
      claudeJsonPath,
      entry: ENTRY,
      execClaudeMcpAdd: (entry) => added.push(entry),
    });
    expect(result.status).toBe('registered');
    expect(added).toEqual([ENTRY]);
    // The registrar itself wrote nothing (the real `claude mcp add` would).
    expect(fs.readFileSync(claudeJsonPath, 'utf8')).toBe(before);
  });

  test('falls back to a direct atomic edit when the claude binary is unavailable', () => {
    fs.writeFileSync(
      claudeJsonPath,
      JSON.stringify({ projects: { '/repo': { history: [1, 2] } }, mcpServers: { other: {} } })
    );
    const result = ensureSidecarRegistration({
      claudeJsonPath,
      entry: ENTRY,
      execClaudeMcpAdd: () => {
        throw new Error('ENOENT');
      },
    });
    expect(result.status).toBe('registered');
    const written = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    // Our entry landed; everything else survived byte-for-byte semantically.
    expect(written.mcpServers[SIDECAR_SERVER_NAME]).toEqual(ENTRY);
    expect(written.mcpServers.other).toEqual({});
    expect(written.projects).toEqual({ '/repo': { history: [1, 2] } });
  });

  test('creates ~/.claude.json when missing (direct-edit path)', () => {
    const result = ensureSidecarRegistration({
      claudeJsonPath,
      entry: ENTRY,
      execClaudeMcpAdd: () => {
        throw new Error('ENOENT');
      },
    });
    expect(result.status).toBe('registered');
    const written = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(written.mcpServers[SIDECAR_SERVER_NAME]).toEqual(ENTRY);
  });

  test('never rewrites an unparseable ~/.claude.json', () => {
    fs.writeFileSync(claudeJsonPath, '{ nope');
    const result = ensureSidecarRegistration({
      claudeJsonPath,
      entry: ENTRY,
      execClaudeMcpAdd: () => {
        throw new Error('ENOENT');
      },
    });
    expect(result.status).toBe('failed');
    expect(fs.readFileSync(claudeJsonPath, 'utf8')).toBe('{ nope');
  });
});
