// Jest config for the Expo app (jest-expo preset + React Native Testing Library).
//
// Bun installs packages into a content-addressed store, so a dependency lives at
// `node_modules/.bun/<pkg>@<ver>+<hash>/node_modules/<pkg>` rather than the flat
// `node_modules/<pkg>`. The stock `transformIgnorePatterns` (which assumes the
// package name follows the FIRST `node_modules/`) therefore skips Babel for the
// RN/Expo source and Jest hits raw ESM ("Cannot use import statement").
//
// The leading optional-path group lets the allow-list match an allowed package
// name at ANY depth (incl. inside `.bun/...`), and the trailing boundary class
// anchors on a package boundary so e.g. `expo` matches `expo`, `expo-router`,
// and the encoded `expo@56.0.9+hash` store dir. `@vgit2` workspace TypeScript
// ships untranspiled and must be transformed too.
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  // `standard-navigation` is a transitive expo-router 56.2.x dependency that ships
  // untranspiled ESM (`import * as React` in lib/src/index.js); without it in the
  // allow-list every expo-router-touching test dies with "Cannot use import
  // statement outside a module".
  transformIgnorePatterns: [
    'node_modules/(?!(?:.*/)?(?:react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|@unimodules|unimodules|@react-navigation|react-navigation|standard-navigation|sentry-expo|@sentry|native-base|@vgit2)(?:[-@+/]|$))',
  ],
  // @vgit2/shared ships untranspiled TS using NodeNext-style `.js` ESM specifiers
  // (e.g. `export * from './events.js'`). Jest's resolver can't map `.js`→`.ts`, so
  // strip the extension and let Jest re-resolve against moduleFileExtensions. Real
  // `.js` files still resolve (the stripped path re-adds `.js`).
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Babel externalises helpers to @babel/runtime, but when Jest transforms a
    // file in packages/shared the inserted require resolves from shared's dir,
    // where Bun did not nest @babel/runtime. Pin it to the single copy Bun
    // installed — hoisted to the repo root or nested here, depending on layout.
    '^@babel/runtime/(.*)$': `${require('path').dirname(
      require.resolve('@babel/runtime/package.json')
    )}/$1`,
    // react-native-reanimated can't load under jest-expo (its real index inits
    // react-native-worklets native at module-load and throws). Map the bare
    // specifier to a hand-rolled plain-JS stub — the fallback for tests that do NOT
    // import expo-router. renderRouter tests are handled in jest.setup.js (see the
    // pre-require + doMock there): expo-router's testing-library self-registers a
    // broken reanimated mock at import time that beats moduleNameMapper.
    '^react-native-reanimated$': '<rootDir>/src/test/reanimatedMock.js',
  },
  testMatch: ['<rootDir>/**/*.test.ts', '<rootDir>/**/*.test.tsx'],
};
