import fs from 'fs';
import path from 'path';

import { resolveDataDir } from '@vgit2/shared/secrets';

import type { VoicePhrasesResponse } from '@vgit2/shared/types';

/**
 * VoicePhrasesService — the user's custom voice-dictation vocabulary, persisted in the
 * PC's portable metadata (a plain JSON file under DATA_DIR, `~/.portable/voice-phrases.json`).
 *
 * These phrases are sent to the mobile app's on-device speech recognizer as
 * `contextualStrings` (biasing), so terms the user adds — project names, libraries,
 * jargon — are recognized correctly. The file is seeded with a default tech vocabulary on
 * first read; `version` increments on every change so the phone can bust its cache.
 *
 * Fully self-contained (no other services) + DI-friendly (`dataDir` injectable for tests).
 */

const VOICE_PHRASES_FILENAME = 'voice-phrases.json';

/** Default biasing vocabulary seeded on first use (extends as the user adds phrases). */
export const DEFAULT_VOICE_PHRASES: string[] = [
  'Portable',
  'Claude',
  'Anthropic',
  'Redis',
  'Postgres',
  'SQLite',
  'Playwright',
  'TypeScript',
  'JavaScript',
  'Python',
  'Docker',
  'Kubernetes',
  'GraphQL',
  'GitHub',
  'OAuth',
  'JWT',
  'Expo',
  'React Native',
  'Metro',
  'Bun',
  'Vite',
  'Next.js',
  'Tailwind',
  'webhook',
  'endpoint',
  'repo',
  'commit',
  'rebase',
  'middleware',
];

interface StoredVoicePhrases {
  phrases: string[];
  version: number;
}

export class VoicePhrasesService {
  private readonly filePath: string;

  constructor(dataDir: string = resolveDataDir()) {
    this.filePath = path.join(dataDir, VOICE_PHRASES_FILENAME);
  }

  /** Read the phrases (seeding + persisting the defaults on first use). Never throws. */
  getPhrases(): VoicePhrasesResponse {
    const stored = this.read();
    if (stored) return { phrases: stored.phrases, version: stored.version };
    // First use — seed with the defaults.
    const seeded: StoredVoicePhrases = { phrases: [...DEFAULT_VOICE_PHRASES], version: 1 };
    this.write(seeded);
    return seeded;
  }

  /**
   * Add a phrase (trimmed, case-insensitive dedup) and bump the version. Returns the full
   * updated list. A blank/duplicate phrase is a no-op (still returns the current list).
   */
  addPhrase(phrase: string): VoicePhrasesResponse {
    const trimmed = (phrase ?? '').trim();
    const current = this.getPhrases();
    if (!trimmed) return current;
    const exists = current.phrases.some((p) => p.toLowerCase() === trimmed.toLowerCase());
    if (exists) return current;
    const next: StoredVoicePhrases = {
      phrases: [...current.phrases, trimmed],
      version: current.version + 1,
    };
    this.write(next);
    return next;
  }

  /** Remove a phrase (case-insensitive) and bump the version. */
  removePhrase(phrase: string): VoicePhrasesResponse {
    const trimmed = (phrase ?? '').trim().toLowerCase();
    const current = this.getPhrases();
    const filtered = current.phrases.filter((p) => p.toLowerCase() !== trimmed);
    if (filtered.length === current.phrases.length) return current; // nothing removed
    const next: StoredVoicePhrases = { phrases: filtered, version: current.version + 1 };
    this.write(next);
    return next;
  }

  private read(): StoredVoicePhrases | null {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<StoredVoicePhrases>;
      if (!Array.isArray(parsed.phrases)) return null;
      const phrases = parsed.phrases.filter(
        (p): p is string => typeof p === 'string' && !!p.trim()
      );
      const version = typeof parsed.version === 'number' ? parsed.version : 1;
      return { phrases, version };
    } catch {
      return null; // missing / corrupt → caller re-seeds
    }
  }

  private write(data: StoredVoicePhrases): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch (error) {
      console.warn('[VoicePhrasesService] failed to persist phrases', error);
    }
  }
}
