/**
 * ImageGalleryModal — full-screen swipeable image viewer. Swipe left/right to move
 * between images, swipe down (or tap ✕) to close, driven by
 * `react-native-gesture-handler`'s `Gesture.Pan` (the AC-named lib).
 *
 * The pan gesture runs on the JS thread (`.runOnJS(true)`) so it needs no
 * reanimated worklet and is exercised in tests via gesture-handler's
 * `fireGestureHandler(getByGestureTestId('gallery-pan'), …)`.
 */

import { useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

/** Minimum horizontal/vertical travel (px) that counts as a swipe. */
export const SWIPE_THRESHOLD = 60;

export interface GalleryImage {
  /** Stable key. */
  id: string;
  /** Local or remote image URI. */
  uri: string;
  /** Accessible label / caption. */
  name?: string;
}

export interface ImageGalleryModalProps {
  visible: boolean;
  images: GalleryImage[];
  /** Index to open at. */
  initialIndex?: number;
  onClose: () => void;
}

export function ImageGalleryModal({
  visible,
  images,
  initialIndex = 0,
  onClose,
}: ImageGalleryModalProps) {
  const [index, setIndex] = useState(initialIndex);

  // Clamp the active index when the modal (re)opens or the list shrinks.
  const safeIndex = Math.min(Math.max(index, 0), Math.max(images.length - 1, 0));

  const goNext = () => setIndex((i) => Math.min(i + 1, images.length - 1));
  const goPrev = () => setIndex((i) => Math.max(i - 1, 0));

  const handleSwipe = (dx: number, dy: number) => {
    // A downward swipe closes; a horizontal swipe navigates.
    if (dy > SWIPE_THRESHOLD && Math.abs(dy) > Math.abs(dx)) {
      onClose();
      return;
    }
    if (dx <= -SWIPE_THRESHOLD) goNext();
    else if (dx >= SWIPE_THRESHOLD) goPrev();
  };

  const pan = Gesture.Pan()
    .runOnJS(true)
    .withTestId('gallery-pan')
    .onEnd((e) => handleSwipe(e.translationX, e.translationY));

  if (!visible || images.length === 0) return null;
  const current = images[safeIndex];

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onClose}
      testID="image-gallery-modal"
    >
      <View style={styles.backdrop}>
        <View style={styles.header}>
          <Text style={styles.counter} testID="gallery-index">
            {safeIndex + 1} / {images.length}
          </Text>
          <Pressable testID="gallery-close" accessibilityLabel="Close gallery" onPress={onClose}>
            <Text style={styles.closeGlyph}>✕</Text>
          </Pressable>
        </View>

        <GestureDetector gesture={pan}>
          <View style={styles.imageWrap} testID="gallery-surface">
            <Image
              testID="gallery-image"
              accessibilityLabel={current.name}
              source={{ uri: current.uri }}
              style={styles.image}
              resizeMode="contain"
            />
          </View>
        </GestureDetector>

        {images.length > 1 ? (
          <View style={styles.nav}>
            <Pressable
              testID="gallery-prev"
              accessibilityLabel="Previous image"
              disabled={safeIndex === 0}
              onPress={goPrev}
              style={[styles.navButton, safeIndex === 0 && styles.navDisabled]}
            >
              <Text style={styles.navGlyph}>‹</Text>
            </Pressable>
            <Pressable
              testID="gallery-next"
              accessibilityLabel="Next image"
              disabled={safeIndex === images.length - 1}
              onPress={goNext}
              style={[styles.navButton, safeIndex === images.length - 1 && styles.navDisabled]}
            >
              <Text style={styles.navGlyph}>›</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 48,
    paddingBottom: 8,
  },
  counter: { color: '#fff', fontSize: 15, fontWeight: '600' },
  closeGlyph: { color: '#fff', fontSize: 22, fontWeight: '700', paddingHorizontal: 8 },
  imageWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  image: { width: '100%', height: '100%' },
  nav: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 48,
  },
  navButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  navDisabled: { opacity: 0.3 },
  navGlyph: { color: '#fff', fontSize: 28, fontWeight: '700' },
});
