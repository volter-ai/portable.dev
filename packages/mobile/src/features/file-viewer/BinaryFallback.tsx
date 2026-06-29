/**
 * BinaryFallback — the "can't preview" state for an unpreviewable binary.
 *
 * Replaces the old dead-end "Can't preview" text with a "Download file" button
 * that opens the file's authenticated `/raw/` URL in the SYSTEM browser
 * (`openExternalLink` → `expo-web-browser`). It does NOT download
 * locally via `expo-file-system`; the browser streams the bytes (the `?token=` on
 * the URL authenticates the cookie-less request). On iOS this is the system
 * browser (SFSafariViewController), never an embedded WebView.
 */

import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../theme';
import { Icon } from '../../theme/icons/Icon';
import { openExternalLink } from './openExternalLink';

export interface BinaryFallbackProps {
  fileName: string;
  /** Authenticated raw URL (`?token=`); null while it resolves. */
  downloadUrl: string | null;
  /** Browser opener — injectable so tests don't load expo-web-browser. */
  onDownload?: (url: string) => void;
}

export const BinaryFallback = memo(function BinaryFallback({
  fileName,
  downloadUrl,
  onDownload = openExternalLink,
}: BinaryFallbackProps) {
  const { theme } = useAppTheme();

  return (
    <View style={styles.center} testID="file-viewer-binary">
      <Icon name="file" size={40} color={theme.colors.textTertiary} />
      <Text style={[styles.title, { color: theme.colors.text }]}>Can't preview this file</Text>
      <Text style={[styles.name, { color: theme.colors.textSecondary }]} numberOfLines={2}>
        {fileName}
      </Text>
      <Pressable
        testID="file-viewer-download"
        onPress={() => downloadUrl && onDownload(downloadUrl)}
        disabled={!downloadUrl}
        accessibilityRole="button"
        style={[
          styles.button,
          { backgroundColor: theme.colors.primary, opacity: downloadUrl ? 1 : 0.6 },
        ]}
      >
        <Icon name="download" size={16} color={theme.colors.background} />
        <Text style={[styles.buttonText, { color: theme.colors.background }]}>Download file</Text>
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  title: { fontSize: 16, fontWeight: '600' },
  name: { fontSize: 14, textAlign: 'center', fontFamily: 'monospace' },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  buttonText: { fontSize: 14, fontWeight: '600' },
});
