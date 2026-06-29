/**
 * ImageViewer — native image file viewer (zoom + height).
 *
 * Renders the repo image with the RN `Image` component, streaming the bytes from
 * the sandbox `/raw/` endpoint with the `Authorization: Bearer` header attached
 * by `useFileContent` (no `?token=` query — RN carries auth via the header). No
 * external content is loaded — the URI is the user's own sandbox.
 *
 * The image fills its natural aspect ratio: `Image.getSizeWithHeaders` reads the
 * decoded dimensions and the height is derived from the measured container width
 * (replaces the old hard-coded `height: 400`). Pinch-to-zoom is platform-split:
 *  - iOS uses the native `ScrollView.maximumZoomScale` (free, smooth);
 *  - Android (no native ScrollView zoom) uses a `react-native-gesture-handler`
 *    `Gesture.Pinch()` driving a `react-native-reanimated` scale transform.
 */

import { memo, useEffect, useState } from 'react';
import {
  Image,
  type LayoutChangeEvent,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { useAppTheme } from '../../../theme';
import type { FileSource } from '../useFileContent';

export interface ImageViewerProps {
  source: FileSource;
}

const DEFAULT_HEIGHT = 320;
const MAX_ZOOM = 5;
/** Horizontal padding consumed by the content container (12 each side). */
const H_PADDING = 24;

/** Read the image's natural aspect ratio (width / height) once it loads. */
function useImageAspect(uri: string, headers: Record<string, string>): number | null {
  const [aspect, setAspect] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    const onSize = (w: number, h: number) => {
      if (active && w > 0 && h > 0) setAspect(w / h);
    };
    const withHeaders = (
      Image as unknown as {
        getSizeWithHeaders?: (
          uri: string,
          headers: Record<string, string>,
          success: (w: number, h: number) => void,
          failure?: (e: unknown) => void
        ) => void;
      }
    ).getSizeWithHeaders;
    try {
      // ONLY the header-aware variant: the source needs `Authorization: Bearer`, so a
      // bare `Image.getSize` (no headers) would 401 and waste a fetch. If it's
      // unavailable, the image just renders at DEFAULT_HEIGHT (best-effort aspect).
      if (typeof withHeaders === 'function') {
        withHeaders(uri, headers, onSize, () => {});
      }
    } catch {
      // best-effort — fall back to DEFAULT_HEIGHT.
    }
    return () => {
      active = false;
    };
    // headers are stable per uri (the authed source); depend on uri only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);
  return aspect;
}

export const ImageViewer = memo(function ImageViewer({ source }: ImageViewerProps) {
  const { theme } = useAppTheme();
  const aspect = useImageAspect(source.uri, source.headers);
  const [width, setWidth] = useState(0);

  const contentWidth = Math.max(0, width - H_PADDING);
  const height = aspect && contentWidth ? contentWidth / aspect : DEFAULT_HEIGHT;

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const image = (
    <Image
      testID="file-viewer-image-content"
      source={{ uri: source.uri, headers: source.headers }}
      style={{ width: '100%', height }}
      resizeMode="contain"
    />
  );

  // iOS: native ScrollView pinch-zoom.
  if (Platform.OS === 'ios') {
    return (
      <ScrollView
        style={[styles.container, { backgroundColor: theme.colors.surface }]}
        contentContainerStyle={styles.content}
        maximumZoomScale={MAX_ZOOM}
        minimumZoomScale={1}
        onLayout={onLayout}
        testID="file-viewer-image"
      >
        {image}
      </ScrollView>
    );
  }

  // Android: gesture-driven pinch-zoom (no native ScrollView zoom).
  return (
    <AndroidPinchImage backgroundColor={theme.colors.surface} onLayout={onLayout}>
      {image}
    </AndroidPinchImage>
  );
});

function AndroidPinchImage({
  backgroundColor,
  onLayout,
  children,
}: {
  backgroundColor: string;
  onLayout: (e: LayoutChangeEvent) => void;
  children: React.ReactNode;
}) {
  const scale = useSharedValue(1);
  const saved = useSharedValue(1);

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.max(1, Math.min(saved.value * e.scale, MAX_ZOOM));
    })
    .onEnd(() => {
      saved.value = scale.value;
      if (scale.value < 1) {
        scale.value = withTiming(1);
        saved.value = 1;
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <View
      style={[styles.container, { backgroundColor }]}
      onLayout={onLayout}
      testID="file-viewer-image"
    >
      <GestureDetector gesture={pinch}>
        <Animated.View style={[styles.content, animatedStyle]}>{children}</Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 12 },
});
