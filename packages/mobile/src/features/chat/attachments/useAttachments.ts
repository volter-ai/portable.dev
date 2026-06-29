/**
 * Attachments ViewModel — orchestrates pick → compress → upload and
 * owns the list of in-flight / uploaded attachments. Native-module-free: every
 * source (image library / document picker / camera / drawing) and the compress +
 * upload steps are injected, so this hook + its tests run with no native runtime.
 * {@link AttachmentBar} wires the production seams (the `expo*` adapters + the
 * authed sandbox client). Mirrors the web `useFileUpload` hook.
 */

import { useCallback, useRef, useState } from 'react';

import type { RelayApiClient } from '../../api/relayClient';
import {
  type AttachmentSource,
  type CapturePhotoFn,
  type CompressImageFn,
  type PickDocumentsFn,
  type PickImagesFn,
  type PickedFile,
  type UploadedAttachment,
} from './attachment';
import { uploadAttachment as defaultUpload } from './uploadAttachment';

/** An attachment as the UI sees it — uploading, uploaded, or failed. */
export interface AttachmentItem {
  id: string;
  file: PickedFile;
  status: 'uploading' | 'done' | 'error';
  /** The server response once `status === 'done'`. */
  attachment?: UploadedAttachment;
  /** The failure once `status === 'error'`. */
  error?: unknown;
}

export interface UseAttachmentsDeps {
  /** The authed sandbox client (`POST /api/upload`). */
  api: RelayApiClient;
  pickImages: PickImagesFn;
  pickDocuments: PickDocumentsFn;
  /** Optional — camera is device-only; omit and the camera action is unavailable. */
  capturePhoto?: CapturePhotoFn;
  compress: CompressImageFn;
  /** Override the upload step (default: multipart `POST /api/upload`). */
  upload?: (api: RelayApiClient, file: PickedFile) => Promise<UploadedAttachment['response']>;
  /** Stable id generator (injectable for deterministic tests). */
  makeId?: () => string;
}

export interface UseAttachments {
  /** The attachment list (uploading + done + error), newest last. */
  items: AttachmentItem[];
  /** Only the successfully-uploaded attachments (what a message carries). */
  uploaded: UploadedAttachment[];
  /** True while any attachment is still uploading. */
  isUploading: boolean;
  /** Pick from the photo library → compress → upload. */
  addFromLibrary: () => Promise<void>;
  /** Pick documents → upload (no compression for non-images). */
  addFromDocuments: () => Promise<void>;
  /** Capture a photo → compress → upload (no-op if no camera seam). */
  addFromCamera: () => Promise<void>;
  /** Add an already-produced file (e.g. the drawing canvas export) → upload. */
  addFile: (file: PickedFile) => Promise<void>;
  /** Remove an attachment by id (before or after upload). */
  remove: (id: string) => void;
  /** Clear all attachments (e.g. after the message is sent). */
  clear: () => void;
}

let idCounter = 0;
function defaultMakeId(): string {
  idCounter += 1;
  return `att-${idCounter}`;
}

export function useAttachments(deps: UseAttachmentsDeps): UseAttachments {
  const {
    api,
    pickImages,
    pickDocuments,
    capturePhoto,
    compress,
    upload = defaultUpload,
    makeId = defaultMakeId,
  } = deps;

  const [items, setItems] = useState<AttachmentItem[]>([]);
  // Keep the live deps in a ref so the long-lived callbacks always use the latest.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const setStatus = useCallback((id: string, patch: Partial<AttachmentItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  /** Compress (images only) then upload a single file, tracking its status. */
  const ingest = useCallback(
    async (raw: PickedFile, willCompress: boolean) => {
      const id = makeId();
      setItems((prev) => [...prev, { id, file: raw, status: 'uploading' }]);
      try {
        const file = willCompress ? await compress(raw) : raw;
        // Reflect the (possibly recompressed) file so the thumbnail uses it.
        setStatus(id, { file });
        const response = await upload(api, file);
        setStatus(id, {
          status: 'done',
          file,
          attachment: { id, file, response },
        });
      } catch (error) {
        setStatus(id, { status: 'error', error });
      }
    },
    [api, compress, makeId, setStatus, upload]
  );

  const ingestMany = useCallback(
    async (files: PickedFile[], willCompress: boolean) => {
      // Upload concurrently — each tracks its own status independently.
      await Promise.all(files.map((f) => ingest(f, willCompress)));
    },
    [ingest]
  );

  const addFromLibrary = useCallback(async () => {
    const files = await depsRef.current.pickImages();
    await ingestMany(files, true);
  }, [ingestMany]);

  const addFromDocuments = useCallback(async () => {
    const files = await depsRef.current.pickDocuments();
    // Documents may include images too — compress only when it's an image.
    await Promise.all(files.map((f) => ingest(f, f.mimeType.startsWith('image/'))));
  }, [ingest]);

  const addFromCamera = useCallback(async () => {
    const capture = depsRef.current.capturePhoto;
    if (!capture) return;
    const file = await capture();
    if (file) await ingest(file, true);
  }, [ingest]);

  const addFile = useCallback(
    async (file: PickedFile) => {
      await ingest(file, file.mimeType.startsWith('image/'));
    },
    [ingest]
  );

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const uploaded = items
    .filter((it): it is AttachmentItem & { attachment: UploadedAttachment } => !!it.attachment)
    .map((it) => it.attachment);
  const isUploading = items.some((it) => it.status === 'uploading');

  return {
    items,
    uploaded,
    isUploading,
    addFromLibrary,
    addFromDocuments,
    addFromCamera,
    addFile,
    remove,
    clear,
  };
}

/** Source actions a user can pick from in the attach sheet. */
export const ATTACHMENT_SOURCE_LABELS: Record<AttachmentSource, string> = {
  library: 'Photo Library',
  document: 'Files',
  camera: 'Camera',
};
