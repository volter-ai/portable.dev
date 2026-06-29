/**
 * Cross-package platform detection.
 *
 * Handles iPadOS 13+ (which reports a Mac UA) and older Android WebViews.
 * Safe to call from any browser context; returns all-false if `navigator`
 * is unavailable (SSR, Node).
 */

export interface PlatformDetection {
  isIOS: boolean;
  isAndroid: boolean;
  /** True when it looks like a phone/tablet browser (iOS or Android). */
  isMobile: boolean;
  /** True when we couldn't confidently classify iOS vs Android. */
  isUnknown: boolean;
}

interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}

export function detectPlatform(): PlatformDetection {
  const nav = (globalThis as { navigator?: NavigatorLike }).navigator;
  if (!nav) {
    return { isIOS: false, isAndroid: false, isMobile: false, isUnknown: true };
  }

  const ua = nav.userAgent || '';
  const platform = nav.platform || '';
  const maxTouchPoints = nav.maxTouchPoints || 0;

  // iPadOS 13+ reports UA as Mac. Detect by touch-capable MacIntel.
  const isIPadOS13Plus = platform === 'MacIntel' && maxTouchPoints > 1;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || isIPadOS13Plus;

  const isAndroid = /Android/i.test(ua);

  const isMobile = isIOS || isAndroid;
  const isUnknown = !isIOS && !isAndroid;

  return { isIOS, isAndroid, isMobile, isUnknown };
}

export function isIOS(): boolean {
  return detectPlatform().isIOS;
}

export function isAndroid(): boolean {
  return detectPlatform().isAndroid;
}
