/**
 * PdfViewer — native PDF file viewer.
 *
 * The ONLY module that imports `react-native-pdf` (the AC-mandated native PDF
 * renderer). `react-native-pdf` is a DEVICE-ONLY native module (it links
 * PDFKit / PdfRenderer + `react-native-blob-util`), so the screen loads this
 * component LAZILY via `React.lazy` and it is deliberately NOT re-exported from
 * the feature barrel — that keeps the native module out of the Jest module graph
 * for any test that doesn't actually render a PDF (mirrors `CameraCapture`).
 * A test that renders a PDF mocks `react-native-pdf` to a marker
 * component.
 *
 * iOS App Store note: `react-native-pdf` renders via the native PDF engine
 * (PDFKit on iOS), NOT a WebView, and the document is fetched from the user's own
 * sandbox over an authenticated URL — so it does not embed arbitrary external web
 * content (the constraint that bans external-content WebViews on iOS; see the
 * anti-pattern in the root CLAUDE.md). `default` export is required by the lazy
 * `import()` in `FileViewerScreen`.
 */

import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Pdf from 'react-native-pdf';

import { useAppTheme } from '../../../theme';
import type { FileSource } from '../useFileContent';

export interface PdfViewerProps {
  source: FileSource;
}

const PdfViewer = memo(function PdfViewer({ source }: PdfViewerProps) {
  const { theme } = useAppTheme();
  // `react-native-pdf`'s `Pdf` doesn't type `testID`; the wrapper carries it.
  return (
    <View style={[styles.container, { backgroundColor: theme.colors.surface }]} testID="pdf-viewer">
      <Pdf
        source={{ uri: source.uri, headers: source.headers, cache: true }}
        trustAllCerts={false}
        style={[styles.pdf, { backgroundColor: theme.colors.surface }]}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  pdf: { flex: 1, width: '100%', height: '100%' },
});

export default PdfViewer;
