#!/usr/bin/env bun

/**
 * Script to write backend start metadata
 * This tracks when the backend server was last started (in dev mode with --watch)
 */

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// Get git info
let gitCommit = 'unknown';
let gitCommitShort = 'unknown';
let gitBranch = 'unknown';
let gitMessage = 'unknown';
let gitAuthor = 'unknown';
let gitDate = 'unknown';

try {
  gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  gitCommitShort = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
  gitMessage = execSync('git log -1 --pretty=%B', { encoding: 'utf-8' }).trim();
  gitAuthor = execSync('git log -1 --pretty=%an', { encoding: 'utf-8' }).trim();
  gitDate = execSync('git log -1 --pretty=%ci', { encoding: 'utf-8' }).trim();
} catch (error) {
  console.warn('[Backend Start Metadata] Could not get git info:', error);
}

// Get file diff count (unstaged + staged changes)
let totalDiffs = 0;
let unstagedFiles = 0;
let stagedFiles = 0;

try {
  const unstagedOutput = execSync('git diff --name-only', { encoding: 'utf-8' }).trim();
  const stagedOutput = execSync('git diff --cached --name-only', { encoding: 'utf-8' }).trim();

  unstagedFiles = unstagedOutput ? unstagedOutput.split('\n').length : 0;
  stagedFiles = stagedOutput ? stagedOutput.split('\n').length : 0;
  totalDiffs = unstagedFiles + stagedFiles;
} catch (error) {
  console.warn('[Backend Start Metadata] Could not get diff count:', error);
}

// Create metadata object
const metadata = {
  package: 'backend',
  startTime: new Date().toISOString(),
  startTimestamp: Date.now(),
  git: {
    commit: gitCommit,
    commitShort: gitCommitShort,
    branch: gitBranch,
    message: gitMessage,
    author: gitAuthor,
    date: gitDate,
  },
  diffs: {
    total: totalDiffs,
    unstaged: unstagedFiles,
    staged: stagedFiles,
  },
};

// Write to .build-metadata directory in repository root
// Get the repository root (two levels up from scripts/)
const repoRoot = join(import.meta.dir, '..');
const metadataDir = join(repoRoot, '.build-metadata');
mkdirSync(metadataDir, { recursive: true });

const metadataPath = join(metadataDir, 'backend.json');
writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

console.log(`[Backend Start Metadata] Written backend metadata to ${metadataPath}`);
console.log(`[Backend Start Metadata] Commit: ${gitCommitShort} (${gitBranch})`);
console.log(`[Backend Start Metadata] Diffs: ${totalDiffs} files (${unstagedFiles} unstaged, ${stagedFiles} staged)`);
