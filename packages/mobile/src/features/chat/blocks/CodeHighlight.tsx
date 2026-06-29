/**
 * CodeHighlight — native syntax highlighter.
 *
 * RN has no DOM, so rather than pull a webview-based highlighter we tokenize the
 * source into colored `<Text>` spans (comments, strings, numbers, keywords,
 * punctuation) inside a scrollable monospace block. This keeps the dependency
 * surface native-only and renders deterministically under jest-expo.
 *
 * It is intentionally lightweight (a lexer, not a full grammar): enough to make
 * code legible and visibly "highlighted", with a shared keyword set across the
 * common languages `detectLanguage` emits. testID `code-highlight`.
 */

import { memo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../../theme';

export interface CodeHighlightProps {
  code: string;
  language?: string;
  testID?: string;
  /**
   * Render a left line-number gutter (one row per source line). Opt-in (default
   * `false`): chat tool blocks keep the original flowing single-`<Text>` render,
   * the file viewer's "line numbers" toggle (US-1410) turns it on.
   */
  showLineNumbers?: boolean;
}

/** Keywords highlighted across the languages we render (superset; harmless overlap). */
const KEYWORDS = new Set([
  // JS / TS
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'new',
  'class',
  'extends',
  'super',
  'this',
  'import',
  'export',
  'from',
  'default',
  'async',
  'await',
  'try',
  'catch',
  'finally',
  'throw',
  'typeof',
  'instanceof',
  'in',
  'of',
  'yield',
  'void',
  'delete',
  'interface',
  'type',
  'enum',
  'public',
  'private',
  'protected',
  'readonly',
  'static',
  'implements',
  // Python / Ruby / others
  'def',
  'elif',
  'lambda',
  'pass',
  'with',
  'as',
  'and',
  'or',
  'not',
  'None',
  'True',
  'False',
  'self',
  'end',
  'then',
  'nil',
  'fn',
  'let',
  'mut',
  'struct',
  'impl',
  'pub',
  'func',
  'package',
  'true',
  'false',
  'null',
  'undefined',
  // Shell
  'echo',
  'cd',
  'export',
  'sudo',
  'fi',
  'esac',
]);

type TokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'plain';

interface Token {
  text: string;
  kind: TokenKind;
}

/** Tokenize a single logical run of source into highlight tokens. */
function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  // Order matters: comments/strings consume first, then numbers, then words.
  const pattern =
    /(#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\s\w])/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    const [, comment, str, num, word, space, punct] = match;
    if (comment !== undefined) tokens.push({ text: comment, kind: 'comment' });
    else if (str !== undefined) tokens.push({ text: str, kind: 'string' });
    else if (num !== undefined) tokens.push({ text: num, kind: 'number' });
    else if (word !== undefined)
      tokens.push({ text: word, kind: KEYWORDS.has(word) ? 'keyword' : 'plain' });
    else if (space !== undefined) tokens.push({ text: space, kind: 'plain' });
    else if (punct !== undefined) tokens.push({ text: punct, kind: 'plain' });
  }
  return tokens;
}

// Two token palettes, picked by theme brightness — oneLight / oneDark Prism
// themes (light syntax on light, dark on dark).
const DARK_TOKENS: Record<TokenKind, string> = {
  comment: '#64748b',
  string: '#86efac',
  number: '#fbbf24',
  keyword: '#93c5fd',
  plain: '#e2e8f0',
};
const LIGHT_TOKENS: Record<TokenKind, string> = {
  comment: '#6a737d',
  string: '#22863a',
  number: '#005cc5',
  keyword: '#d73a49',
  plain: '#24292e',
};

export const CodeHighlight = memo(function CodeHighlight({
  code,
  language = 'text',
  testID = 'code-highlight',
  showLineNumbers = false,
}: CodeHighlightProps) {
  const { theme } = useAppTheme();
  const palette = theme.colors.isLight ? LIGHT_TOKENS : DARK_TOKENS;
  const mono = theme.typography.fontFamilyMono;

  function renderTokens(tokens: Token[]) {
    return tokens.map((tok, i) => (
      <Text key={i} style={[{ color: palette[tok.kind] }, tok.kind === 'comment' && styles.italic]}>
        {tok.text}
      </Text>
    ));
  }

  // Line-number gutter variant (US-1410): the gutter stays pinned while only the
  // code column scrolls horizontally. Each line is one non-wrapping row at a fixed
  // line height so the numbers stay aligned with their source lines.
  if (showLineNumbers) {
    const lines = code.split('\n');
    return (
      <View
        style={[
          styles.numberedContainer,
          { backgroundColor: theme.colors.backgroundElevated, borderColor: theme.colors.border },
        ]}
      >
        <View style={[styles.gutter, { borderRightColor: theme.colors.border }]}>
          {lines.map((_, i) => (
            <Text
              key={i}
              style={[styles.gutterText, { color: theme.colors.textTertiary, fontFamily: mono }]}
            >
              {i + 1}
            </Text>
          ))}
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.codeColumn}
          contentContainerStyle={styles.codeContent}
        >
          <View testID={testID} accessibilityLabel={`code-${language}`}>
            {lines.map((line, i) => (
              <Text
                key={i}
                style={[styles.codeLine, { fontFamily: mono }]}
                numberOfLines={1}
                selectable
              >
                {renderTokens(tokenize(line))}
              </Text>
            ))}
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[
        styles.container,
        { backgroundColor: theme.colors.backgroundElevated, borderColor: theme.colors.border },
      ]}
    >
      <View testID={testID} accessibilityLabel={`code-${language}`}>
        <Text style={[styles.code, { fontFamily: mono }]} selectable>
          {renderTokens(tokenize(code))}
        </Text>
      </View>
    </ScrollView>
  );
});

const CODE_LINE_HEIGHT = 18;

const styles = StyleSheet.create({
  container: { borderRadius: 8, borderWidth: 1, padding: 10 },
  code: { fontSize: 12 },
  italic: { fontStyle: 'italic' },
  numberedContainer: {
    flexDirection: 'row',
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  gutter: {
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  gutterText: {
    fontSize: 12,
    lineHeight: CODE_LINE_HEIGHT,
    textAlign: 'right',
    opacity: 0.7,
  },
  codeColumn: { flex: 1 },
  codeContent: { paddingVertical: 10 },
  codeLine: {
    fontSize: 12,
    lineHeight: CODE_LINE_HEIGHT,
    paddingVertical: 0,
    paddingHorizontal: 10,
  },
});
