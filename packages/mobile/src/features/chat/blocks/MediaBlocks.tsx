/**
 * ImageBlock / VideoBlock — media blocks.
 *
 * The PC api emits a screenshot / video as a separate `image`/`video` block (see
 * `MediaProcessingService` + `StreamHandler`): a screenshot is an inline `base64`
 * image (when the PC has no ffmpeg) or a `/data/media/...webp` URL; a video is a
 * `/data/media/...` (display_video) or `/api/video/...` (browser recording) URL.
 *
 * - `ImageBlock` renders through the RN `Image` component. Inline base64 → a `data:`
 *   URI (loads with zero relay/auth). A relative `/data/media` / `/api/...` URL is
 *   resolved to the ABSOLUTE relay base (+ `Bearer` for `/api/*`) via
 *   `resolveAuthedMediaSource` and passed as `source={{ uri, headers }}`.
 * - `VideoBlock` plays the video with **expo-video** (`useVideoPlayer` + `VideoView`,
 *   native controls) — NOT a bare "open link" — over the same resolved source; a
 *   playback error falls back to an open-externally link. (The `display_video` TOOL_USE
 *   itself no longer renders here — the PC emits the playable video as a separate
 *   `video` block; the tool_use shows as a generic tool block.)
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

import { useAppTheme } from '../../../theme';
import type { ToolResult } from './blockHelpers';
import {
  getImageSource,
  getVideoSource,
  isInlineUri,
  resolveAuthedMediaSource,
  type AuthedMediaSource,
} from './mediaSource';

export interface MediaBlockProps {
  block: ClaudeStreamBlock;
  result?: ToolResult;
  isRecent?: boolean;
}

/**
 * Resolve a raw media URL (data-URI / absolute / relative PC path) to a loadable
 * `{ uri, headers? }`. Inline (`data:` / `http(s)`) sources resolve SYNCHRONOUSLY (no
 * relay round-trip, no flash); a relative `/data/media` / `/api/...` path resolves in
 * an effect against the relay base + Bearer. `null` until a relative path resolves.
 */
function useAuthedMediaSource(rawUrl: string): AuthedMediaSource | null {
  const [source, setSource] = useState<AuthedMediaSource | null>(
    isInlineUri(rawUrl) ? { uri: rawUrl } : null
  );

  useEffect(() => {
    if (isInlineUri(rawUrl)) {
      setSource({ uri: rawUrl });
      return;
    }
    let active = true;
    void resolveAuthedMediaSource(rawUrl).then((resolved) => {
      if (active) setSource(resolved);
    });
    return () => {
      active = false;
    };
  }, [rawUrl]);

  return source;
}

export const ImageBlock = memo(function ImageBlock({ block }: MediaBlockProps) {
  const { theme } = useAppTheme();
  const media = useAuthedMediaSource(getImageSource(block));

  return (
    <View testID="block-image" style={styles.imageWrapper}>
      {media ? (
        <Image
          testID="block-image-img"
          source={{ uri: media.uri, headers: media.headers }}
          style={[
            styles.image,
            { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundElevated },
          ]}
          resizeMode="contain"
          accessibilityLabel="Screenshot"
        />
      ) : (
        <View
          testID="block-image-loading"
          style={[
            styles.image,
            { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundElevated },
          ]}
        />
      )}
    </View>
  );
});

interface VideoStatusEvent {
  status?: string;
  error?: unknown;
}

export const VideoBlock = memo(function VideoBlock({ block }: MediaBlockProps) {
  const { theme } = useAppTheme();
  const media = useAuthedMediaSource(getVideoSource(block).src);
  const [errored, setErrored] = useState(false);

  // Memoize the player source so expo-video doesn't recreate the player every render
  // (a fresh object identity would re-init the native player on each commit).
  const authHeader = media?.headers?.Authorization;
  const source = useMemo(
    () => (media ? { uri: media.uri, headers: media.headers } : null),
    [media?.uri, authHeader]
  );

  const player = useVideoPlayer(source, (p) => {
    p.loop = false;
    // Bind the error listener in the SETUP callback (the file-viewer VideoViewer
    // pattern): it runs synchronously at player creation, so it can't miss an error
    // fired during the initial native load. Guarded so the jest stub (no listeners) is safe.
    const withListener = p as unknown as {
      addListener?: (event: 'statusChange', cb: (payload: VideoStatusEvent) => void) => unknown;
    };
    if (typeof withListener.addListener === 'function') {
      withListener.addListener('statusChange', (payload: VideoStatusEvent) => {
        if (payload?.status === 'error' || payload?.error) setErrored(true);
      });
    }
  });

  return (
    <View testID="block-video" style={styles.videoWrapper}>
      {media && !errored ? (
        <VideoView
          testID="block-video-player"
          player={player}
          style={styles.video}
          contentFit="contain"
          nativeControls
        />
      ) : errored && media ? (
        <Pressable
          testID="block-video-open"
          accessibilityRole="link"
          onPress={() => {
            void Linking.openURL(media.uri).catch(() => {});
          }}
        >
          <Text style={[styles.videoLink, { color: theme.colors.link }]} numberOfLines={1}>
            This video couldn&rsquo;t be played — open externally
          </Text>
        </Pressable>
      ) : (
        <View
          testID="block-video-loading"
          style={[styles.videoSurface, { backgroundColor: theme.colors.text }]}
        >
          <Text style={[styles.playGlyph, { color: theme.colors.textInverse }]}>▶</Text>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  imageWrapper: { marginVertical: 6 },
  image: {
    width: 240,
    height: 180,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  videoWrapper: { marginVertical: 6, gap: 6 },
  video: {
    width: 240,
    height: 180,
    borderRadius: 6,
    backgroundColor: '#000',
  },
  videoSurface: {
    width: 240,
    height: 135,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playGlyph: { fontSize: 28 },
  videoLink: { fontSize: 13, textDecorationLine: 'underline' },
});
