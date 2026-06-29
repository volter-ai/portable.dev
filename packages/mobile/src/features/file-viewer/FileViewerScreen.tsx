/**
 * FileViewerScreen — the native repository file viewer.
 *
 * A breadcrumb header +
 * a type-dispatched viewer for code, markdown, image, PDF, CSV (and a download
 * fallback for binary/unsupported types). Drives `useFileContent` (fetch +
 * decode), `detectFileType` (viewer choice), and `Breadcrumb` (path navigation).
 *
 * The PDF viewer is loaded LAZILY (a render-time `require`, only when a PDF is
 * actually opened) — `react-native-pdf` is a device-only native module, so it
 * stays out of the static module graph for any consumer that imports this screen
 * / the route but never opens a PDF (see PdfViewer.tsx). A render-time `require`
 * (rather than `React.lazy` + `Suspense`) avoids a react-test-renderer 19 crash
 * with lazy components under jest-expo. v1 is read-only on both platforms.
 *
 * iOS App Store constraint: every viewer here is NATIVE (code/markdown/CSV/image
 * are RN primitives; PDF uses `react-native-pdf`'s native engine) and loads only
 * the user's OWN sandbox content over an authenticated URL — none embed arbitrary
 * external web content in a WebView (the iOS prohibition documented in the root
 * CLAUDE.md anti-patterns). A type that would otherwise need an external-content
 * WebView is shown as a download fallback instead.
 */

import type { ComponentType } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { useAppTheme } from '../../theme';
import { Icon } from '../../theme/icons/Icon';
import { BinaryFallback } from './BinaryFallback';
import { Breadcrumb } from './Breadcrumb';
import { FileNotFound } from './FileNotFound';
import { useFileContent } from './useFileContent';
import { CodeViewer } from './viewers/CodeViewer';
import { CsvViewer } from './viewers/CsvViewer';
import { ImageViewer } from './viewers/ImageViewer';
import { MarkdownViewer } from './viewers/MarkdownViewer';
import type { AudioViewerProps } from './viewers/AudioViewer';
import type { PdfViewerProps } from './viewers/PdfViewer';
import type { VideoViewerProps } from './viewers/VideoViewer';

// react-native-pdf is a device-only native module — load PdfViewer at RENDER
// time (only when a PDF is actually opened), so importing this screen / its route
// never pulls react-native-pdf into the module graph. The `import type` above is
// erased at runtime (no native module loaded). A render-time require avoids the
// react-test-renderer 19 + React.lazy/Suspense crash under jest-expo.
function loadPdfViewer(): ComponentType<PdfViewerProps> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./viewers/PdfViewer').default as ComponentType<PdfViewerProps>;
}

// Video/audio viewers are loaded the same way (render-time require) so expo-video
// / expo-audio stay out of the static graph of any consumer that opens this screen
// but never plays media. The `import type`s above are erased at runtime.
function loadVideoViewer(): ComponentType<VideoViewerProps> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./viewers/VideoViewer').default as ComponentType<VideoViewerProps>;
}
function loadAudioViewer(): ComponentType<AudioViewerProps> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./viewers/AudioViewer').default as ComponentType<AudioViewerProps>;
}

export interface FileViewerScreenProps {
  owner: string;
  repo: string;
  /** The file path within the repo (e.g. `src/index.ts`). */
  filePath: string;
  /** Navigate to the repo at a directory path (breadcrumb taps). */
  onNavigate?: (dirPath: string) => void;
  /**
   * Called when the back chevron is pressed. Defaults to `router.back()`.
   * Injectable so callers can provide the AC4 canDismiss guard and tests can
   * use a spy without mocking expo-router globally.
   */
  onBack?: () => void;
}

export function FileViewerScreen({
  owner,
  repo,
  filePath,
  onNavigate,
  onBack = () => router.back(),
}: FileViewerScreenProps) {
  const { theme } = useAppTheme();
  // The Stack runs `headerShown:false`, so this screen owns its safe-area chrome
  // (same pattern as RepoPageScreen / RuntimeHeader): pad the top so the breadcrumb
  // clears the status bar/notch, and the bottom so scroll content clears the home
  // indicator (this route pushes OVER the tab bar, so nothing else absorbs the
  // bottom inset).
  const insets = useSafeAreaInsets();
  const { fileType, fileName, content, source, downloadUrl, isLoading, isError, isNotFound } =
    useFileContent(owner, repo, filePath);
  // TEMP [FILEDIAG] — remove after debugging. Confirms the screen mounted + which branch renders.
  console.warn(
    `[FILEDIAG] screen owner=${owner} repo=${repo} path=${filePath} type=${fileType.type} loading=${isLoading} err=${isError} notFound=${isNotFound} contentLen=${content.length}`
  );

  function renderBody() {
    if (isLoading) {
      return (
        <View style={styles.center} testID="file-viewer-loading">
          <ActivityIndicator color={theme.colors.primary} />
          <Text style={[styles.muted, { color: theme.colors.textSecondary }]}>
            Loading {fileName}…
          </Text>
        </View>
      );
    }

    if (isNotFound) {
      return <FileNotFound owner={owner} repo={repo} filePath={filePath} />;
    }

    if (isError) {
      return (
        <View style={styles.center} testID="file-viewer-error">
          <Text style={[styles.errorText, { color: theme.colors.error }]}>Failed to load file</Text>
        </View>
      );
    }

    switch (fileType.type) {
      case 'markdown':
        return <MarkdownViewer content={content} />;
      case 'csv':
        return <CsvViewer content={content} fileName={fileName} />;
      case 'code':
      case 'text':
        return <CodeViewer content={content} language={fileType.language} />;
      case 'image':
        return source ? <ImageViewer source={source} /> : null;
      case 'pdf': {
        if (!source) return null;
        const PdfViewer = loadPdfViewer();
        return <PdfViewer source={source} />;
      }
      case 'video': {
        if (!source) return null;
        const VideoViewer = loadVideoViewer();
        return <VideoViewer source={source} />;
      }
      case 'audio': {
        if (!source) return null;
        const AudioViewer = loadAudioViewer();
        return <AudioViewer source={source} fileName={fileName} />;
      }
      case 'binary':
      default:
        return <BinaryFallback fileName={fileName} downloadUrl={downloadUrl} />;
    }
  }

  return (
    <View
      style={[
        styles.container,
        { paddingTop: insets.top, backgroundColor: theme.colors.background },
      ]}
      testID="file-viewer-screen"
    >
      <View style={styles.header}>
        <Pressable testID="file-viewer-back" onPress={onBack} hitSlop={8} style={styles.back}>
          <Icon name="chevron-left" size={16} color={theme.colors.textSecondary} />
        </Pressable>
        {/* flex:1 so the breadcrumb's inner ScrollView fills the remaining width;
            without it the header's row collapses to intrinsic width and deep
            paths are clipped/unscrollable. */}
        <View style={styles.breadcrumbContainer} testID="breadcrumb-container">
          <Breadcrumb repo={repo} filePath={filePath} onNavigate={onNavigate} />
        </View>
      </View>
      <View style={[styles.body, { paddingBottom: insets.bottom }]}>{renderBody()}</View>
      {/* Hidden marker = the detected viewer type (deterministic assertion). */}
      <Text testID="file-viewer-type" style={styles.hidden}>
        {fileType.type}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  back: { paddingHorizontal: 12, paddingVertical: 8 },
  breadcrumbContainer: { flex: 1 },
  body: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  title: { fontSize: 16, fontWeight: '600' },
  muted: { fontSize: 14, textAlign: 'center' },
  errorText: { fontSize: 15, fontWeight: '600' },
  hidden: { width: 0, height: 0, opacity: 0 },
});
