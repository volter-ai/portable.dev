/**
 * ProcessTerminal — dark monospace output panel with ANSI coloring (web
 * `RuntimeProcessDetailInstance` terminal parity). Renders the parsed
 * {@link ansiToSpans} spans into a single auto-scrolling `<Text>`.
 */

import { useRef } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';

import { ansiToSpans } from './ansiToSpans';

const TERMINAL_BG = '#1f2937';
const TERMINAL_FG = '#e5e7eb';
const TERMINAL_DIM = '#9ca3af';

export function ProcessTerminal({ output }: { output: string }) {
  const scrollRef = useRef<ScrollView>(null);
  const spans = ansiToSpans(output);

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.terminal}
      contentContainerStyle={styles.terminalContent}
      onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      testID="process-output"
    >
      <Text style={styles.mono} selectable>
        {spans.map((span, i) => (
          <Text
            key={i}
            style={{
              color: span.color ?? (span.dim ? TERMINAL_DIM : TERMINAL_FG),
              fontWeight: span.bold ? '700' : '400',
            }}
          >
            {span.text}
          </Text>
        ))}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  terminal: { backgroundColor: TERMINAL_BG, borderRadius: 10, maxHeight: 420 },
  terminalContent: { padding: 12 },
  mono: {
    fontFamily: 'Menlo',
    fontSize: 12,
    lineHeight: 18,
    color: TERMINAL_FG,
  },
});
