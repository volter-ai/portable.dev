#!/usr/bin/env bun
/**
 * Ralph-runnable launcher smoke test (US-E3-001).
 *
 * Boots the api the way the launcher does — `ApiProcess` spawns `bun
 * packages/api/src/server.ts` in local mode, pinned to 127.0.0.1:VGIT_PORT
 * (API + Socket.IO only, no web bundle) — and asserts that GET /api/health
 * returns a real JSON body with status=ok. This is the "Auto (api spawn +
 * /api/health)" portion of the acceptance criteria; the full one-command boot
 * with a real Clerk device-code login is the post-run live-smoke (manual).
 *
 * Usage:
 *   bun scripts/smoke-launcher.ts            # uses a temp DATA_DIR/WORKSPACE_DIR + port 47877
 *   VGIT_PORT=48123 bun scripts/smoke-launcher.ts
 *
 * Exits 0 on success, 1 on failure.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

// Import only the spawn/health pieces (these do NOT pull in @vgit2/shared, so the
// script runs from the repo root without a hoisted workspace link).
import { ApiProcess, waitForHealth } from '../packages/launcher/src/ApiProcess.js';
import { resolveApiBaseUrl } from '../packages/launcher/src/config.js';

const PORT = process.env.VGIT_PORT?.trim() || '47877';

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-smoke-data-'));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-smoke-ws-'));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEPLOYMENT_MODE: 'local',
    VGIT_PORT: PORT,
    PORTABLE_DATA_DIR: dataDir,
    WORKSPACE_DIR: workspaceDir,
  };
  delete env.DEV_BACKEND_PORT;

  const api = new ApiProcess({ env, log: (line) => console.log(line) });
  let ok = false;
  try {
    api.start();
    const baseUrl = resolveApiBaseUrl(env);
    console.log(`[smoke] waiting for ${baseUrl}/api/health …`);
    const body = await waitForHealth(baseUrl, {
      attempts: 60,
      intervalMs: 500,
      isAlive: () => api.isAlive(),
    });
    if (body.status !== 'ok') {
      throw new Error(`unexpected health body: ${JSON.stringify(body)}`);
    }
    console.log(`[smoke] ✓ /api/health returned: ${JSON.stringify(body)}`);
    ok = true;
  } finally {
    await api.stop().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }

  if (!ok) process.exitCode = 1;
  else console.log('[smoke] PASS');
}

main().catch((err) => {
  console.error(`[smoke] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
