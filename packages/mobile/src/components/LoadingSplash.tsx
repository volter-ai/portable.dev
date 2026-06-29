/**
 * LoadingSplash — the branded full-screen loading surface used by the startup /
 * provisioning / health gates. The accent gradient + the spinning whale + an
 * optional caption (no scripted message state machine). The gradient/colors
 * follow the live theme.
 */

import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';

import { WhaleVideo } from './WhaleVideo';
import { lh, useAppTheme } from '../theme';

export interface LoadingSplashProps {
  /** Optional caption under the whale (e.g. provisioning progress). */
  message?: string;
  /**
   * Optional rich content rendered under the message (e.g. a provisioning
   * progress bar). Kept generic so `LoadingSplash` stays provisioning-agnostic.
   */
  footer?: React.ReactNode;
  testID?: string;
  /** testID for the caption (defaults to `${testID}-message`). */
  messageTestID?: string;
}

export function LoadingSplash({ message, footer, testID, messageTestID }: LoadingSplashProps) {
  const { theme, boldGradient } = useAppTheme();

  return (
    <LinearGradient
      colors={boldGradient}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.fill}
      testID={testID}
    >
      <WhaleVideo size={150} />
      {message ? (
        <Text
          testID={messageTestID ?? (testID ? `${testID}-message` : undefined)}
          style={[
            styles.message,
            { color: '#FFFFFF', lineHeight: lh(16, theme.typography.lineHeights.normal) },
          ]}
        >
          {message}
        </Text>
      ) : null}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  message: {
    marginTop: 24,
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
  },
  footer: {
    marginTop: 28,
    alignSelf: 'stretch',
  },
});
