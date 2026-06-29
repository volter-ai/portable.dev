/**
 * CodeViewer — native code/text file viewer.
 *
 * Reuses the chat blocks' self-contained native syntax highlighter
 * (`CodeHighlight` — a lexer → colored `<Text>` spans, no webview / no
 * RN-syntax-highlighter dep), so a code file in the repo browser highlights the
 * same way a `Read`/`Write` tool block does. Read-only on mobile v1. Imports the
 * highlighter FILE directly (not the chat barrel) to avoid pulling expo-audio /
 * socket into the module graph.
 *
 * A small metadata toolbar sits above the code: the file's line count, a
 * copy-to-clipboard button for the raw content, and a line-number toggle (numbers
 * on/off). A "last modified" timestamp is intentionally OMITTED — there is
 * no cheap git-blame API on mobile and graceful omission is acceptable.
 */

import { memo, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../../theme';
import { Icon } from '../../../theme/icons/Icon';
import { CodeHighlight } from '../../chat/blocks/CodeHighlight';
import { copyToClipboard } from '../clipboard';

export interface CodeViewerProps {
  content: string;
  language?: string;
  /** Clipboard writer — injectable so tests never load the native module. */
  onCopy?: (text: string) => void | Promise<void>;
}

export const CodeViewer = memo(function CodeViewer({
  content,
  language,
  onCopy = copyToClipboard,
}: CodeViewerProps) {
  const { theme } = useAppTheme();
  const [showLineNumbers, setShowLineNumbers] = useState(false);
  const [copied, setCopied] = useState(false);

  const lineCount = content === '' ? 0 : content.split('\n').length;

  // Reset the "copied" checkmark after 1.5s, cleaned up on unmount (no stale
  // setState on an unmounted component during rapid navigation).
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function handleCopy() {
    await onCopy(content);
    setCopied(true);
  }

  return (
    <View
      style={[styles.container, { backgroundColor: theme.colors.surface }]}
      testID="file-viewer-code"
    >
      <View style={[styles.toolbar, { borderBottomColor: theme.colors.borderLight }]}>
        <Text
          style={[styles.meta, { color: theme.colors.textSecondary }]}
          testID="code-viewer-line-count"
        >
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
        </Text>
        <View style={styles.actions}>
          <Pressable
            testID="code-viewer-toggle-lines"
            onPress={() => setShowLineNumbers((v) => !v)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityState={{ selected: showLineNumbers }}
            style={[
              styles.iconButton,
              showLineNumbers && { backgroundColor: theme.colors.primary + '20' },
            ]}
          >
            <Icon
              name="list"
              size={16}
              color={showLineNumbers ? theme.colors.primary : theme.colors.textSecondary}
            />
          </Pressable>
          <Pressable
            testID="code-viewer-copy"
            onPress={handleCopy}
            hitSlop={8}
            accessibilityRole="button"
            style={styles.iconButton}
          >
            {copied ? (
              <Icon name="check" size={16} color={theme.colors.success} />
            ) : (
              <Icon name="copy" size={16} color={theme.colors.textSecondary} />
            )}
          </Pressable>
        </View>
      </View>
      <ScrollView style={styles.body}>
        <CodeHighlight
          code={content}
          language={language}
          testID="code-highlight"
          showLineNumbers={showLineNumbers}
        />
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  meta: { fontSize: 12, fontWeight: '600' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  iconButton: { padding: 6, borderRadius: 6 },
  body: { flex: 1 },
});
