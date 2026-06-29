/**
 * Attachment contracts — framework-free types shared by the picker
 * adapters, the compression step, the upload step, and the ViewModel.
 *
 * The web counterpart is `useFileUpload` + the `UploadedFile` type. RN sources a
 * file from the image picker, the document picker, or the camera — all normalised
 * to {@link PickedFile} — then (for images) compresses it and multipart-POSTs it to
 * `POST /api/upload` (field name `file`), yielding an {@link UploadedAttachment}.
 */

import type { UploadFileResponse } from '../../api/hooks';

/** How a file entered the composer (drives icons / which native module sourced it). */
export type AttachmentSource = 'library' | 'document' | 'camera';

/**
 * A file picked from a native source, normalised to the RN multipart shape
 * (`{ uri, name, type }`). `width`/`height`/`size` are best-effort metadata used
 * to decide whether an image needs compression.
 */
export interface PickedFile {
  /** Local file URI (file:// or content://). */
  uri: string;
  /** File name including extension. */
  name: string;
  /** MIME type, e.g. `image/jpeg` or `application/pdf`. */
  mimeType: string;
  /** Pixel width (images only). */
  width?: number;
  /** Pixel height (images only). */
  height?: number;
  /** Byte size when known. */
  size?: number;
  /** Where the file came from. */
  source: AttachmentSource;
}

/** A file that has been uploaded to the sandbox (`POST /api/upload` response + UI metadata). */
export interface UploadedAttachment {
  /** Stable client id (for list keys / removal before the server responds). */
  id: string;
  /** The picked file (local URI used for the thumbnail / gallery preview). */
  file: PickedFile;
  /** The server's response (path the agent reads). */
  response: UploadFileResponse;
}

/** True for files the platform should compress before upload (large-ish images). */
export function isImage(file: Pick<PickedFile, 'mimeType'>): boolean {
  return file.mimeType.startsWith('image/');
}

/** Picks images from the photo library. */
export type PickImagesFn = () => Promise<PickedFile[]>;
/** Picks arbitrary documents. */
export type PickDocumentsFn = () => Promise<PickedFile[]>;
/** Captures a photo with the camera (device-only). */
export type CapturePhotoFn = () => Promise<PickedFile | null>;
/** Compresses an image file; non-images (or small images) pass through unchanged. */
export type CompressImageFn = (file: PickedFile) => Promise<PickedFile>;
