/**
 * Controllable `expo-file-system` mock for the live-dictation snapshot/transcode
 * path. `useExpoVoiceRecorder` lazy-requires `expo-file-system` to copy or
 * transcode the in-progress recording for upload, and `appendFormDataFile` backs
 * multipart parts with its `File`. This mock replaces the native `File`/`Paths`
 * API with an in-memory uri → content map: seed a file as a NUMBER (zero-filled
 * size — enough for size/copy paths) or as real `Uint8Array` content (needed when
 * a transcoder parses the bytes, e.g. `cafToWav`). Mirrors the
 * `createExpoAudioMock` harness pattern (expose `__files`/`__copies`/`__writes`,
 * read via `jest.requireMock`).
 *
 * Usage:
 *   jest.mock('expo-file-system', () =>
 *     require('../src/test/mockExpoFileSystem').createExpoFileSystemMock());
 *   const fs = jest.requireMock('expo-file-system') as ExpoFileSystemMockModule;
 *   fs.__files.set('file:///rec.caf', buildCafFixture(pcm)); // the recording
 */

type MockFileContent = number | Uint8Array;

export interface ExpoFileSystemMockModule {
  File: new (...parts: Array<string | { uri: string }>) => {
    uri: string;
    exists: boolean;
    size: number | null;
    bytes(): Promise<Uint8Array>;
    write(content: Uint8Array | string): void;
    delete(): void;
    copySync(destination: { uri: string }): void;
  };
  Paths: { cache: { uri: string } };
  /** uri → content. Seed a number (zero-filled size) or real bytes. */
  __files: Map<string, MockFileContent>;
  /** Recorded `copySync` calls. */
  __copies: Array<{ from: string; to: string }>;
  /** Recorded `write` calls (content normalized to bytes). */
  __writes: Array<{ to: string; bytes: Uint8Array }>;
}

function toBytes(content: MockFileContent | undefined): Uint8Array {
  if (content instanceof Uint8Array) return content;
  return new Uint8Array(content ?? 0);
}

export function createExpoFileSystemMock(): ExpoFileSystemMockModule {
  const files = new Map<string, MockFileContent>();
  const copies: Array<{ from: string; to: string }> = [];
  const writes: Array<{ to: string; bytes: Uint8Array }> = [];

  class FakeFile {
    readonly uri: string;

    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
    }

    get exists(): boolean {
      return files.has(this.uri);
    }

    get size(): number | null {
      const content = files.get(this.uri);
      if (content === undefined) return null;
      return content instanceof Uint8Array ? content.byteLength : content;
    }

    async bytes(): Promise<Uint8Array> {
      return toBytes(files.get(this.uri));
    }

    write(content: Uint8Array | string): void {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      writes.push({ to: this.uri, bytes });
      files.set(this.uri, bytes);
    }

    delete(): void {
      files.delete(this.uri);
    }

    copySync(destination: { uri: string }): void {
      copies.push({ from: this.uri, to: destination.uri });
      files.set(destination.uri, files.get(this.uri) ?? 0);
    }
  }

  return {
    File: FakeFile,
    Paths: { cache: { uri: 'file:///cache' } },
    __files: files,
    __copies: copies,
    __writes: writes,
  };
}
