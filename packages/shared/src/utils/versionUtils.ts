/**
 * Compares two semver strings to determine if `current` meets `minimum`.
 *
 * Enforcement is at the minor level:
 *   - Major mismatch: current > minimum required, else fails
 *   - Minor mismatch: current >= minimum required
 *   - Patch: ignored (patch updates are backwards-compatible)
 *
 * Examples:
 *   meetsMinimumVersion('1.1.0', '1.0.0') → true
 *   meetsMinimumVersion('1.0.5', '1.1.0') → false  (minor too low)
 *   meetsMinimumVersion('1.1.5', '1.1.0') → true   (patch ignored)
 *   meetsMinimumVersion('2.0.0', '1.5.0') → true   (major higher)
 *   meetsMinimumVersion('1.0.0', '2.0.0') → false  (major too low)
 */
export function meetsMinimumVersion(current: string, minimum: string): boolean {
  const parse = (v: string): [number, number] => {
    const parts = v.split('.').map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0];
  };

  const [curMaj, curMin] = parse(current);
  const [minMaj, minMin] = parse(minimum);

  if (curMaj !== minMaj) return curMaj > minMaj;
  return curMin >= minMin;
}

/**
 * Returns true when `version` is the Vite dev build sentinel ('0.0.0').
 *
 * When VITE_APP_VERSION is absent (plain `bun run dev` or an AI agent's
 * shell with npm_package_version=0.0.0 pre-exported), vite.config.ts bakes
 * '0.0.0' into the bundle. The web VersionGate uses this to fail open —
 * skipping the /api/min-version check entirely so local dev is never
 * blocked by UpdateRequired.
 */
export function isDevSentinelVersion(version: string): boolean {
  return version === '0.0.0';
}

/**
 * Returns true when the major OR minor component differs between two semver
 * strings (patch is ignored). Used to decide whether a release is significant
 * enough to wipe client storage / force re-login.
 *
 * Examples:
 *   majorMinorChanged('1.4.0', '1.5.0') → true   (minor bumped)
 *   majorMinorChanged('1.4.0', '1.4.1') → false  (patch only)
 *   majorMinorChanged('1.9.0', '2.0.0') → true   (major bumped)
 *   majorMinorChanged('1.4.0', '1.4.0') → false
 */
export function majorMinorChanged(a: string, b: string): boolean {
  const parse = (v: string): [number, number] => {
    const parts = v.split('.').map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0];
  };

  const [aMaj, aMin] = parse(a);
  const [bMaj, bMin] = parse(b);

  return aMaj !== bMaj || aMin !== bMin;
}
