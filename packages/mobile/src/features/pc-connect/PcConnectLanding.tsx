/**
 * PcConnectLanding — the post-sign-in "Connect your PC" intro page.
 *
 * After Clerk sign-in (and after a Runtime-tab "Disconnect") the device is not yet
 * paired with a PC. Instead of jumping STRAIGHT into the live camera, the gate lands
 * here: a calm intro with the pairing steps and a single "Scan QR code" button. The
 * camera ({@link QrCameraScanner}) opens ONLY when the user taps it — so the OS camera
 * permission prompt + the hardware are never touched without an explicit action, and
 * "the first page after signing in" is this page, not the scanner.
 *
 * Pure presentational + an `onScan` seam (mounting the camera is the gate's job). It
 * uses no native module and no SafeAreaProvider, so it renders under a plain RNTL
 * `render`.
 */

import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, useAppTheme, WhaleIcon } from '../../theme';

const GITHUB_URL = 'https://github.com/volter-ai/portable.dev/';

export interface PcConnectLandingProps {
  /** Open the QR scanner (mount the live camera). */
  onScan: () => void;
}

export function PcConnectLanding({ onScan }: PcConnectLandingProps) {
  const { theme } = useAppTheme();

  return (
    <View
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      testID="pc-connect-landing"
    >
      <View style={styles.body}>
        <WhaleIcon size={72} color={theme.colors.primary} />
        <Text style={[styles.title, { color: theme.colors.text }]}>Connect your PC</Text>
        <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
          Pair this device with your computer to get started.
        </Text>

        <View
          style={[
            styles.card,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
          ]}
        >
          <View style={styles.step}>
            <Text style={[styles.stepLabel, { color: theme.colors.textSecondary }]}>
              1. Install Portable (one-time):
            </Text>
            <View
              style={[
                styles.codeBlock,
                { backgroundColor: theme.colors.background, borderColor: theme.colors.border },
              ]}
            >
              <Text style={[styles.codeText, { color: theme.colors.text }]}>
                npm i -g @volter-ai/portable.dev
              </Text>
            </View>
          </View>

          <View style={styles.step}>
            <Text style={[styles.stepLabel, { color: theme.colors.textSecondary }]}>
              2. Link the project you want to work on:
            </Text>
            <View
              style={[
                styles.codeBlock,
                { backgroundColor: theme.colors.background, borderColor: theme.colors.border },
              ]}
            >
              <Text style={[styles.codeText, { color: theme.colors.text }]}>portable link</Text>
            </View>
          </View>

          <View style={styles.step}>
            <Text style={[styles.stepLabel, { color: theme.colors.textSecondary }]}>
              3. Start Portable, then scan the QR shown in the terminal:
            </Text>
            <View
              style={[
                styles.codeBlock,
                { backgroundColor: theme.colors.background, borderColor: theme.colors.border },
              ]}
            >
              <Text style={[styles.codeText, { color: theme.colors.text }]}>portable start</Text>
            </View>
          </View>
        </View>

        <Pressable
          testID="pc-connect-landing-github"
          accessibilityRole="link"
          hitSlop={8}
          onPress={() => {
            void Linking.openURL(GITHUB_URL);
          }}
          style={styles.linkRow}
        >
          <Icon name="github" size={15} color={theme.colors.primary} />
          <Text style={[styles.link, { color: theme.colors.primary }]}>
            Portable is open source — view it on GitHub
          </Text>
        </Pressable>
      </View>

      <Pressable
        testID="pc-connect-landing-scan"
        accessibilityRole="button"
        onPress={onScan}
        style={[styles.button, { backgroundColor: theme.colors.primary }]}
      >
        <Text style={styles.buttonText}>Scan QR code</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    padding: 24,
    paddingTop: 64,
    paddingBottom: 40,
    justifyContent: 'space-between',
  },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  title: { fontSize: 24, fontWeight: '700', textAlign: 'center' },
  subtitle: { fontSize: 15, textAlign: 'center', maxWidth: 320 },
  card: {
    width: '100%',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 12,
    marginTop: 16,
  },
  step: { gap: 6 },
  stepLabel: { fontSize: 14, lineHeight: 20 },
  codeBlock: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  codeText: {
    fontFamily: Platform.select({ ios: 'Courier', android: 'monospace', default: 'monospace' }),
    fontWeight: '600',
    fontSize: 13,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 4,
  },
  link: { fontSize: 13, fontWeight: '600', textDecorationLine: 'underline' },
  button: { borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
