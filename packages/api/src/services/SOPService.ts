import crypto from 'crypto';
import { existsSync } from 'fs';
import { readFile, writeFile, unlink, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';

import { adjectives, animals } from 'unique-names-generator';

import { DEFAULT_SOP } from './constants/defaultSOP.js';

import type { SOPLoadResult } from './types/SOPWorksheet.js';

export class SOPService {
  // Use dictionaries from unique-names-generator library
  private readonly adjectives = adjectives;
  private readonly nouns = animals;

  async loadSOP(repoPath: string | undefined): Promise<SOPLoadResult> {
    if (!repoPath) {
      console.log('[SOPService] No repo path provided, using default SOP');
      return {
        source: 'default',
        content: this.getDefaultSOP(),
      };
    }

    const sopPath = path.join(repoPath, '.volter', 'sop.md');

    try {
      if (!existsSync(sopPath)) {
        console.log(`[SOPService] No SOP file found at ${sopPath}, using default`);
        return {
          source: 'default',
          content: this.getDefaultSOP(),
        };
      }

      const content = await readFile(sopPath, 'utf-8');
      console.log(`[SOPService] Loaded custom SOP from ${sopPath}`);

      return {
        source: 'repo',
        content,
        filePath: sopPath,
      };
    } catch (error) {
      console.warn(`[SOPService] Failed to read SOP file at ${sopPath}:`, error);
      return {
        source: 'default',
        content: this.getDefaultSOP(),
      };
    }
  }

  async createWorksheet(sopContent: string, chatId: string): Promise<string> {
    const worksheetPath = this.getWorksheetPath(chatId);
    const worksheetContent = this.buildWorksheetContent(sopContent, chatId);

    // Ensure /tmp/volter/sop directory exists
    const sopDir = path.dirname(worksheetPath);
    if (!existsSync(sopDir)) {
      await mkdir(sopDir, { recursive: true });
    }

    await writeFile(worksheetPath, worksheetContent, 'utf-8');

    console.log(`[SOPService] Created worksheet for chat ${chatId}: ${worksheetPath}`);
    return worksheetPath;
  }

  async cleanupWorksheet(chatId: string): Promise<void> {
    const worksheetPath = this.getWorksheetPath(chatId);

    try {
      if (existsSync(worksheetPath)) {
        await unlink(worksheetPath);
        console.log(`[SOPService] Deleted worksheet file: ${worksheetPath}`);
      }
    } catch (error) {
      console.warn(`[SOPService] Failed to cleanup worksheet for chat ${chatId}:`, error);
    }
  }

  /**
   * Read the current worksheet content for a chat
   * Used by ChatAnalysisService to provide SOP context to the AI summarizer
   * @param chatId - The chat ID to get worksheet content for
   * @returns Worksheet content if exists, null otherwise
   */
  async readWorksheetContent(chatId: string): Promise<string | null> {
    const worksheetPath = this.getWorksheetPath(chatId);
    try {
      if (existsSync(worksheetPath)) {
        const content = await readFile(worksheetPath, 'utf-8');
        return content;
      }
      return null;
    } catch (error) {
      console.warn(`[SOPService] Failed to read worksheet for chat ${chatId}:`, error);
      return null;
    }
  }

  /**
   * Generate deterministic 3-word filename from chatId
   * Same chatId always produces same filename
   * Path: <tmp>/volter/sop/{adjective}-{adjective}-{noun}.md
   * POSIX keeps the original hardcoded `/tmp`; only Windows (where `/tmp`
   * resolved to a stray `C:\tmp`) uses the OS temp dir (`%TEMP%`).
   */
  private getWorksheetPath(chatId: string): string {
    const filename = this.generateDeterministicName(chatId);
    const tmpBase = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    return path.join(tmpBase, 'volter', 'sop', `${filename}.md`);
  }

  /**
   * Generate deterministic 3-word name from chatId using hash
   * Format: {adjective}-{adjective}-{noun}
   */
  private generateDeterministicName(chatId: string): string {
    // Hash the chatId
    const hash = crypto.createHash('sha256').update(chatId).digest();

    // Use hash bytes to select words
    const adj1Index = hash[0] % this.adjectives.length;
    const adj2Index = hash[1] % this.adjectives.length;
    const nounIndex = hash[2] % this.nouns.length;

    const adj1 = this.adjectives[adj1Index];
    const adj2 = this.adjectives[adj2Index];
    const noun = this.nouns[nounIndex];

    return `${adj1}-${adj2}-${noun}`;
  }

  private buildWorksheetContent(sopContent: string, chatId: string): string {
    const timestamp = new Date().toISOString();

    return `# SOP Worksheet
Chat ID: ${chatId}
Created: ${timestamp}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${sopContent}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## Progress Tracking

Update this section as you complete each step by marking checkboxes [x] and filling in details.

`;
  }

  private getDefaultSOP(): string {
    return DEFAULT_SOP;
  }
}
