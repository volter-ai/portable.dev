/**
 * Theme-driven styles for `react-native-markdown-display`, matching the
 * assistant Markdown look: inline code on a soft surface, code
 * fences on the elevated background, accent blockquotes, accent links, system body
 * sizing (13px / 1.5). Pass `createMarkdownStyles(theme)` to `<Markdown style={…}>`.
 */

import { lh, type Theme } from './theme';

export function createMarkdownStyles(theme: Theme) {
  const { colors, typography } = theme;
  const code = {
    fontFamily: typography.fontFamilyMono,
    fontSize: 12,
    color: colors.text,
  };

  return {
    body: {
      color: colors.text,
      fontSize: 13,
      lineHeight: lh(13, typography.lineHeights.normal),
    },
    paragraph: {
      marginTop: 8,
      marginBottom: 8,
    },
    text: { color: colors.text },
    strong: { fontWeight: typography.weights.bold },
    em: { fontStyle: 'italic' as const },

    link: {
      color: colors.info,
      textDecorationLine: 'underline' as const,
    },

    code_inline: {
      ...code,
      backgroundColor: colors.hover,
      borderRadius: 4,
      paddingHorizontal: 4,
    },
    fence: {
      ...code,
      backgroundColor: colors.backgroundElevated,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      padding: 12,
    },
    code_block: {
      ...code,
      backgroundColor: colors.backgroundElevated,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      padding: 12,
    },

    blockquote: {
      backgroundColor: colors.hover,
      borderLeftWidth: 3,
      borderLeftColor: colors.border,
      paddingHorizontal: 12,
      paddingVertical: 4,
      marginVertical: 8,
    },

    heading1: {
      fontSize: typography.sizes.xl,
      fontWeight: typography.weights.bold,
      color: colors.text,
      marginTop: 16,
      marginBottom: 8,
    },
    heading2: {
      fontSize: typography.sizes.lg,
      fontWeight: typography.weights.bold,
      color: colors.text,
      marginTop: 12,
      marginBottom: 8,
    },
    heading3: {
      fontSize: typography.sizes.base,
      fontWeight: typography.weights.semibold,
      color: colors.text,
      marginTop: 8,
      marginBottom: 4,
    },
    heading4: {
      fontSize: typography.sizes.sm,
      fontWeight: typography.weights.semibold,
      color: colors.text,
      marginTop: 8,
      marginBottom: 4,
    },

    bullet_list: { marginVertical: 4 },
    ordered_list: { marginVertical: 4 },
    list_item: { marginVertical: 2 },

    hr: { backgroundColor: colors.border, height: 1, marginVertical: 8 },

    table: { borderWidth: 1, borderColor: colors.border, borderRadius: 6 },
    th: { padding: 6, backgroundColor: colors.surfaceHover },
    td: { padding: 6, borderColor: colors.borderLight },
  };
}
