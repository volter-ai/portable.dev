/**
 * Expo config plugin — adds `use_modular_headers!` to the generated iOS Podfile.
 *
 * WHY: the Firebase iOS SDK 11 (pulled in by `@react-native-firebase/messaging`
 * for the iOS FCM-token fix) ships `FirebaseCoreInternal` as a **Swift** pod that
 * depends on `GoogleUtilities`, an **Objective-C** pod that does NOT define module
 * maps. A Swift pod can only import an ObjC dependency when that dependency exposes
 * a module — so `pod install` fails with:
 *   "[!] The following Swift pods cannot yet be integrated as static libraries: The
 *    Swift pod `FirebaseCoreInternal` depends upon `GoogleUtilities`, which does not
 *    define modules … set `use_modular_headers!` globally."
 * This happens under DEFAULT static linkage too (NOT only `use_frameworks!`), which
 * is exactly why we do NOT enable `use_frameworks` (it conflicts with the New-Arch
 * C++ pods — react-native-mmkv/NitroModules, reanimated/worklets). The minimal,
 * New-Arch-friendly fix the CocoaPods error itself recommends is global modular
 * headers, which makes GoogleUtilities (and the other ObjC Google pods) generate
 * module maps so the Swift Firebase pods can import them as static libraries.
 *
 * `expo-build-properties` only exposes `modular_headers` PER-POD inside `extraPods`
 * (not a global `use_modular_headers!`), so this dangerous-mod is the clean CNG way
 * to add the global directive. It is idempotent and re-applies on every prebuild
 * (the Podfile is regenerated each time).
 */
const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const DIRECTIVE = 'use_modular_headers!';

module.exports = function withModularHeaders(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfilePath, 'utf8');

      if (!contents.includes(DIRECTIVE)) {
        // Insert as a top-level directive right after the `platform :ios …` line.
        contents = contents.replace(/^(platform :ios.*$)/m, `$1\n${DIRECTIVE}`);
        fs.writeFileSync(podfilePath, contents, 'utf8');
      }

      return cfg;
    },
  ]);
};
