/**
 * isolateTestDirs — pin WORKSPACE_DIR and DATA_DIR onto throwaway temp dirs, then
 * hard-abort the run if either fails to land somewhere safe (issue #1563).
 *
 * Imported FIRST by the test preload (before the SDK / fetch mocks) so the env is
 * force-set and validated during the import phase — ahead of any test module, or
 * any mock's import side effect, that could load `@vgit2/shared` constants (which
 * freeze `WORKSPACE_DIR` on first read) or delete a directory. Kept as a
 * side-effect module rather than inline in preload so it runs before the other
 * preload imports even if one of those imports later throws.
 *
 * The developer's real `.env` may set `WORKSPACE_DIR` to a directory that
 * CONTAINS this repo; without this force-set a run that skips the preload
 * force-set would let a test `fs.rm` the real workspace. The guard is the backstop
 * for the day the force-set silently stops applying.
 */
import os from 'os';
import path from 'path';

import { assertSafeTestDir } from './assertSafeTestDir';

// Unique per test PROCESS so parallel `bun test` processes never share a dir.
const TEST_WORKSPACE_DIR = path.join(os.tmpdir(), `portable-test-workspace-${process.pid}`);
const TEST_DATA_DIR = path.join(os.tmpdir(), `portable-test-data-${process.pid}`);

// Force-set (override any `.env` value). `WORKSPACE_DIR` is read by
// `@vgit2/shared` constants; `PORTABLE_DATA_DIR` is the highest-precedence input
// to `resolveDataDir()`. `DATA_DIR` is set too for belt-and-suspenders.
process.env.WORKSPACE_DIR = TEST_WORKSPACE_DIR;
process.env.PORTABLE_DATA_DIR = TEST_DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

try {
  assertSafeTestDir('WORKSPACE_DIR', process.env.WORKSPACE_DIR);
  assertSafeTestDir('DATA_DIR (PORTABLE_DATA_DIR)', process.env.PORTABLE_DATA_DIR);
} catch (err) {
  // Refuse to run — a test that `fs.rm -rf`s WORKSPACE_DIR/DATA_DIR could wipe the
  // developer's real files. Write straight to the real stderr (the preload later
  // silences console.*), then exit before a single test loads.
  process.stderr.write(`\n${(err as Error).message}\n\n`);
  process.exit(1);
}
