import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDevModeStore } from '../state/devModeStore';
import { EyeIcon } from './EyeIcon';
import { getGatewayUrl } from './gatewayConfig';
import { ProviderLogo } from './ProviderLogos';
import {
  DEV_MODE_BANNER,
  SIGN_IN_COLORS,
  SIGN_IN_COPY,
  SIGN_IN_GRADIENT,
  SOCIAL_PROVIDER_LABEL,
} from './signInTheme';
import {
  useSignInViewModel,
  type SignInViewModel,
  type SocialProvider,
} from './useSignInViewModel';

// Bundled PNG export of the gateway "whale-white" mark (NOT AVIF — RN can't decode
// AVIF). White whale on a dark field, shown at opacity 0.3 over the #1B1B1B background.
const WHALE_IMAGE = require('../../../assets/images/whale-white.png');

interface SignInScreenProps {
  /**
   * Called with the native Clerk session token once sign-in completes. The route
   * shell wires this to the clerk-exchange + navigation; the default is a no-op so
   * the screen is usable in isolation/tests.
   */
  onAuthenticated?: (token: string | null) => void | Promise<void>;
}

/** Consecutive brand-header taps that flip dev mode. */
export const DEV_MODE_TAP_COUNT = 10;

/** Max gap between consecutive taps before the counter resets. */
export const DEV_MODE_TAP_WINDOW_MS = 2000;

/**
 * The hidden dev-mode gesture: counts taps on the brand header and flips
 * `devModeStore` on the 10th tap of an unbroken (≤2s-gap) run. The Android
 * build-number pattern — invisible to regular users, no extra UI until it fires.
 */
function useDevModeTapToggle(): () => void {
  const taps = useRef(0);
  const lastTapAt = useRef(0);
  return useCallback(() => {
    const now = Date.now();
    taps.current = now - lastTapAt.current > DEV_MODE_TAP_WINDOW_MS ? 1 : taps.current + 1;
    lastTapAt.current = now;
    if (taps.current >= DEV_MODE_TAP_COUNT) {
      taps.current = 0;
      useDevModeStore.getState().toggleDevMode();
    }
  }, []);
}

/**
 * Native Clerk sign-in screen (the gateway landing-page design the user already knows).
 *
 * Offers social (GitHub / Google / Apple) and email/password sign-in, all handled
 * NATIVELY through `@clerk/clerk-expo` (no external browser web-redirect dance).
 * Logic lives in `useSignInViewModel`; this component is a thin view. Design tokens
 * (colors + copy) come from `signInTheme.ts`.
 */
export function SignInScreen({ onAuthenticated }: SignInScreenProps) {
  const vm = useSignInViewModel({ onAuthenticated });
  const insets = useSafeAreaInsets();
  const [showPassword, setShowPassword] = useState(false);
  // Dev mode: red banner + email/password form + dev gateway. Prod mode
  // (default) is SSO-only. Toggled by 10 quick taps on the brand header.
  const devMode = useDevModeStore((s) => s.enabled);
  const onLogoTap = useDevModeTapToggle();

  return (
    <View style={styles.root}>
      {/* Background whale — matching the gateway design. Decorative (pointerEvents
          none) so it never blocks the form; the dev-mode toggle is reachable by
          tapping it via `whaleTapArea` inside the ScrollView. */}
      <Image
        source={WHALE_IMAGE}
        style={styles.whale}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
      />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 48 },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          {/* Whale tap target: the whale is a faint background with
              pointerEvents none, so taps on it fell through and ONLY the title
              counted (users naturally tap the whale "logo"). This transparent
              layer covers the whale's visible area and forwards taps to the same
              dev-mode toggle. It is declared FIRST, so the title / social
              buttons / form (later siblings, painted on top) still capture their
              own taps — this only grabs the empty whale space behind them. */}
          <Pressable
            testID="sign-in-logo-whale"
            accessible={false}
            onPress={onLogoTap}
            style={styles.whaleTapArea}
          />

          {/* Brand header — also the hidden dev-mode toggle target: 10
              quick taps flip dev mode. Not an accessibility-reachable control. */}
          <Pressable testID="sign-in-logo" accessible={false} onPress={onLogoTap}>
            <Text testID="sign-in-title" style={styles.title}>
              {SIGN_IN_COPY.title}
            </Text>
            <Text style={styles.subtitle}>{SIGN_IN_COPY.subtitle}</Text>
          </Pressable>

          {vm.error ? (
            <View testID="sign-in-error" style={styles.errorBox}>
              <Text style={styles.errorGlyph}>⚠</Text>
              <Text style={styles.errorText}>{vm.error}</Text>
            </View>
          ) : null}

          {/* Email / password form — DEV MODE ONLY. Production sign-in is
              SSO-only; the form targets dev-instance test accounts. */}
          {devMode ? (
            <>
              <View style={styles.field}>
                <Text style={styles.label}>{SIGN_IN_COPY.emailLabel}</Text>
                <TextInput
                  testID="sign-in-email"
                  style={styles.input}
                  placeholder={SIGN_IN_COPY.emailPlaceholder}
                  placeholderTextColor={SIGN_IN_COLORS.textDivider}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  autoComplete="email"
                  value={vm.email}
                  editable={!vm.isBusy}
                  onChangeText={vm.setEmail}
                />
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>{SIGN_IN_COPY.passwordLabel}</Text>
                <View style={styles.passwordRow}>
                  <TextInput
                    testID="sign-in-password"
                    style={[styles.input, styles.passwordInput]}
                    placeholder={SIGN_IN_COPY.passwordPlaceholder}
                    placeholderTextColor={SIGN_IN_COLORS.textDivider}
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                    autoComplete="password"
                    value={vm.password}
                    editable={!vm.isBusy}
                    onChangeText={vm.setPassword}
                  />
                  <Pressable
                    testID="sign-in-password-toggle"
                    accessibilityRole="button"
                    accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                    style={styles.eyeToggle}
                    onPress={() => setShowPassword((s) => !s)}
                  >
                    <EyeIcon open={showPassword} />
                  </Pressable>
                </View>
              </View>

              <Pressable
                testID="sign-in-submit"
                accessibilityRole="button"
                disabled={vm.isBusy}
                style={vm.isBusy ? styles.submitDisabled : undefined}
                onPress={() => {
                  void vm.signInWithEmail();
                }}
              >
                <LinearGradient
                  colors={[...SIGN_IN_GRADIENT.colors]}
                  start={SIGN_IN_GRADIENT.start}
                  end={SIGN_IN_GRADIENT.end}
                  style={styles.submit}
                >
                  {vm.isBusy ? (
                    <ActivityIndicator testID="sign-in-busy" size="small" color="#ffffff" />
                  ) : (
                    <Text style={styles.submitText}>{SIGN_IN_COPY.submit}</Text>
                  )}
                </LinearGradient>
              </Pressable>

              {/* Divider. */}
              <View style={styles.divider}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>{SIGN_IN_COPY.dividerLabel}</Text>
                <View style={styles.dividerLine} />
              </View>
            </>
          ) : null}

          {/* Social buttons — GitHub, Google, Apple. */}
          <View style={styles.socialGroup}>
            <SocialButton provider="github" vm={vm} />
            <SocialButton provider="google" vm={vm} />
            <SocialButton provider="apple" vm={vm} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Red dev-mode strip — rendered last so it sits above everything. */}
      {devMode ? (
        <View testID="dev-mode-banner" style={[styles.devBanner, { paddingTop: insets.top + 4 }]}>
          <Text style={styles.devBannerText}>
            {DEV_MODE_BANNER.label} · {getGatewayUrl().replace(/^https?:\/\//, '')}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function SocialButton({ provider, vm }: { provider: SocialProvider; vm: SignInViewModel }) {
  return (
    <Pressable
      testID={`sign-in-social-${provider}`}
      accessibilityRole="button"
      style={[styles.socialButton, vm.isBusy && styles.buttonDisabled]}
      disabled={vm.isBusy}
      onPress={() => {
        void vm.signInWithProvider(provider);
      }}
    >
      <ProviderLogo provider={provider} />
      <Text style={styles.socialButtonText}>{SOCIAL_PROVIDER_LABEL[provider]}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: SIGN_IN_COLORS.background,
  },
  flex: {
    flex: 1,
  },
  whale: {
    position: 'absolute',
    top: '6%',
    alignSelf: 'center',
    width: '90%',
    height: '45%',
    opacity: 0.3,
    pointerEvents: 'none',
  },
  // Transparent tap layer over the whale's visible area (see the JSX comment).
  // Covers the top of the scroll content; later siblings paint on top, so only
  // the empty whale space routes here.
  whaleTapArea: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '45%',
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    maxWidth: 600,
    width: '100%',
    alignSelf: 'center',
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: SIGN_IN_COLORS.textPrimary,
    letterSpacing: -0.5,
    textAlign: 'center',
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 16,
    color: SIGN_IN_COLORS.textSubtitle,
    textAlign: 'center',
    marginBottom: 48,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: SIGN_IN_COLORS.errorBackground,
    borderWidth: 1,
    borderColor: SIGN_IN_COLORS.errorBorder,
    marginBottom: 16,
  },
  errorGlyph: {
    color: SIGN_IN_COLORS.errorText,
    fontSize: 16,
  },
  errorText: {
    flex: 1,
    color: SIGN_IN_COLORS.errorText,
    fontSize: 14,
  },
  field: {
    gap: 8,
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
    color: SIGN_IN_COLORS.textPrimary,
  },
  input: {
    backgroundColor: SIGN_IN_COLORS.inputBackground,
    borderWidth: 1,
    borderColor: SIGN_IN_COLORS.inputBorder,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    color: SIGN_IN_COLORS.textPrimary,
  },
  passwordRow: {
    position: 'relative',
    justifyContent: 'center',
  },
  passwordInput: {
    paddingRight: 48,
  },
  eyeToggle: {
    position: 'absolute',
    right: 12,
    padding: 4,
  },
  submit: {
    height: 48,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  submitDisabled: {
    opacity: 0.5,
  },
  submitText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginVertical: 24,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: SIGN_IN_COLORS.dividerLine,
  },
  dividerText: {
    fontSize: 14,
    color: SIGN_IN_COLORS.textDivider,
  },
  socialGroup: {
    gap: 12,
  },
  socialButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 40,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: SIGN_IN_COLORS.socialButtonBackground,
    borderWidth: 1,
    borderColor: SIGN_IN_COLORS.socialButtonBorder,
  },
  socialButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: SIGN_IN_COLORS.socialButtonText,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  devBanner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    backgroundColor: DEV_MODE_BANNER.background,
    paddingBottom: 6,
    zIndex: 10,
  },
  devBannerText: {
    color: DEV_MODE_BANNER.text,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
  },
});
