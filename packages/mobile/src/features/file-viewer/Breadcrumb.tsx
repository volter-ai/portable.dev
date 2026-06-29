/**
 * Breadcrumb — file-path breadcrumb for the native file viewer.
 *
 * Renders `repo / dir / dir / file`. The
 * repo + each directory segment is a tappable button that navigates back to the
 * repo at that directory (the last segment, the current file, is plain text).
 * Navigation is injected (`onNavigate`) so the screen is testable without a router
 * context.
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../theme';
import { Icon } from '../../theme/icons/Icon';
import { copyToClipboard } from './clipboard';

export interface BreadcrumbProps {
  repo: string;
  /** The full file path within the repo (e.g. `src/utils/file.ts`). */
  filePath: string;
  /** Navigate to the repo at a directory path (`''` = repo root). */
  onNavigate?: (dirPath: string) => void;
  /** Clipboard writer for the copy-path action — injectable for tests. */
  onCopy?: (text: string) => void | Promise<void>;
}

export const Breadcrumb = memo(function Breadcrumb({
  repo,
  filePath,
  onNavigate,
  onCopy = copyToClipboard,
}: BreadcrumbProps) {
  const { theme } = useAppTheme();
  const segments = useMemo(() => filePath.split('/').filter(Boolean), [filePath]);
  const [copied, setCopied] = useState(false);

  // Reset the "copied" checkmark after 1.5s, cleaned up on unmount.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function handleCopy() {
    await onCopy(filePath);
    setCopied(true);
  }

  return (
    <View
      style={[
        styles.bar,
        { borderBottomColor: theme.colors.borderLight, backgroundColor: theme.colors.background },
      ]}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        testID="file-breadcrumb"
      >
        <Pressable testID="breadcrumb-repo" onPress={() => onNavigate?.('')} hitSlop={6}>
          <Text style={[styles.link, { color: theme.colors.link }]}>{repo}</Text>
        </Pressable>
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          const dirPath = segments.slice(0, index + 1).join('/');
          return (
            <View key={`${segment}-${index}`} style={styles.segment}>
              <Text style={[styles.separator, { color: theme.colors.textTertiary }]}>/</Text>
              {isLast ? (
                <Text
                  style={[styles.current, { color: theme.colors.text }]}
                  testID={`breadcrumb-segment-${index}`}
                >
                  {segment}
                </Text>
              ) : (
                <Pressable
                  testID={`breadcrumb-segment-${index}`}
                  onPress={() => onNavigate?.(dirPath)}
                  hitSlop={6}
                >
                  <Text style={[styles.link, { color: theme.colors.link }]}>{segment}</Text>
                </Pressable>
              )}
            </View>
          );
        })}
      </ScrollView>
      <Pressable
        testID="breadcrumb-copy"
        onPress={handleCopy}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Copy file path"
        style={styles.copyButton}
      >
        <Icon
          name={copied ? 'check' : 'copy'}
          size={16}
          color={copied ? theme.colors.success : theme.colors.textSecondary}
        />
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  scroll: { flex: 1 },
  content: { alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8 },
  segment: { flexDirection: 'row', alignItems: 'center' },
  separator: { marginHorizontal: 4, fontFamily: 'monospace' },
  link: { fontFamily: 'monospace', fontSize: 13 },
  current: { fontFamily: 'monospace', fontSize: 13, fontWeight: '600' },
  copyButton: { paddingHorizontal: 12, paddingVertical: 8 },
});
