/**
 * AskUserQuestionBlock — native interactive question form.
 *
 * Renders the MCP
 * `ask_user` tool's multiple-choice questions (radio for single-select, checkbox
 * for `multiSelect`) plus an "Other" free-text option, validates that every
 * question is answered, and emits the answers via `onAnswer` (the provider wires
 * it to `answer_user_question`). Building the final answers mirrors the web:
 * a selected "Other" is replaced with `Other: <custom text>`.
 *
 * Presentational + self-contained (no socket import) so it unit-tests trivially;
 * the prompt source + emit are owned by `ActiveChatInteractions` / the provider.
 *
 * testIDs: `ask-user-question`, `ask-question-<i>`, `ask-option-<i>-<label>`,
 * `ask-other-input-<i>`, `ask-question-submit`, `ask-question-submitted`,
 * `ask-question-error`.
 */

import type { AskUserQuestion } from '@vgit2/shared/types';
import { memo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAppTheme, withAlpha } from '../../../theme';

const OTHER = 'Other';

export interface AskUserQuestionBlockProps {
  questions: AskUserQuestion[];
  requestId: string;
  /** Submit the validated answers (question index as string → selected labels). */
  onAnswer: (answers: Record<string, string[]>) => void;
  /**
   * Called when an "Other" free-text input gains focus, with the input's native
   * node. The prompt renders inside the transcript scroller (issue #10), so
   * keyboard avoidance is a SCROLL concern: the owner scrolls the node into the
   * list's visible window above the keyboard.
   */
  onOtherInputFocus?: (input: TextInput | null) => void;
}

export const AskUserQuestionBlock = memo(function AskUserQuestionBlock({
  questions,
  onAnswer,
  onOtherInputFocus,
}: AskUserQuestionBlockProps) {
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-question "Other" input nodes, keyed like `selections` — handed to
  // `onOtherInputFocus` so the transcript list can measure + scroll to the one
  // that gained focus.
  const otherInputRefs = useRef<Record<string, TextInput | null>>({});
  const { theme } = useAppTheme();

  const wrapperStyle = [
    styles.wrapper,
    { backgroundColor: theme.colors.surface, borderColor: theme.colors.primary },
  ];

  const valid = questions.filter(
    (q) =>
      q &&
      typeof q.question === 'string' &&
      Array.isArray(q.options) &&
      q.options.length >= 2 &&
      typeof q.multiSelect === 'boolean'
  );
  if (valid.length === 0) return null;

  const toggle = (key: string, label: string, multiSelect: boolean) => {
    setError(null);
    setSelections((prev) => {
      const current = prev[key] ?? [];
      if (multiSelect) {
        const next = current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label];
        return { ...prev, [key]: next };
      }
      return { ...prev, [key]: [label] };
    });
  };

  const submit = () => {
    const finalAnswers: Record<string, string[]> = {};
    for (let i = 0; i < valid.length; i++) {
      const key = String(i);
      const selected = selections[key] ?? [];
      const custom = customTexts[key];
      finalAnswers[key] =
        selected.includes(OTHER) && custom?.trim()
          ? selected.map((l) => (l === OTHER ? `${OTHER}: ${custom.trim()}` : l))
          : selected;
    }
    const unanswered = valid.findIndex((_, i) => (finalAnswers[String(i)] ?? []).length === 0);
    if (unanswered !== -1) {
      setError(`Please answer question ${unanswered + 1}`);
      return;
    }
    setSubmitted(true);
    onAnswer(finalAnswers);
  };

  if (submitted) {
    return (
      <View testID="ask-user-question" style={wrapperStyle}>
        <View testID="ask-question-submitted" style={styles.submittedRow}>
          <Text style={[styles.submittedGlyph, { color: theme.colors.success }]}>✓</Text>
          <Text style={[styles.submittedText, { color: theme.colors.success }]}>
            Answers submitted
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View testID="ask-user-question" style={wrapperStyle}>
      <View style={styles.header}>
        <Text style={styles.glyph}>❓</Text>
        <Text style={[styles.title, { color: theme.colors.primary }]}>
          The agent needs your input
        </Text>
      </View>
      {valid.map((q, i) => {
        const key = String(i);
        const selected = selections[key] ?? [];
        const otherSelected = selected.includes(OTHER);
        return (
          <View key={key} testID={`ask-question-${i}`} style={styles.question}>
            <Text style={[styles.questionText, { color: theme.colors.text }]}>{q.question}</Text>
            {q.options.map((opt) => {
              const isSel = selected.includes(opt.label);
              return (
                <Pressable
                  key={opt.label}
                  testID={`ask-option-${i}-${opt.label}`}
                  accessibilityRole="button"
                  style={[
                    styles.option,
                    { backgroundColor: theme.colors.surface },
                    isSel && { backgroundColor: withAlpha(theme.colors.primary, '15') },
                  ]}
                  onPress={() => toggle(key, opt.label, q.multiSelect)}
                >
                  <Text style={[styles.optionMark, { color: theme.colors.primary }]}>
                    {q.multiSelect ? (isSel ? '☑' : '☐') : isSel ? '◉' : '○'}
                  </Text>
                  <View style={styles.optionBody}>
                    <Text style={[styles.optionLabel, { color: theme.colors.text }]}>
                      {opt.label}
                    </Text>
                    {opt.description ? (
                      <Text style={[styles.optionDesc, { color: theme.colors.textSecondary }]}>
                        {opt.description}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
            <Pressable
              testID={`ask-option-${i}-${OTHER}`}
              accessibilityRole="button"
              style={[
                styles.option,
                { backgroundColor: theme.colors.surface },
                otherSelected && { backgroundColor: withAlpha(theme.colors.primary, '15') },
              ]}
              onPress={() => toggle(key, OTHER, q.multiSelect)}
            >
              <Text style={[styles.optionMark, { color: theme.colors.primary }]}>
                {q.multiSelect ? (otherSelected ? '☑' : '☐') : otherSelected ? '◉' : '○'}
              </Text>
              <Text style={[styles.optionLabel, { color: theme.colors.text }]}>Other</Text>
            </Pressable>
            {otherSelected ? (
              <TextInput
                ref={(r) => {
                  otherInputRefs.current[key] = r;
                }}
                testID={`ask-other-input-${i}`}
                style={[
                  styles.otherInput,
                  {
                    backgroundColor: theme.colors.surface,
                    borderColor: theme.colors.border,
                    color: theme.colors.text,
                  },
                ]}
                placeholder="Type your answer…"
                placeholderTextColor={theme.colors.textTertiary}
                value={customTexts[key] ?? ''}
                onChangeText={(t) => setCustomTexts((prev) => ({ ...prev, [key]: t }))}
                onFocus={() => onOtherInputFocus?.(otherInputRefs.current[key])}
              />
            ) : null}
          </View>
        );
      })}
      {error ? (
        <Text testID="ask-question-error" style={[styles.error, { color: theme.colors.error }]}>
          {error}
        </Text>
      ) : null}
      <Pressable
        testID="ask-question-submit"
        accessibilityRole="button"
        style={[styles.submit, { backgroundColor: theme.colors.primary }]}
        onPress={submit}
      >
        <Text style={[styles.submitText, { color: theme.colors.textInverse }]}>Submit answers</Text>
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: {
    marginVertical: 6,
    padding: 12,
    borderRadius: 8,
    borderWidth: 2,
    gap: 10,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  glyph: { fontSize: 14 },
  title: { fontWeight: '700', fontSize: 14 },
  question: { gap: 6 },
  questionText: { fontWeight: '600', fontSize: 13 },
  option: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  optionMark: { fontSize: 16 },
  optionBody: { flex: 1 },
  optionLabel: { fontSize: 13 },
  optionDesc: { fontSize: 12 },
  otherInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 13,
  },
  error: { fontSize: 12 },
  submit: {
    marginTop: 2,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
  },
  submitText: { fontWeight: '600', fontSize: 13 },
  submittedRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  submittedGlyph: { fontWeight: '700', fontSize: 14 },
  submittedText: { fontWeight: '600', fontSize: 13 },
});
