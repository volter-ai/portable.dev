/**
 * WhaleVideo — the brand's animated whale, rendered as a looping TRANSPARENT
 * animated WebP via `expo-image` (the live theme picks the light/dark variant).
 *
 * It used to render the source `.mov`/`.webm` through `expo-video`, but Android's
 * video decoder DROPS the VP9/HEVC alpha channel, so the whale's transparent area
 * was decoded as solid black baked into every frame — a black box that no
 * `VideoView` prop (`surfaceType`/`useExoShutter`/`backgroundColor`) can remove
 * (iOS was fine because VideoToolbox decodes the HEVC alpha). Android DOES
 * composite IMAGE alpha, so an animated WebP renders transparently on BOTH
 * platforms. The `.webp` assets were generated from the source `.webm` (512px,
 * alpha preserved). `expo-image` is globally mocked in `jest.setup.js`, so this
 * component is Jest-safe wherever it mounts.
 */

import { Image } from 'expo-image';

import { useAppTheme } from '../theme';

export interface WhaleVideoProps {
  /** Square edge length in px (the modal uses ≈ 96; splash uses 150). */
  size?: number;
  testID?: string;
}

export function WhaleVideo({ size = 150, testID }: WhaleVideoProps) {
  const { isDark } = useAppTheme();

  return (
    <Image
      source={
        isDark
          ? require('../../assets/whale/whale-dark-theme.webp')
          : require('../../assets/whale/whale-light-theme.webp')
      }
      style={{ width: size, height: size, backgroundColor: 'transparent' }}
      contentFit="contain"
      // expo-image auto-plays animated WebP and composites the alpha channel on
      // BOTH iOS and Android, so the whale floats transparently over the UI behind.
      testID={testID}
    />
  );
}
