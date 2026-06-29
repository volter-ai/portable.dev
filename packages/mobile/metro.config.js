// Metro configuration for the Bun workspace monorepo.
//
// Bun installs workspace packages as symlinks (e.g. node_modules/@vgit2/shared
// -> ../../shared). Metro must (1) watch the monorepo root so changes in
// packages/shared trigger reloads, (2) be able to resolve modules from both the
// app's own node_modules and the hoisted root node_modules, and (3) follow the
// symlinks Bun creates. See https://docs.expo.dev/guides/monorepos/.
// `getSentryExpoConfig` (#1394) is a drop-in for Expo's `getDefaultConfig` — it
// calls getDefaultConfig internally and installs Sentry's Metro serializer, which
// injects a unique Debug ID into the emitted bundle AND its source map so uploaded
// maps symbolicate production stack traces. It returns an ordinary mutable
// MetroConfig, so ALL the monorepo customizations below apply unchanged (none of
// them touch `config.serializer`, the one field Sentry sets). Do NOT add a
// `config.serializer.customSerializer` here or it would clobber the Debug-ID serializer.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');
const sharedRoot = path.resolve(monorepoRoot, 'packages/shared');

const config = getSentryExpoConfig(projectRoot);

// 1. Watch the whole monorepo (which includes packages/shared) so edits to the
//    shared package are picked up. packages/shared is listed explicitly to make
//    the dependency obvious and to satisfy partial-watch setups.
config.watchFolders = [monorepoRoot, sharedRoot];

// 2. Let Metro resolve modules from the app first, then the hoisted root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// 3. Bun uses symlinks for workspace packages; Metro must follow them.
config.resolver.unstable_enableSymlinks = true;
config.resolver.disableHierarchicalLookup = false;

// 4. @vgit2/shared ships UNTRANSPILED TypeScript that uses NodeNext-style ESM
//    import specifiers ending in `.js` (e.g. `export * from './events.js'`) which
//    actually resolve to sibling `.ts` source. Node (backend) and Vite (web)
//    resolve these natively; Metro does NOT, so a relative `./foo.js` import from
//    inside @vgit2/shared fails with "Unable to resolve ./events.js". This mirrors
//    the Jest moduleNameMapper fix (`^(\.{1,2}/.*)\.js$` -> `$1`) in jest.config.js,
//    but SCOPED to @vgit2/shared origins so app + node_modules `.js` resolution is
//    left exactly as Metro's default. Only the mobile bundler is affected — the
//    shared source and the web/backend builds are untouched.
const SHARED_SRC_MARKERS = [
  `${path.sep}packages${path.sep}shared${path.sep}src${path.sep}`,
  `${path.sep}@vgit2${path.sep}shared${path.sep}`,
];
const isSharedOrigin = (originModulePath) =>
  typeof originModulePath === 'string' &&
  SHARED_SRC_MARKERS.some((marker) => originModulePath.includes(marker));

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    isSharedOrigin(context.originModulePath) &&
    moduleName.startsWith('.') &&
    moduleName.endsWith('.js')
  ) {
    try {
      // Strip `.js` and let Metro re-resolve via sourceExts (`.ts`/`.tsx`/...).
      return context.resolveRequest(context, moduleName.slice(0, -3), platform);
    } catch {
      // Genuine `.js` asset inside shared (none today) — fall through to default.
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
