import { execSync } from 'child_process';
import fsSync from 'fs';
import path from 'path';

import { NVM_BIN } from '@vgit2/shared/constants';

/**
 * NpxCommandDetector
 *
 * Utility for detecting the correct npx command path.
 * Handles NVM, system node, and Docker environments.
 */
export class NpxCommandDetector {
  private npxCommand: string;

  constructor() {
    this.npxCommand = this.detectNpxCommand();
  }

  /**
   * Get the detected npx command path
   */
  public getCommand(): string {
    return this.npxCommand;
  }

  /**
   * Detect the correct npx command path
   * This handles NVM, system node, and Docker environments
   */
  private detectNpxCommand(): string {
    const isWindows = process.platform === 'win32';
    // Windows uses `where` (not `which`), and the SPAWNABLE binary is `npx.cmd`
    // (the extensionless `npx` in the same dir is a bash script that Node/the SDK
    // can't spawn). Query `npx.cmd` specifically on Windows.
    const lookup = isWindows ? 'where npx.cmd' : 'which npx';
    try {
      const out = execSync(lookup, { encoding: 'utf-8' }).trim();
      // `where` can print several matches (one per line); prefer a `.cmd`, else
      // the first non-empty line.
      const lines = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const first = isWindows
        ? (lines.find((l) => l.toLowerCase().endsWith('.cmd')) ?? lines[0])
        : lines[0];
      if (first) {
        return first;
      }
    } catch {
      console.warn(
        `[NpxCommandDetector] Could not find npx via "${isWindows ? 'where' : 'which'}", trying fallbacks`
      );
    }

    // Platform-specific fallback locations.
    const fallbackPaths = (
      isWindows
        ? [
            process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'npx.cmd') : null,
            process.env.ProgramFiles
              ? path.join(process.env.ProgramFiles, 'nodejs', 'npx.cmd')
              : null,
            process.env['ProgramFiles(x86)']
              ? path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'npx.cmd')
              : null,
          ]
        : ['/usr/local/bin/npx', '/usr/bin/npx', NVM_BIN ? path.join(NVM_BIN, 'npx') : null]
    ).filter(Boolean) as string[];

    for (const fallbackPath of fallbackPaths) {
      if (fsSync.existsSync(fallbackPath)) {
        return fallbackPath;
      }
    }

    // Last resort: the bare name (`npx`/`npx.cmd`) and hope it's on PATH.
    console.warn(
      '[NpxCommandDetector] Using fallback "npx" command - may not work in all environments'
    );
    return isWindows ? 'npx.cmd' : 'npx';
  }

  /**
   * Verify that npx is available at the detected command path
   * @throws Error if npx is not available
   */
  public verifyNpxAvailable(): void {
    try {
      // Quote the command — a resolved Windows path can contain spaces
      // (e.g. C:\Program Files\nodejs\npx.cmd). execSync runs via the shell.
      execSync(`"${this.npxCommand}" --version`, { encoding: 'utf-8' });
    } catch (error) {
      throw new Error(
        `[NpxCommandDetector] FATAL: npx command not available at ${
          this.npxCommand
        }. Error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
