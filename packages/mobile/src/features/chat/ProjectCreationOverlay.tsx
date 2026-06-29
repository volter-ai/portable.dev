/**
 * ProjectCreationOverlay — the full-screen "Creating …" animation shown while the
 * home composer's submit runs intent analysis + project creation:
 *
 *   - a near-opaque themed backdrop (RN has no backdrop-blur without a new dep)
 *   - the "Creating" headline fading in
 *   - a second line where the framework favicon + name (Bun, Next.js, …) slides
 *     out to the left while the resolved project name slides in from the right
 *   - the spinning whale — the SAME looping whale video the
 *     native `LoadingSplash` uses (`WhaleVideo`)
 *
 * Purely presentational: the parent mounts it only while a creation session is
 * active (`useChatComposer().creation`), so every animation value starts fresh
 * per session and all loops stop on unmount (no Jest open-handle leaks — the
 * `ProgressBar`/`TypingIndicator` rule). The two-beat reveal (framework first,
 * then the name sliding in) mirrors the web's 500ms delayed name reveal;
 * `nameRevealDelayMs` is injectable so tests skip the wait.
 */

import { useEffect, useRef } from 'react';
import { Animated, Easing, Image, Modal, StyleSheet, Text, View } from 'react-native';

import { faviconUrl, HOME_FRAMEWORKS } from './frameworks';
import type { ProjectCreationStatus } from './useChatComposer';
import { useWindowInsets } from '../shell/windowInsets';

import { WhaleVideo } from '../../components/WhaleVideo';
import { useAppTheme, withAlpha } from '../../theme';

/** Delay before the project name slides in over the framework line (web: 500ms). */
export const NAME_REVEAL_DELAY_MS = 600;

/** Slide distance (px) of the framework→name cross-transition. */
const SLIDE_DISTANCE = 48;

export interface ProjectCreationOverlayProps {
  status: ProjectCreationStatus;
  /** Delay before the resolved name replaces the framework line (tests pass 0). */
  nameRevealDelayMs?: number;
}

/** Resolve the second line's framework display: catalog name → raw id → kind. */
function frameworkLabel(status: ProjectCreationStatus): string {
  if (status.kind === 'workspace') return 'Workspace';
  if (!status.framework) return status.kind;
  return HOME_FRAMEWORKS.find((f) => f.id === status.framework)?.name ?? status.framework;
}

export function ProjectCreationOverlay({
  status,
  nameRevealDelayMs = NAME_REVEAL_DELAY_MS,
}: ProjectCreationOverlayProps) {
  const { theme } = useAppTheme();
  const insets = useWindowInsets();

  // Entry fades (web `fadeInText`: content at once, whale 300ms later). The
  // whale's spin lives in the looping video itself (`WhaleVideo`).
  const intro = useRef(new Animated.Value(0)).current;
  const whaleIn = useRef(new Animated.Value(0)).current;
  // Framework → project-name cross-slide (0 = framework shown, 1 = name shown).
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const entry = Animated.parallel([
      Animated.timing(intro, {
        toValue: 1,
        duration: 600,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
      Animated.timing(whaleIn, {
        toValue: 1,
        duration: 800,
        delay: 300,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    ]);
    entry.start();
    return () => entry.stop();
  }, [intro, whaleIn]);

  // Two-beat reveal: once the resolved project name is known, wait a moment with
  // the framework showing, then slide the name in (web parity).
  const projectName = status.projectName;
  useEffect(() => {
    if (!projectName) return;
    const timer = setTimeout(() => {
      Animated.timing(slide, {
        toValue: 1,
        duration: 600,
        easing: Easing.bezier(0.4, 0, 0.2, 1),
        useNativeDriver: true,
      }).start();
    }, nameRevealDelayMs);
    return () => clearTimeout(timer);
  }, [projectName, nameRevealDelayMs, slide]);

  const framework = status.framework
    ? HOME_FRAMEWORKS.find((f) => f.id === status.framework)
    : undefined;

  return (
    <Modal visible transparent statusBarTranslucent animationType="fade" onRequestClose={() => {}}>
      <View
        testID="project-creation-overlay"
        style={[
          styles.backdrop,
          {
            backgroundColor: withAlpha(theme.colors.background, 'F2'),
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
          },
        ]}
      >
        <Animated.View
          style={[
            styles.content,
            {
              opacity: intro,
              transform: [
                { translateY: intro.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) },
              ],
            },
          ]}
        >
          <Text
            testID="project-creation-status"
            style={[styles.headline, { color: theme.colors.text }]}
          >
            {status.kind === 'workspace' ? 'Navigating' : 'Creating'}
          </Text>

          {/* Fixed-height stage for the framework ↔ project-name cross-slide. */}
          <View style={styles.lineStage}>
            <Animated.View
              testID="project-creation-framework"
              style={[
                styles.line,
                {
                  opacity: slide.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
                  transform: [
                    {
                      translateX: slide.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, -SLIDE_DISTANCE],
                      }),
                    },
                  ],
                },
              ]}
            >
              {framework?.url ? (
                <Image
                  testID="project-creation-framework-icon"
                  source={{ uri: faviconUrl(framework.url) }}
                  style={styles.frameworkIcon}
                />
              ) : null}
              <Text style={[styles.lineText, { color: theme.colors.text }]} numberOfLines={1}>
                {frameworkLabel(status)}
              </Text>
            </Animated.View>

            {projectName ? (
              <Animated.View
                testID="project-creation-name"
                style={[
                  styles.line,
                  {
                    opacity: slide,
                    transform: [
                      {
                        translateX: slide.interpolate({
                          inputRange: [0, 1],
                          outputRange: [SLIDE_DISTANCE, 0],
                        }),
                      },
                    ],
                  },
                ]}
              >
                <Text
                  style={[
                    projectName.length > 20 ? styles.lineTextSmall : styles.lineText,
                    { color: theme.colors.text },
                  ]}
                  numberOfLines={1}
                >
                  {projectName}
                </Text>
              </Animated.View>
            ) : null}
          </View>

          <Animated.View testID="project-creation-whale" style={{ opacity: whaleIn }}>
            <WhaleVideo size={96} />
          </Animated.View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { alignItems: 'center', gap: 40, paddingHorizontal: 32, maxWidth: '90%' },
  headline: { fontSize: 34, fontWeight: '600', letterSpacing: -0.5, textAlign: 'center' },
  lineStage: {
    height: 48,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  line: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    maxWidth: '100%',
    paddingHorizontal: 8,
  },
  lineText: { fontSize: 26, fontWeight: '500', letterSpacing: -0.4, textAlign: 'center' },
  lineTextSmall: { fontSize: 19, fontWeight: '500', letterSpacing: -0.2, textAlign: 'center' },
  frameworkIcon: { width: 32, height: 32, borderRadius: 6 },
});
