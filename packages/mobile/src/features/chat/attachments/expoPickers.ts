/**
 * Native picker + compression adapters — the ONLY module importing
 * `expo-image-picker` / `expo-document-picker` / `expo-image-manipulator`
 * (mirrors how `useExpoVoiceRecorder` is the only importer of `expo-audio`). Each
 * adapter normalises the native result into the framework-free {@link PickedFile}
 * contract so the ViewModel + its tests stay native-module-free.
 *
 * The default `useAttachments` seams wire these; tests either inject fakes or mock
 * the three `expo-*` modules and exercise these real adapters end-to-end (the AC).
 */

import * as DocumentPicker from 'expo-document-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import type { CompressImageFn, PickDocumentsFn, PickImagesFn, PickedFile } from './attachment';
import { isImage } from './attachment';

/** Images larger than this (bytes) are compressed before upload (web parity: 5 MB). */
export const COMPRESS_THRESHOLD_BYTES = 5 * 1024 * 1024;
/** Max image dimension after compression (web parity). */
export const COMPRESS_MAX_DIMENSION = 2048;
/** JPEG quality after compression (web parity: 0.85). */
export const COMPRESS_QUALITY = 0.85;

/** Derive a file name from a URI when the picker doesn't supply one. */
function nameFromUri(uri: string, fallback: string): string {
  const tail = uri.split('/').pop();
  return tail && tail.length > 0 ? tail.split('?')[0] : fallback;
}

/** Pick one or more images from the photo library. */
export const expoPickImages: PickImagesFn = async () => {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    quality: 1,
  });
  if (result.canceled) return [];
  return result.assets.map((asset) => ({
    uri: asset.uri,
    name: asset.fileName ?? nameFromUri(asset.uri, 'image.jpg'),
    mimeType: asset.mimeType ?? 'image/jpeg',
    width: asset.width,
    height: asset.height,
    size: asset.fileSize,
    source: 'library' as const,
  }));
};

/** Pick one or more arbitrary documents. */
export const expoPickDocuments: PickDocumentsFn = async () => {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  return result.assets.map((asset) => ({
    uri: asset.uri,
    name: asset.name ?? nameFromUri(asset.uri, 'file'),
    mimeType: asset.mimeType ?? 'application/octet-stream',
    size: asset.size ?? undefined,
    source: 'document' as const,
  }));
};

/**
 * Compress an image with `expo-image-manipulator` if it's a large-ish image;
 * non-images and small images pass through unchanged. Mirrors the web
 * `browser-image-compression` step (resize to 2048px max, JPEG @ 0.85).
 */
export const expoCompressImage: CompressImageFn = async (file: PickedFile) => {
  if (!isImage(file)) return file;
  if (file.size !== undefined && file.size <= COMPRESS_THRESHOLD_BYTES) return file;

  const context = ImageManipulator.ImageManipulator.manipulate(file.uri);
  const longest = Math.max(file.width ?? 0, file.height ?? 0);
  if (longest > COMPRESS_MAX_DIMENSION) {
    // Resize the longer edge to the cap, preserving aspect ratio.
    if ((file.width ?? 0) >= (file.height ?? 0)) {
      context.resize({ width: COMPRESS_MAX_DIMENSION });
    } else {
      context.resize({ height: COMPRESS_MAX_DIMENSION });
    }
  }
  const image = await context.renderAsync();
  const saved = await image.saveAsync({
    compress: COMPRESS_QUALITY,
    format: ImageManipulator.SaveFormat.JPEG,
  });

  return {
    ...file,
    uri: saved.uri,
    name: file.name.replace(/\.[^.]+$/, '') + '.jpg',
    mimeType: 'image/jpeg',
    width: saved.width,
    height: saved.height,
    // Size is unknown after re-encode; clear it so we don't re-skip future checks.
    size: undefined,
  };
};
