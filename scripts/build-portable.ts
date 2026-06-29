/**
 * build-portable.ts — assemble the installable `portable` artifact (PRD:
 * tasks/prd-portable-distribution.md, Stage 1).
 *
 * Bundles the separated monorepo entrants — the launcher CLI and the api server —
 * with ONE build primitive (`Bun.build`, target=bun): first-party code (`@vgit2/*`
 * + relative imports) is INLINED, every third-party npm dep is kept EXTERNAL. The
 * output dir + the generated package.json reproduce exactly the layout that
 * `bun install -g` produces, so the same artifact feeds every delivery channel
 * (dev `bun link`, `curl|sh`, `bun install -g portable`).
 *
 * Why external (not bundled) for node_modules: it is load-bearing, not just size —
 * `@anthropic-ai/claude-agent-sdk` resolves its native `claude` binary relative to
 * its own package dir, and `@playwright/mcp` is spawned as `node <cli.js>`. Bundling
 * those would break the spawn. Externalizing means `bun install` materialises them
 * as ordinary deps that resolve from the sibling node_modules.
 *
 * Usage:  bun scripts/build-portable.ts [outDir]   (default: <repo>/dist-portable)
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import path from 'path';

const REPO = path.resolve(path.dirname(Bun.fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(REPO, 'dist-portable'));

/** The monorepo entrants we assemble into the artifact. */
const ENTRANTS = [
  { name: 'cli', entry: 'packages/launcher/src/cli.ts' },
  { name: 'server', entry: 'packages/api/src/server.ts' },
] as const;

/** Packages whose deps define the third-party external surface. */
const ENTRANT_PKGS = ['launcher', 'api', 'shared'];

/**
 * Deps declared by launcher/api/shared that the BUILT runtime bundles
 * (`cli.js` + `server.js`) never reach — neither an `import`/`require` nor a
 * string literal (spawn arg / `require.resolve`) appears in either bundle, and no
 * dynamic-import code path in the bundled entrypoints reaches them. They are dead
 * weight in the distribution: each one bloats the global `bun install -g`, adds
 * npm-registry round-trips (the revalidation chatter that can hang a flaky/IPv6
 * network), and — for `sharp` — runs a native binary-download postinstall. Drop
 * them from BOTH the externalized set and the generated `package.json` deps.
 *
 * Safety: a dep needed only TRANSITIVELY by a kept external is still installed by
 * bun via that parent — removing it as a DIRECT dep is safe. If a future
 * entrypoint ever imports one of these, `Bun.build` would try to inline it and the
 * build would surface it loudly (it is no longer external), which is the signal to
 * remove it from this list. Verified against the bundles + `packages/{api,launcher,
 * shared}/src` (the gateway-only deps — http-proxy-middleware, nanoid — are never
 * reached by the api server entry; `@modelcontextprotocol/sdk`
 * is not the spawned MCP server — that is `@playwright/mcp`, which stays;
 * `socket.io-client` is client-only; `@slack/types` is types-only).
 */
const EXCLUDE_FROM_DIST = new Set([
  '@slack/types', // types-only (compile-time), never needed at runtime
  'sharp', // heavy native postinstall; no reachable image-processing import
  '@modelcontextprotocol/sdk', // not imported; custom MCPs use the agent SDK's createSdkMcpServer
  'http-proxy-middleware', // gateway-only (not in this distribution)
  'nanoid', // gateway-only (not in this distribution)
  'socket.io-client', // the api is the socket SERVER; client is unused at runtime
]);

function readDeps(pkg: string): Record<string, string> {
  const json = require(path.join(REPO, 'packages', pkg, 'package.json'));
  return { ...(json.dependencies || {}) };
}

/**
 * Pin a dep to the EXACT version installed in this monorepo (read from its installed
 * package.json) rather than the source's `^range`. A published `^range` resolves to the
 * LATEST matching version on a stranger's machine — which is how `playwright@1.61.1`
 * (and a surprise Chromium build) slipped in vs. what we actually tested. Exact pins make
 * every `bun/npm install -g` reproduce the tested dependency set. Falls back to the range
 * when the installed version can't be read.
 */
function resolveInstalledVersion(dep: string, range: string): string {
  for (const from of ['packages/api', 'packages/launcher', 'packages/shared', '.']) {
    try {
      const pj = Bun.resolveSync(`${dep}/package.json`, path.join(REPO, from));
      const v = require(pj).version;
      if (v) return v; // exact pin
    } catch {
      // try the next resolution root (partial hoisting splits deps across node_modules)
    }
  }
  // Direct-fs fallback for packages whose exports map hides ./package.json from the resolver.
  for (const nm of [
    'packages/api/node_modules',
    'node_modules',
    'packages/launcher/node_modules',
    'packages/shared/node_modules',
  ]) {
    const pj = path.join(REPO, nm, ...dep.split('/'), 'package.json');
    if (existsSync(pj)) {
      const v = require(pj).version;
      if (v) return v; // exact pin
    }
  }
  return range; // fallback: keep the declared range
}

async function main(): Promise<void> {
  // 1) Union the entrants' deps; externalize everything that is NOT first-party.
  const allDeps: Record<string, string> = {};
  for (const p of ENTRANT_PKGS) Object.assign(allDeps, readDeps(p));
  const external = Object.keys(allDeps)
    .filter((d) => !d.startsWith('@vgit2/'))
    .filter((d) => !EXCLUDE_FROM_DIST.has(d))
    .sort();
  const dropped = Object.keys(allDeps).filter((d) => EXCLUDE_FROM_DIST.has(d));
  console.log(`[build-portable] external third-party deps: ${external.length}`);
  if (dropped.length) {
    console.log(`[build-portable] excluded ${dropped.length} unused deps: ${dropped.join(', ')}`);
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // 2) Build each entrant. First-party (@vgit2/*, relative) INLINED; deps external.
  for (const { name, entry } of ENTRANTS) {
    const res = await Bun.build({
      entrypoints: [path.join(REPO, entry)],
      target: 'bun',
      external,
      outdir: OUT,
      naming: `${name}.js`,
      sourcemap: 'none',
    });
    if (!res.success) {
      console.error(`[build-portable] BUILD FAILED (${name}):`);
      for (const m of res.logs) console.error('  ', m.message);
      process.exit(1);
    }
    const kb = (res.outputs[0].size / 1024).toFixed(0);
    console.log(`[build-portable]   ✓ ${name}.js (${kb} KB)`);
  }

  // 3) Emit the distributable package.json (bin + external deps as real deps).
  const rootPkg = require(path.join(REPO, 'package.json'));
  const distPkg = {
    // Scoped package name (avoids the unscoped `portable` npm collision); the CLI
    // command stays the unscoped `portable` via the bin map.
    name: '@volter-ai/portable.dev',
    version: rootPkg.version ?? '0.1.0',
    type: 'module',
    description: 'Portable — local-first launcher / tunnel-router (installable CLI)',
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/volter-ai/portable.dev.git' },
    homepage: 'https://github.com/volter-ai/portable.dev#readme',
    // Bare path (NOT './cli.js'): npm strips a leading './' and warns
    // `bin[portable] script name cli.js was invalid and removed`, dropping the command
    // from the published manifest. The CLI command stays the unscoped `portable`.
    bin: { portable: 'cli.js' },
    // Only ship the two bundles (package.json is always included). Keeps a stray
    // node_modules / bun.lock out of the tarball if the artifact was installed/tested.
    files: ['cli.js', 'server.js'],
    // Both the launcher (cli.js shebang `#!/usr/bin/env bun`) and the api child it
    // spawns (`bun server.js`) run under Bun — Node alone is not sufficient.
    engines: { bun: '>=1.2.0' },
    // Scoped package → publish PUBLIC (npm's default for a scope is restricted).
    publishConfig: { access: 'public' },
    // The launcher spawns the api child as `bun <PORTABLE_API_ENTRY|sibling server.js>`.
    // Deps PINNED to the exact installed versions (reproducible installs everywhere).
    dependencies: Object.fromEntries(
      external.map((d) => [d, resolveInstalledVersion(d, allDeps[d])])
    ),
  };
  const pinned = external.filter((d) => !/^[\^~]/.test(distPkg.dependencies[d])).length;
  console.log(`[build-portable] pinned ${pinned}/${external.length} deps to exact versions`);
  writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(distPkg, null, 2) + '\n');

  console.log(`[build-portable] artifact → ${OUT}`);
  console.log(`[build-portable] published deps: ${external.length}`);
  console.log(
    `[build-portable] next: cd ${path.relative(REPO, OUT)} && bun install && bun ./cli.js help`
  );
}

await main();
