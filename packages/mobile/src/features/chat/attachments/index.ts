/**
 * Attachments feature barrel — file/image upload, gallery, camera.
 * The device-only `CameraCapture` is intentionally NOT re-exported here (it imports
 * `expo-camera`); it is lazily imported inside {@link AttachmentBar} so the native
 * module never enters the Jest module graph.
 */

export { AttachmentBar, type AttachmentBarProps, type AttachmentBarHandle } from './AttachmentBar';
export {
  useAttachments,
  ATTACHMENT_SOURCE_LABELS,
  type UseAttachments,
  type UseAttachmentsDeps,
  type AttachmentItem,
} from './useAttachments';
export {
  ImageGalleryModal,
  SWIPE_THRESHOLD,
  type ImageGalleryModalProps,
  type GalleryImage,
} from './ImageGalleryModal';
export {
  expoPickImages,
  expoPickDocuments,
  expoCompressImage,
  COMPRESS_THRESHOLD_BYTES,
  COMPRESS_MAX_DIMENSION,
  COMPRESS_QUALITY,
} from './expoPickers';
export { uploadAttachment } from './uploadAttachment';
export {
  isImage,
  type PickedFile,
  type UploadedAttachment,
  type AttachmentSource,
  type PickImagesFn,
  type PickDocumentsFn,
  type CapturePhotoFn,
  type CompressImageFn,
} from './attachment';
