// Jest mock for react-native-reanimated (wired via jest.config.js
// `moduleNameMapper` for BOTH `react-native-reanimated` AND
// `react-native-reanimated/mock`). It applies to EVERY importer regardless of how
// Bun's symlinked store resolves the package — a setup-file `jest.mock` proved
// resolution-sensitive and missed deeply-imported consumers.
//
// Reanimated worklets run on a native UI thread that doesn't exist under
// jest-expo, and the library's OWN `react-native-reanimated/mock` is unusable:
// its TS source imports the real `./index`, which initializes
// `react-native-worklets` native at module-load and throws "Native part of
// Worklets doesn't seem to be initialized". So this is a hand-rolled plain-JS
// stub (the codebase's native-module pattern — cf. expo-video / react-native-mmkv)
// covering the APIs the chat directory's SwipeableChatRow uses AND the ones
// gesture-handler's GestureDetector reaches into (useEvent / useSharedValue /
// setGestureState / default.createAnimatedComponent).
//
// The `/mock` mapping is load-bearing: `expo-router/testing-library` registers its
// OWN `jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'))`
// (which overrides our bare mapping for renderRouter tests) and falls back to `{}`
// when the real `/mock` throws. Mapping `/mock` here makes that factory return THIS
// stub. Kept OUT of a `__mocks__/` folder on purpose — a file there is a jest manual
// mock, which interfered with that `/mock` require resolving to it.
const React = require('react');
const { View, Text, Image, ScrollView } = require('react-native');

const wrap = (Base) =>
  React.forwardRef((props, ref) => React.createElement(Base, { ...props, ref }));

const Animated = {
  View: wrap(View),
  Text: wrap(Text),
  Image: wrap(Image),
  ScrollView: wrap(ScrollView),
  createAnimatedComponent: (C) => C,
};

const passEasing = (t) => t;

module.exports = {
  __esModule: true,
  default: Animated,
  View: Animated.View,
  Text: Animated.Text,
  Image: Animated.Image,
  ScrollView: Animated.ScrollView,
  createAnimatedComponent: Animated.createAnimatedComponent,
  useSharedValue: (init) => ({ value: init }),
  useAnimatedStyle: (fn) => fn(),
  useDerivedValue: (fn) => ({ value: fn() }),
  useAnimatedRef: () => ({ current: null }),
  // gesture-handler's GestureDetector reaches into reanimated for these:
  useEvent: () => () => {},
  useAnimatedReaction: () => {},
  setGestureState: () => {},
  withTiming: (toValue) => toValue,
  withSpring: (toValue) => toValue,
  withDelay: (_d, anim) => anim,
  withRepeat: (anim) => anim,
  withSequence: (...anims) => anims[anims.length - 1],
  cancelAnimation: () => {},
  runOnJS: (fn) => fn,
  runOnUI: (fn) => fn,
  interpolate: (x) => x,
  Extrapolation: { CLAMP: 'clamp', EXTEND: 'extend', IDENTITY: 'identity' },
  Easing: {
    linear: passEasing,
    ease: passEasing,
    quad: passEasing,
    cubic: passEasing,
    in: passEasing,
    out: passEasing,
    inOut: (e) => e,
    bezier: () => passEasing,
  },
};
