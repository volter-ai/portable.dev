/**
 * AudioViewer — native audio file viewer.
 *
 * Plays the repo audio with **expo-audio** (`useAudioPlayer` + the
 * `useAudioPlayerStatus` hook for live position/duration). `expo-av` is gone in
 * Expo SDK 56 — `expo-audio` is the playback module. Minimal player UI: file
 * name, a play/pause button, a tappable seek bar,
 * and elapsed / total time. The bytes stream from the sandbox `/raw/` endpoint
 * with the `Authorization: Bearer` header attached by `useFileContent`.
 *
 * Loaded LAZILY by `FileViewerScreen` (the `loadPdfViewer` pattern) so expo-audio
 * never enters the static graph of a consumer that imports the screen / barrel but
 * never opens an audio file. `default` export is required by that render-time
 * `require`.
 */

import { memo, useRef } from 'react';
import {
  type GestureResponderEvent,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';

import { useAppTheme } from '../../../theme';
import { Icon } from '../../../theme/icons/Icon';
import type { FileSource } from '../useFileContent';

export interface AudioViewerProps {
  source: FileSource;
  fileName: string;
}

/** Seconds → `m:ss` (e.g. 75 → `1:15`). */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const AudioViewer = memo(function AudioViewer({ source, fileName }: AudioViewerProps) {
  const { theme } = useAppTheme();
  const player = useAudioPlayer({ uri: source.uri, headers: source.headers });
  const status = useAudioPlayerStatus(player);

  const playing = status?.playing ?? false;
  const duration = status?.duration ?? 0;
  const elapsed = Math.min(status?.currentTime ?? 0, duration || Infinity);
  const progress = duration > 0 ? Math.min(1, elapsed / duration) : 0;

  // A ref (not a render-local) so the measured width survives the per-tick status
  // re-renders — onLayout only fires on layout changes, not on every render.
  const trackWidthRef = useRef(0);
  const onTrackLayout = (e: LayoutChangeEvent) => {
    trackWidthRef.current = e.nativeEvent.layout.width;
  };

  function togglePlay() {
    if (playing) player.pause();
    else player.play();
  }

  function seekTo(e: GestureResponderEvent) {
    const width = trackWidthRef.current;
    if (duration <= 0 || width <= 0) return;
    const ratio = Math.max(0, Math.min(1, e.nativeEvent.locationX / width));
    void player.seekTo(ratio * duration);
  }

  return (
    <View
      style={[styles.container, { backgroundColor: theme.colors.surface }]}
      testID="file-viewer-audio"
    >
      <View
        style={[
          styles.card,
          { backgroundColor: theme.colors.backgroundElevated, borderColor: theme.colors.border },
        ]}
      >
        <Text
          style={[styles.name, { color: theme.colors.text }]}
          numberOfLines={1}
          testID="file-viewer-audio-name"
        >
          {fileName}
        </Text>

        <View style={styles.controls}>
          <Pressable
            testID="file-viewer-audio-playpause"
            onPress={togglePlay}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityState={{ selected: playing }}
            style={[styles.playButton, { backgroundColor: theme.colors.primary }]}
          >
            <Icon name={playing ? 'pause' : 'play'} size={20} color={theme.colors.background} />
          </Pressable>

          <View style={styles.trackArea}>
            <Pressable testID="file-viewer-audio-seek" onPress={seekTo} onLayout={onTrackLayout}>
              <View style={[styles.track, { backgroundColor: theme.colors.borderLight }]}>
                <View
                  style={[
                    styles.trackFill,
                    { backgroundColor: theme.colors.primary, width: `${progress * 100}%` },
                  ]}
                />
              </View>
            </Pressable>
            <View style={styles.times}>
              <Text
                style={[styles.time, { color: theme.colors.textSecondary }]}
                testID="file-viewer-audio-elapsed"
              >
                {formatTime(elapsed)}
              </Text>
              <Text
                style={[styles.time, { color: theme.colors.textSecondary }]}
                testID="file-viewer-audio-duration"
              >
                {formatTime(duration)}
              </Text>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: {
    width: '100%',
    maxWidth: 480,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    gap: 14,
  },
  name: { fontSize: 15, fontWeight: '600', textAlign: 'center' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  playButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackArea: { flex: 1, gap: 6 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  trackFill: { height: 6, borderRadius: 3 },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  time: { fontSize: 12, fontVariant: ['tabular-nums'] },
});

export { AudioViewer };
export default AudioViewer;
