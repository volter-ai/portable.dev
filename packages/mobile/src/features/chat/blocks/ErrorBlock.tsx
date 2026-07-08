/**
 * ErrorBlock — native error block.
 *
 * Renders a `claude:error` inline error block (`block.type === 'error'`, the
 * `errorBlock` payload of `claude:error`). Fields — `title`,
 * `message`, `action`, `code`, and a collapsible `details` section — with the
 * FontAwesome icon replaced by a text glyph (FontAwesome is not bundled). NEVER
 * dumps raw JSON.
 *
 * testIDs: `block-error`, `block-error-toggle` / `block-error-details` (when
 * `details` present), `block-error-signin` (dead-credential CTA,
 * portable.dev#18: `code === 'ai_credential_invalid'` → a "Sign in with
 * Claude" button that opens Settings → Claude Account).
 */

import { AI_CREDENTIAL_INVALID_CODE } from '@vgit2/shared/types';
import { router } from 'expo-router';
import { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

import { useAppTheme, withAlpha } from '../../../theme';
import { CLAUDE_ACCOUNT_ROUTE } from '../composer/clientSlashCommands';

export interface ErrorBlockProps {
  block: ClaudeStreamBlock;
}

function str(block: ClaudeStreamBlock, key: string, fallback = ''): string {
  const v = block[key];
  return typeof v === 'string' ? v : fallback;
}

export const ErrorBlock = memo(function ErrorBlock({ block }: ErrorBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const { theme } = useAppTheme();
  const title = str(block, 'title', 'Error');
  const message = str(block, 'message', 'An unexpected error occurred');
  const action = str(block, 'action');
  const code = str(block, 'code');
  const details = str(block, 'details');

  const Header = details ? Pressable : View;
  return (
    <View testID="block-error" style={styles.wrapper}>
      <Header
        testID={details ? 'block-error-toggle' : undefined}
        accessibilityRole={details ? 'button' : undefined}
        style={[styles.header, { backgroundColor: withAlpha(theme.colors.error, '22') }]}
        onPress={details ? () => setExpanded((v) => !v) : undefined}
      >
        <Text style={styles.glyph}>⚠️</Text>
        <View style={styles.textCol}>
          <Text style={[styles.title, { color: theme.colors.text }]}>{title}</Text>
          <Text style={[styles.message, { color: theme.colors.textSecondary }]}>{message}</Text>
        </View>
        {code ? (
          <Text
            style={[
              styles.code,
              {
                fontFamily: theme.typography.fontFamilyMono,
                color: theme.colors.textSecondary,
                backgroundColor: theme.colors.backgroundElevated,
              },
            ]}
          >
            {code}
          </Text>
        ) : null}
        {details ? (
          <Text style={[styles.chevron, { color: theme.colors.textTertiary }]}>
            {expanded ? '▾' : '▸'}
          </Text>
        ) : null}
      </Header>
      {action ? (
        <Text style={[styles.action, { color: theme.colors.primary }]}>💡 {action}</Text>
      ) : null}
      {code === AI_CREDENTIAL_INVALID_CODE ? (
        <Pressable
          testID="block-error-signin"
          accessibilityRole="button"
          onPress={() => router.push(CLAUDE_ACCOUNT_ROUTE)}
          style={[styles.signInButton, { backgroundColor: theme.colors.primary }]}
        >
          <Text style={[styles.signInLabel, { color: theme.colors.textInverse }]}>
            Sign in with Claude
          </Text>
        </Pressable>
      ) : null}
      {expanded && details ? (
        <View
          testID="block-error-details"
          style={[styles.detailsBox, { backgroundColor: theme.colors.backgroundElevated }]}
        >
          <Text
            style={[
              styles.detailsText,
              { fontFamily: theme.typography.fontFamilyMono, color: theme.colors.textSecondary },
            ]}
          >
            {details}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: { marginBottom: 6 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 8,
    borderRadius: 6,
  },
  glyph: { fontSize: 14, paddingTop: 1 },
  textCol: { flex: 1, gap: 2 },
  title: { fontWeight: '600', fontSize: 14 },
  message: { fontSize: 13, lineHeight: 18 },
  code: {
    fontSize: 10,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  chevron: { paddingTop: 2 },
  action: { paddingLeft: 24, paddingTop: 4, fontSize: 12, lineHeight: 18 },
  signInButton: {
    alignSelf: 'flex-start',
    borderRadius: 6,
    marginLeft: 24,
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  signInLabel: { fontSize: 13, fontWeight: '600' },
  detailsBox: {
    marginTop: 6,
    marginLeft: 24,
    borderRadius: 4,
    padding: 8,
  },
  detailsText: { fontSize: 12 },
});
