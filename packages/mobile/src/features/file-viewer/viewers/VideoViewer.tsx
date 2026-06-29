/**
 * VideoViewer — native video file viewer.
 *
 * Plays the repo video with **expo-video** (`useVideoPlayer` + `VideoView` with
 * `nativeControls`, which provides play/pause + a seek bar + duration natively).
 * `expo-av` is gone in Expo SDK 56 — `expo-video` is the replacement. The bytes
 * stream from the sandbox `/raw/` endpoint with
 * the `Authorization: Bearer` header attached by `useFileContent` (no `?token=`
 * query — RN carries auth via the header); no external web content is embedded.
 *
 * Loaded LAZILY by `FileViewerScreen` (the `loadPdfViewer` pattern) so expo-video
 * never enters the static graph of a consumer that imports the screen / barrel but
 * never opens a video. `default` export is required by that render-time `require`.
 */

import { memo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';

import { useAppTheme } from '../../../theme';
import type { FileSource } from '../useFileContent';

export interface VideoViewerProps {
  source: FileSource;
}

interface VideoStatusEvent {
  status?: string;
  error?: unknown;
}

const VideoViewer = memo(function VideoViewer({ source }: VideoViewerProps) {
  const { theme } = useAppTheme();
  const [errored, setErrored] = useState(false);

  const player = useVideoPlayer({ uri: source.uri, headers: source.headers }, (p) => {
    p.loop = false;
    // Bind the error listener in the SETUP callback (runs synchronously at player
    // creation) — not a useEffect, which would attach AFTER the first commit and
    // could miss an error event fired during the initial native load (→ a blank
    // player forever). The player owns the listener and releases it on teardown,
    // so no manual cleanup is needed. Guarded so the jest stub (no listeners) is safe.
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
    <View
      style={[styles.container, { backgroundColor: theme.colors.surface }]}
      testID="file-viewer-video"
    >
      {errored ? (
        <Text
          style={[styles.error, { color: theme.colors.error }]}
          testID="file-viewer-video-error"
        >
          This video couldn't be played.
        </Text>
      ) : (
        <VideoView
          player={player}
          style={styles.video}
          contentFit="contain"
          nativeControls
          testID="file-viewer-video-player"
        />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 12 },
  video: { width: '100%', height: '100%' },
  error: { fontSize: 15, fontWeight: '600', textAlign: 'center' },
});

export { VideoViewer };
export default VideoViewer;
