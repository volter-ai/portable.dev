/**
 * Multipart file parts compatible with Expo's winter `fetch`.
 *
 * Expo SDK 56 replaces the global `fetch` with `expo/fetch` (the WinterCG
 * implementation — `expo/src/winter/runtime.native.ts`), which serializes
 * `FormData` bodies in JS (`convertFormDataAsync`). That serializer accepts ONLY
 * three part shapes: a `string`, a `Blob` instance, or an object exposing
 * `bytes(): Promise<Uint8Array>` (the expo-file-system `File`/`ExpoBlob` duck
 * type). The classic React Native `{ uri, name, type }` file part is NOT one of
 * them — appending it throws `Unsupported FormDataPart implementation` at upload
 * time (the exact iOS device failure this module fixes). Don't switch back to the
 * `{ uri, ... }` shape: it only worked under RN's pre-winter networking stack.
 *
 * The part appended here is a plain object carrying `name` (multipart filename),
 * `type` (content-type) and a `bytes()` backed by an expo-file-system `File`, so
 * the serializer streams the file content and the part headers stay fully under
 * our control. `expo-file-system` is loaded via a lazy `require`,
 * keeping it out of any module graph until an upload actually happens.
 */

/** A file on disk destined for a multipart field. */
export interface FormDataFileSource {
  /** `file://` (or platform) URI of the file. */
  uri: string;
  /** Multipart filename (rides the part's content-disposition). */
  name: string;
  /** Content-type of the part. */
  mimeType: string;
}

/**
 * Append `source` to `form` under `field` as a winter-fetch-compatible file part.
 * The file bytes are read lazily, only when the body is serialized.
 */
export function appendFormDataFile(
  form: FormData,
  field: string,
  source: FormDataFileSource
): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- lazy: see module doc.
  const { File } = require('expo-file-system') as typeof import('expo-file-system');
  const file = new File(source.uri);
  const part = {
    name: source.name,
    type: source.mimeType,
    bytes: () => file.bytes(),
  };
  // Not a Blob instance on purpose: expo's FormData patch passes non-Blob objects
  // through untouched, and the winter serializer takes the `bytes()` branch.
  form.append(field, part as unknown as Blob);
}
