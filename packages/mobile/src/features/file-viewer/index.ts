/**
 * File-viewer feature barrel — native viewers for code, markdown,
 * image, PDF, and CSV repository files + the breadcrumb-headed screen.
 *
 * NOTE: `PdfViewer`, `VideoViewer`, and `AudioViewer` are deliberately NOT
 * re-exported here. They import device native modules (`react-native-pdf` /
 * `expo-video` / `expo-audio`) and are loaded lazily by `FileViewerScreen` at
 * render time; re-exporting them would pull those modules into the static module
 * graph of every barrel consumer (the same rule as CameraCapture).
 */

export { FileViewerScreen, type FileViewerScreenProps } from './FileViewerScreen';
export { Breadcrumb, type BreadcrumbProps } from './Breadcrumb';
export { FileNotFound, type FileNotFoundProps } from './FileNotFound';
export { BinaryFallback, type BinaryFallbackProps } from './BinaryFallback';
export {
  useFileContent,
  type UseFileContent,
  type FileContentResult,
  type FileSource,
} from './useFileContent';
export {
  useFileHistory,
  type UseFileHistory,
  type FileHistory,
  type FileHistoryCommit,
} from './useFileHistory';
export {
  detectFileType,
  isBinaryPreview,
  BINARY_PREVIEW_TYPES,
  type FileType,
  type FileTypeInfo,
} from './fileTypeDetector';
export { parseCsv, type ParsedCsv } from './parseCsv';
export { CodeViewer, type CodeViewerProps } from './viewers/CodeViewer';
export { MarkdownViewer, type MarkdownViewerProps } from './viewers/MarkdownViewer';
export { ImageViewer, type ImageViewerProps } from './viewers/ImageViewer';
export { CsvViewer, type CsvViewerProps } from './viewers/CsvViewer';
