/**
 * LocalSecretStore — local-first encrypted secret store
 *
 * Replaces the cloud-dependent ClerkSecretsService for the PC runtime. All
 * secrets (connection credentials, the launcher's Clerk identity token from the
 * device-code login, and the device-token signing secret) are
 * encrypted at rest with AES-256-GCM under a per-install random key and stored
 * under DATA_DIR. Nothing here depends on a network service.
 *
 * Layout (DATA_DIR, default ~/.portable or $XDG_DATA_HOME/portable):
 *   <DATA_DIR>/            dir,  mode 0700
 *   <DATA_DIR>/secret.key  file, mode 0600  — the per-install 256-bit key (hex)
 *   <DATA_DIR>/secrets.json file, mode 0600 — { name: "v1:<iv>:<tag>:<ct>" }
 *
 * Each value is independently AES-256-GCM encrypted with a fresh random IV, so
 * `list()` works without decrypting and a tampered/wrong-key value fails the GCM
 * auth tag on `decryptValue()` (throws) rather than returning garbage.
 *
 * Threat model (docs/security/local-first-threat-model.md): the encryption key
 * lives on the same disk as the ciphertext, so this protects against casual
 * file exfiltration and accidental plaintext leakage — NOT a compromised host.
 * The mitigation that matters is the restrictive 0700/0600 perms.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length
const ENVELOPE_PREFIX = 'v1';

/**
 * Resolve the local data directory for the PC runtime.
 * Precedence: explicit override → $PORTABLE_DATA_DIR → $DATA_DIR →
 * $XDG_DATA_HOME/portable → ~/.portable
 */
export function resolveDataDir(override?: string): string {
  const fromEnv =
    override ||
    process.env.PORTABLE_DATA_DIR ||
    process.env.DATA_DIR ||
    (process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, 'portable') : undefined) ||
    path.join(os.homedir(), '.portable');

  // Expand a leading ~ for env-provided paths (mirrors shared/constants behavior).
  if (fromEnv.startsWith('~')) {
    return path.join(os.homedir(), fromEnv.slice(1));
  }
  return fromEnv;
}

/**
 * Encrypt a UTF-8 string into a self-describing envelope:
 *   "v1:<ivB64>:<tagB64>:<ciphertextB64>"
 * The IV is random per call; the GCM auth tag binds the ciphertext to the key.
 */
export function encryptValue(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`LocalSecretStore: key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_PREFIX,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a "v1:<iv>:<tag>:<ct>" envelope. Throws if the envelope is malformed
 * or the GCM auth check fails (wrong key or tampered ciphertext).
 */
export function decryptValue(envelope: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`LocalSecretStore: key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_PREFIX) {
    throw new Error('LocalSecretStore: malformed secret envelope');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ciphertext = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  // .final() throws "Unsupported state or unable to authenticate data" on a bad key/tag.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export interface LocalSecretStoreOptions {
  /** Override the data directory (otherwise resolveDataDir() is used). */
  dataDir?: string;
}

export class LocalSecretStore {
  readonly dataDir: string;
  private readonly keyPath: string;
  private readonly storePath: string;
  private readonly key: Buffer;

  constructor(options: LocalSecretStoreOptions = {}) {
    this.dataDir = resolveDataDir(options.dataDir);
    this.keyPath = path.join(this.dataDir, 'secret.key');
    this.storePath = path.join(this.dataDir, 'secrets.json');
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    // recursive:true won't tighten an existing dir's perms — do it explicitly.
    this.chmodQuiet(this.dataDir, 0o700);
    this.key = this.loadOrCreateKey();
  }

  /** Load the per-install key, generating + persisting one on first run. */
  private loadOrCreateKey(): Buffer {
    if (fs.existsSync(this.keyPath)) {
      const hex = fs.readFileSync(this.keyPath, 'utf8').trim();
      const key = Buffer.from(hex, 'hex');
      if (key.length !== KEY_BYTES) {
        throw new Error(`LocalSecretStore: corrupt key file at ${this.keyPath}`);
      }
      this.chmodQuiet(this.keyPath, 0o600);
      return key;
    }
    const key = crypto.randomBytes(KEY_BYTES);
    // 'wx' fails if a concurrent process beat us to it; fall back to reading.
    try {
      fs.writeFileSync(this.keyPath, key.toString('hex'), { mode: 0o600, flag: 'wx' });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        return this.loadOrCreateKey();
      }
      throw err;
    }
    return key;
  }

  private readEnvelopes(): Record<string, string> {
    if (!fs.existsSync(this.storePath)) return {};
    try {
      const raw = fs.readFileSync(this.storePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, string>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private writeEnvelopes(map: Record<string, string>): void {
    const tmp = `${this.storePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 });
    fs.renameSync(tmp, this.storePath); // atomic; preserves tmp's 0600 mode
  }

  private chmodQuiet(target: string, mode: number): void {
    try {
      fs.chmodSync(target, mode);
    } catch {
      // chmod is a no-op / unsupported on some filesystems (e.g. Windows) — ignore.
    }
  }

  /** Get a stored plaintext secret, or undefined if absent. Throws on a bad key. */
  get(name: string): string | undefined {
    const envelope = this.readEnvelopes()[name];
    if (envelope === undefined) return undefined;
    return decryptValue(envelope, this.key);
  }

  /** Encrypt and store a secret under `name`, replacing any existing value. */
  set(name: string, value: string): void {
    const map = this.readEnvelopes();
    map[name] = encryptValue(value, this.key);
    this.writeEnvelopes(map);
  }

  /** Delete a secret. Returns true if it existed. */
  delete(name: string): boolean {
    const map = this.readEnvelopes();
    if (!(name in map)) return false;
    delete map[name];
    this.writeEnvelopes(map);
    return true;
  }

  has(name: string): boolean {
    return name in this.readEnvelopes();
  }

  /** List the names of all stored secrets (never decrypts). */
  list(): string[] {
    return Object.keys(this.readEnvelopes());
  }

  /** Convenience: store a JSON-serializable object. */
  setJSON(name: string, value: unknown): void {
    this.set(name, JSON.stringify(value));
  }

  /** Convenience: read + parse a JSON object, or undefined if absent. */
  getJSON<T = unknown>(name: string): T | undefined {
    const raw = this.get(name);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
}
