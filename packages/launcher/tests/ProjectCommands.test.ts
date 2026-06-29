/**
 * ProjectCommands tests — the policy layer for `portable link`/`unlink` + the
 * silent auto-link: home/system guards, the git-repo requirement, and the
 * home-dir confirmation. Real temp dirs; confirm + log injected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { autoLinkIfEligible, runLinkCommand, runUnlinkCommand } from '../src/ProjectCommands.js';

let tmp: string;
let home: string;
let workspace: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portable-cmd-test-')));
  home = path.join(tmp, 'home');
  workspace = path.join(home, 'claude-workspace');
  fs.mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeGitRepo(dir: string, remoteUrl?: string): string {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  if (remoteUrl) {
    fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${remoteUrl}\n`);
  }
  return dir;
}

function base(dir: string, extra: Record<string, unknown> = {}) {
  return {
    dir,
    homedir: home,
    env: { WORKSPACE_DIR: workspace } as NodeJS.ProcessEnv,
    log: () => {},
    // Hermetic default: never hit the real loopback notifier (no LocalSecretStore
    // write / no fetch to 127.0.0.1). Tests that care override it.
    notify: async () => false,
    ...extra,
  };
}

function junctionExists(fullName: string): boolean {
  return fs.existsSync(path.join(workspace, ...fullName.split('/')));
}

describe('autoLinkIfEligible', () => {
  it('links a git repo under home (silent)', () => {
    const dir = makeGitRepo(path.join(home, 'code', 'app'), 'https://github.com/me/app.git');
    const res = autoLinkIfEligible(base(dir));
    expect(res?.ok).toBe(true);
    expect(junctionExists('me/app')).toBe(true);
  });

  it('skips the home directory (returns null, no junction)', () => {
    makeGitRepo(home, 'https://github.com/me/home.git');
    expect(autoLinkIfEligible(base(home))).toBeNull();
    expect(junctionExists('me/home')).toBe(false);
  });

  it('skips a non-git dir', () => {
    const dir = path.join(home, 'notes');
    fs.mkdirSync(dir, { recursive: true });
    expect(autoLinkIfEligible(base(dir))).toBeNull();
  });

  it('skips a repo OUTSIDE home', () => {
    const dir = makeGitRepo(path.join(tmp, 'elsewhere', 'app'), 'https://github.com/me/app.git');
    expect(autoLinkIfEligible(base(dir))).toBeNull();
    expect(junctionExists('me/app')).toBe(false);
  });
});

describe('runLinkCommand', () => {
  it('links a normal git project (even outside home — explicit)', async () => {
    const dir = makeGitRepo(path.join(tmp, 'elsewhere', 'app'), 'https://github.com/me/app.git');
    const res = await runLinkCommand(base(dir, { confirm: async () => false }));
    expect(res.ok).toBe(true);
    expect(junctionExists('me/app')).toBe(true);
  });

  it('refuses a non-git directory', async () => {
    const dir = path.join(tmp, 'plain');
    fs.mkdirSync(dir, { recursive: true });
    const res = await runLinkCommand(base(dir));
    expect(res.ok).toBe(false);
    expect(res.message).toContain('not a git');
  });

  it('refuses a filesystem root (protected)', async () => {
    const root = path.parse(process.cwd()).root;
    const res = await runLinkCommand(base(root));
    expect(res.ok).toBe(false);
    expect(res.message).toBe('protected directory');
  });

  it('warns + CANCELS a home-dir link when the user declines', async () => {
    makeGitRepo(home, 'https://github.com/me/home.git');
    let asked = false;
    const res = await runLinkCommand(
      base(home, {
        confirm: async () => {
          asked = true;
          return false;
        },
      })
    );
    expect(asked).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.message).toBe('cancelled');
    expect(junctionExists('me/home')).toBe(false);
  });

  it('links the home dir when the user confirms', async () => {
    makeGitRepo(home, 'https://github.com/me/home.git');
    const res = await runLinkCommand(base(home, { confirm: async () => true }));
    expect(res.ok).toBe(true);
    expect(junctionExists('me/home')).toBe(true);
  });
});

describe('runUnlinkCommand', () => {
  it('unlinks a previously linked project', async () => {
    const dir = makeGitRepo(path.join(tmp, 'elsewhere', 'app'), 'https://github.com/me/app.git');
    await runLinkCommand(base(dir));
    expect(junctionExists('me/app')).toBe(true);

    const res = await runUnlinkCommand(base(dir));
    expect(res.ok).toBe(true);
    expect(junctionExists('me/app')).toBe(false);
  });
});

describe('rescan notification (no-restart path)', () => {
  it('links + nudges the running instance, reporting "no restart needed"', async () => {
    const dir = makeGitRepo(path.join(tmp, 'elsewhere', 'app'), 'https://github.com/me/app.git');
    const lines: string[] = [];
    let notifyCalls = 0;
    const res = await runLinkCommand(
      base(dir, {
        log: (l: string) => lines.push(l),
        notify: async () => {
          notifyCalls++;
          return true;
        },
      })
    );
    expect(res.ok).toBe(true);
    expect(notifyCalls).toBe(1);
    expect(lines.some((l) => l.includes('no restart needed'))).toBe(true);
    expect(lines.some((l) => l.includes('Restart `portable`'))).toBe(false);
  });

  it('falls back to the restart hint when nothing is running', async () => {
    const dir = makeGitRepo(path.join(tmp, 'elsewhere', 'app2'), 'https://github.com/me/app2.git');
    const lines: string[] = [];
    const res = await runLinkCommand(
      base(dir, { log: (l: string) => lines.push(l), notify: async () => false })
    );
    expect(res.ok).toBe(true);
    expect(lines.some((l) => l.includes('Restart `portable`'))).toBe(true);
  });

  it('does NOT nudge when the project was already linked', async () => {
    const dir = makeGitRepo(path.join(tmp, 'elsewhere', 'app3'), 'https://github.com/me/app3.git');
    await runLinkCommand(base(dir));
    let notifyCalls = 0;
    await runLinkCommand(base(dir, { notify: async () => (notifyCalls++, true) }));
    expect(notifyCalls).toBe(0);
  });

  it('unlink nudges the running instance too', async () => {
    const dir = makeGitRepo(path.join(tmp, 'elsewhere', 'app4'), 'https://github.com/me/app4.git');
    await runLinkCommand(base(dir));
    let notifyCalls = 0;
    const lines: string[] = [];
    const res = await runUnlinkCommand(
      base(dir, {
        log: (l: string) => lines.push(l),
        notify: async () => (notifyCalls++, true),
      })
    );
    expect(res.ok).toBe(true);
    expect(notifyCalls).toBe(1);
    expect(lines.some((l) => l.includes('no restart needed'))).toBe(true);
  });
});
