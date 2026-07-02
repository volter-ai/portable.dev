/**
 * ClaudeHooksInstaller — rev12 D53.
 *
 * The installer edits the user's REAL ~/.claude/settings.json, so the contract
 * under test is safety: additive (user hooks preserved), idempotent
 * (unchanged on re-run), self-upgrading (stale Portable entries replaced),
 * and fail-safe (an unparseable file is never rewritten).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  buildHookRelayCommand,
  installClaudeHooks,
  mergePortableHooks,
  PORTABLE_HOOK_EVENTS,
} from '../src/ClaudeHooksInstaller.js';

let dir: string;
let settingsPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-hooks-'));
  settingsPath = path.join(dir, 'settings.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const CMD = '"/opt/bun" "/opt/portable/cli.ts" hook-relay';

function readSettings(): any {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

describe('buildHookRelayCommand', () => {
  test('quotes the runtime and cli entry and appends hook-relay', () => {
    expect(buildHookRelayCommand('/usr/local/bin/bun', '/Users/x y/cli.ts')).toBe(
      '"/usr/local/bin/bun" "/Users/x y/cli.ts" hook-relay'
    );
  });

  test('embeds the absolute bridge path (B2) when provided, quoted', () => {
    expect(
      buildHookRelayCommand('/bin/bun', '/opt/cli.ts', '/Users/x y/.portable/internal-bridge.json')
    ).toBe(
      '"/bin/bun" "/opt/cli.ts" hook-relay --bridge "/Users/x y/.portable/internal-bridge.json"'
    );
  });
});

describe('installClaudeHooks', () => {
  test('creates settings.json with all five lifecycle hooks when missing', () => {
    const result = installClaudeHooks({ settingsPath, command: CMD });
    expect(result.status).toBe('installed');

    const settings = readSettings();
    for (const event of PORTABLE_HOOK_EVENTS) {
      const groups = settings.hooks[event];
      expect(groups).toHaveLength(1);
      expect(groups[0].hooks[0]).toEqual({ type: 'command', command: CMD, timeout: 10 });
    }
  });

  test('is idempotent — second run reports unchanged and does not rewrite', () => {
    installClaudeHooks({ settingsPath, command: CMD });
    const before = fs.readFileSync(settingsPath, 'utf8');
    const second = installClaudeHooks({ settingsPath, command: CMD });
    expect(second.status).toBe('unchanged');
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  test('preserves user-authored hooks and unrelated settings', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        model: 'opus',
        hooks: {
          Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'say done' }] }],
          PreToolUse: [{ hooks: [{ type: 'command', command: 'my-guard' }] }],
        },
      })
    );

    const result = installClaudeHooks({ settingsPath, command: CMD });
    expect(result.status).toBe('installed');

    const settings = readSettings();
    expect(settings.model).toBe('opus');
    // The user's Stop hook survives alongside ours.
    const stopCommands = settings.hooks.Stop.flatMap((g: any) =>
      g.hooks.map((h: any) => h.command)
    );
    expect(stopCommands).toContain('say done');
    expect(stopCommands).toContain(CMD);
    // An event we don't manage is untouched.
    expect(settings.hooks.PreToolUse).toEqual([
      { hooks: [{ type: 'command', command: 'my-guard' }] },
    ]);
  });

  test('replaces a stale Portable entry from an older install path', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: '"/old/bun" "/old/cli.ts" hook-relay' }] }],
        },
      })
    );

    const result = installClaudeHooks({ settingsPath, command: CMD });
    expect(result.status).toBe('installed');

    const settings = readSettings();
    const stopCommands = settings.hooks.Stop.flatMap((g: any) =>
      g.hooks.map((h: any) => h.command)
    );
    expect(stopCommands).toEqual(expect.arrayContaining([CMD]));
    expect(stopCommands).not.toContain('"/old/bun" "/old/cli.ts" hook-relay');
  });

  test('never rewrites an unparseable settings.json', () => {
    fs.writeFileSync(settingsPath, '{ this is not json');
    const result = installClaudeHooks({ settingsPath, command: CMD });
    expect(result.status).toBe('failed');
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ this is not json');
  });

  test('never rewrites a settings.json that is not an object', () => {
    fs.writeFileSync(settingsPath, '["array"]');
    const result = installClaudeHooks({ settingsPath, command: CMD });
    expect(result.status).toBe('failed');
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('["array"]');
  });
});

describe('mergePortableHooks', () => {
  test('reports unchanged when our exact entry is already present in every event', () => {
    const { next } = mergePortableHooks({}, CMD);
    const again = mergePortableHooks(next, CMD);
    expect(again.changed).toBe(false);
  });
});
