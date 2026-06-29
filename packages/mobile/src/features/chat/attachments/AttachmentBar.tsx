/**
 * AttachmentBar — the composer's attach surface: a horizontal strip of
 * attachment thumbnails (with upload status + remove), the source sheet (Photo
 * Library / Files / Camera), and the swipeable {@link ImageGalleryModal}.
 * The web counterpart is `FileUploadArea` + `ImageGalleryModal`.
 *
 * The "+" trigger that OPENS the source sheet does NOT live here — to match the web
 * `ChatInputField`, the composer renders it INLINE beside the placeholder while the
 * input is collapsed and in the action row once it expands (see {@link AttachButton}).
 * AttachmentBar exposes {@link AttachmentBarHandle.openSourceSheet} via `ref` so that
 * relocated button can open the sheet, and reports its live item count through
 * {@link AttachmentBarProps.onItemCountChange} so the composer can stay expanded
 * while attachments are present (web parity: `uploadedFiles.length > 0` → expanded).
 *
 * Library / Files / compress / upload are the integration-tested path (the
 * `expo-image-picker` / `expo-document-picker` / `expo-image-manipulator` adapters
 * are the defaults, overridable in tests). Camera is DEVICE-ONLY and is loaded
 * LAZILY (`React.lazy`) so expo-camera never enters the Jest graph.
 */

import {
  Suspense,
  forwardRef,
  lazy,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useApi } from '../../api/ApiProvider';
import type { UploadFileResponse } from '../../api/hooks';
import type { RelayApiClient } from '../../api/relayClient';
import {
  isImage,
  type CapturePhotoFn,
  type CompressImageFn,
  type PickDocumentsFn,
  type PickImagesFn,
  type PickedFile,
  type UploadedAttachment,
} from './attachment';
import { expoCompressImage, expoPickDocuments, expoPickImages } from './expoPickers';
import { ImageGalleryModal, type GalleryImage } from './ImageGalleryModal';
import { ATTACHMENT_SOURCE_LABELS, useAttachments } from './useAttachments';
import { Icon, useAppTheme } from '../../../theme';

// Device-only surface — lazily loaded so `expo-camera` is imported ONLY when the
// user opens it (never under Jest).
const CameraCapture = lazy(() => import('./CameraCapture'));

/** Imperative handle: the composer's relocated "+" opens the source sheet through this. */
export interface AttachmentBarHandle {
  /** Open the attachment source sheet (Photo Library / Files / Camera). */
  openSourceSheet: () => void;
  /** Remove every attachment (called after a successful submit). */
  clear: () => void;
}

export interface AttachmentBarProps {
  /** Called whenever the set of successfully-uploaded attachments changes. */
  onChange?: (uploaded: UploadedAttachment[]) => void;
  /** Called whenever the count of attachment items (any status) changes. */
  onItemCountChange?: (count: number) => void;
  /** Called when the uploading state changes — true while any item is still uploading. */
  onUploadingChange?: (isUploading: boolean) => void;
  /** Override the image-library picker (default: `expo-image-picker`). */
  pickImages?: PickImagesFn;
  /** Override the document picker (default: `expo-document-picker`). */
  pickDocuments?: PickDocumentsFn;
  /** Override the image compressor (default: `expo-image-manipulator`). */
  compress?: CompressImageFn;
  /** Override the camera capture (default: lazy `expo-camera` surface). */
  capturePhoto?: CapturePhotoFn;
  /** Override the upload step (default: multipart `POST /api/upload`). */
  upload?: (api: RelayApiClient, file: PickedFile) => Promise<UploadFileResponse>;
}

type Overlay = 'camera' | null;

export const AttachmentBar = forwardRef<AttachmentBarHandle, AttachmentBarProps>(
  function AttachmentBar(
    {
      onChange,
      onItemCountChange,
      onUploadingChange,
      pickImages = expoPickImages,
      pickDocuments = expoPickDocuments,
      compress = expoCompressImage,
      capturePhoto,
      upload,
    },
    ref
  ) {
    const api = useApi();
    const { theme } = useAppTheme();
    const [sheetOpen, setSheetOpen] = useState(false);
    const [overlay, setOverlay] = useState<Overlay>(null);
    const [galleryIndex, setGalleryIndex] = useState<number | null>(null);

    const attachments = useAttachments({
      api,
      pickImages,
      pickDocuments,
      capturePhoto,
      compress,
      upload,
    });

    // The composer's relocated "+" opens the source sheet through this handle;
    // `clear` empties the strip after a successful submit (the uploads now ride
    // the sent message — web `clearFiles` parity).
    useImperativeHandle(
      ref,
      () => ({ openSourceSheet: () => setSheetOpen(true), clear: attachments.clear }),
      [attachments.clear]
    );

    // Surface the uploaded set to the parent whenever it changes.
    const uploadedKey = attachments.uploaded.map((a) => a.response.path).join('|');
    useEffect(() => {
      onChange?.(attachments.uploaded);
      // Keyed on the joined paths so the effect fires only when the set changes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [uploadedKey]);

    // Report the live item count so the composer stays expanded while attaching.
    const itemCount = attachments.items.length;
    useEffect(() => {
      onItemCountChange?.(itemCount);
    }, [itemCount, onItemCountChange]);

    // Report uploading state so the parent composer can block send while in-flight.
    const { isUploading } = attachments;
    useEffect(() => {
      onUploadingChange?.(isUploading);
    }, [isUploading, onUploadingChange]);

    const galleryImages: GalleryImage[] = attachments.items
      .filter((it) => isImage(it.file))
      .map((it) => ({ id: it.id, uri: it.file.uri, name: it.file.name }));

    const openGalleryFor = (id: string) => {
      const idx = galleryImages.findIndex((g) => g.id === id);
      if (idx >= 0) setGalleryIndex(idx);
    };

    // Pending action to run after the source sheet has fully dismissed. Stored in a ref
    // so setting it doesn't trigger an extra re-render and there are no stale-closure
    // issues — the ref is read synchronously inside handleSheetDismiss.
    const pendingPickRef = useRef<(() => Promise<void>) | null>(null);

    // Stores the chosen picker action until the source sheet has fully dismissed.
    // iOS only — Android routes through the immediate branch in pick() below.
    const pick = (action: () => Promise<void>) => {
      if (Platform.OS === 'ios') {
        // iOS UIKit refuses to present a native VC while a JS Modal is still in its
        // dismiss animation — defer to handleSheetDismiss (Modal onDismiss), which
        // fires only after the animation completes.
        pendingPickRef.current = action;
        setSheetOpen(false);
      } else {
        // Android does not have the iOS UIKit timing constraint. onDismiss is also
        // not reliably fired on Android, so routing through pendingPickRef would
        // silently stall the picker — launch directly.
        setSheetOpen(false);
        action().catch(() => {
          Alert.alert('Attachment error', 'Could not open picker. Please try again.');
        });
      }
    };

    // iOS only: called by the source-sheet Modal's onDismiss after the dismiss
    // animation completes. Runs the action stored by pick() and surfaces launch
    // errors instead of swallowing them.
    const handleSheetDismiss = useCallback(async () => {
      const fn = pendingPickRef.current;
      if (!fn) return;
      pendingPickRef.current = null;
      try {
        await fn();
      } catch {
        Alert.alert('Attachment error', 'Could not open picker. Please try again.');
      }
    }, []);

    return (
      <>
        {attachments.items.length > 0 ? (
          <View testID="attachment-bar" style={styles.bar}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip}>
              {attachments.items.map((it) => {
                const image = isImage(it.file);
                return (
                  <View key={it.id} testID={`attachment-item-${it.id}`} style={styles.thumb}>
                    <Pressable
                      disabled={!image}
                      onPress={() => image && openGalleryFor(it.id)}
                      style={[styles.thumbInner, { backgroundColor: theme.colors.surfaceHover }]}
                      testID={`attachment-open-${it.id}`}
                    >
                      {image ? (
                        <Image source={{ uri: it.file.uri }} style={styles.thumbImage} />
                      ) : (
                        <View style={styles.fileThumb}>
                          <Text style={styles.fileGlyph}>📄</Text>
                          <Text
                            style={[styles.fileName, { color: theme.colors.textSecondary }]}
                            numberOfLines={1}
                          >
                            {it.file.name}
                          </Text>
                        </View>
                      )}
                    </Pressable>

                    {it.status === 'uploading' ? (
                      <View style={styles.thumbOverlay} testID={`attachment-uploading-${it.id}`}>
                        <ActivityIndicator size="small" color="#fff" />
                      </View>
                    ) : null}
                    {it.status === 'error' ? (
                      <View style={styles.thumbOverlay} testID={`attachment-error-${it.id}`}>
                        <Text style={styles.errorGlyph}>!</Text>
                      </View>
                    ) : null}

                    <Pressable
                      testID={`attachment-remove-${it.id}`}
                      accessibilityLabel="Remove attachment"
                      style={[styles.removeButton, { backgroundColor: theme.colors.text }]}
                      onPress={() => attachments.remove(it.id)}
                    >
                      <Icon
                        name="xmark"
                        size={11}
                        color={theme.colors.background}
                        strokeWidth={2.5}
                      />
                    </Pressable>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        {/* Source sheet — always mounted so onDismiss fires after the animation
            completes; visibility is controlled via the `visible` prop. */}
        <Modal
          visible={sheetOpen}
          transparent
          animationType="slide"
          onRequestClose={() => setSheetOpen(false)}
          onDismiss={handleSheetDismiss}
          testID="attach-source-sheet"
        >
          <Pressable
            style={styles.sheetBackdrop}
            testID="attach-source-backdrop"
            onPress={() => setSheetOpen(false)}
          />
          <View style={[styles.sheet, { backgroundColor: theme.colors.backgroundElevated }]}>
            <SourceOption
              testID="attach-source-library"
              label={ATTACHMENT_SOURCE_LABELS.library}
              onPress={() => pick(attachments.addFromLibrary)}
            />
            <SourceOption
              testID="attach-source-document"
              label={ATTACHMENT_SOURCE_LABELS.document}
              onPress={() => pick(attachments.addFromDocuments)}
            />
            <SourceOption
              testID="attach-source-camera"
              label={ATTACHMENT_SOURCE_LABELS.camera}
              onPress={() => {
                setSheetOpen(false);
                if (capturePhoto) void attachments.addFromCamera();
                else setOverlay('camera');
              }}
            />
          </View>
        </Modal>

        {/* Image gallery */}
        <ImageGalleryModal
          visible={galleryIndex !== null}
          images={galleryImages}
          initialIndex={galleryIndex ?? 0}
          onClose={() => setGalleryIndex(null)}
        />

        {/* Device-only overlay */}
        {overlay === 'camera' ? (
          <Modal
            visible
            animationType="slide"
            onRequestClose={() => setOverlay(null)}
            testID="camera-overlay"
          >
            <Suspense fallback={<View style={styles.overlayFallback} />}>
              <CameraCapture
                onClose={() => setOverlay(null)}
                onCapture={(file) => {
                  setOverlay(null);
                  void attachments.addFile(file);
                }}
              />
            </Suspense>
          </Modal>
        ) : null}
      </>
    );
  }
);

AttachmentBar.displayName = 'AttachmentBar';

function SourceOption(props: { testID: string; label: string; onPress: () => void }) {
  const { theme } = useAppTheme();
  return (
    <Pressable testID={props.testID} style={styles.sheetOption} onPress={props.onPress}>
      <Text style={[styles.sheetOptionText, { color: theme.colors.text }]}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center' },
  strip: { flexGrow: 0 },
  thumb: { width: 64, height: 64, marginRight: 8, borderRadius: 8, overflow: 'visible' },
  thumbInner: {
    width: 64,
    height: 64,
    borderRadius: 8,
    overflow: 'hidden',
  },
  thumbImage: { width: 64, height: 64 },
  fileThumb: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 4 },
  fileGlyph: { fontSize: 22 },
  fileName: { fontSize: 9 },
  thumbOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 8,
  },
  errorGlyph: { color: '#fff', fontSize: 20, fontWeight: '800' },
  removeButton: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingVertical: 8,
  },
  sheetOption: { paddingVertical: 16, paddingHorizontal: 24 },
  sheetOptionText: { fontSize: 16 },
  overlayFallback: { flex: 1, backgroundColor: '#000' },
});
