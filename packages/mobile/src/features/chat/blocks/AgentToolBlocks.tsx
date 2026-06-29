/**
 * Generic tool + agent-output blocks.
 *
 * - `ToolBlock`    — the CATCH-ALL renderer for any `tool_use` without a
 *                    specialised renderer (Task, MCP tools, …). Replaces the
 *                    `FallbackBlock` for tool_use blocks: a tool ALWAYS gets a
 *                    real native block (input preview + result), never raw JSON.
 * - `TodoBlock`    — `TodoWrite` checklist (status glyph + active/-form text).
 * - `ExitPlanModeBlock` — the plan (Markdown) + the 3 execution-choice buttons.
 *                    Presentational here; the permission response is wired
 *                    separately.
 * - `ActionsBlock` — message action chips (`block.actions`). Pressable, the
 *                    handler is wired separately (quick actions).
 */

import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';
import type { MessageAction } from '@vgit2/shared/types';

import { useAppTheme, withAlpha } from '../../../theme';
import { MarkdownText } from './MarkdownText';
import { ToolBlockShell } from './ToolBlockShell';
import {
  getToolResultText,
  isToolResultError,
  preview,
  toolInput,
  type ToolResult,
} from './blockHelpers';

export interface ToolBlockProps {
  block: ClaudeStreamBlock;
  result?: ToolResult;
  isRecent?: boolean;
}

/** Flatten a tool input object into a compact `k=v, k=v` preview string. */
function formatToolInput(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, v]) => {
      if (v === null || v === undefined) return `${k}=null`;
      if (typeof v === 'object') {
        try {
          return `${k}=${JSON.stringify(v)}`;
        } catch {
          return `${k}=[unserializable]`;
        }
      }
      return `${k}=${String(v)}`;
    })
    .join(', ');
}

export const ToolBlock = memo(function ToolBlock({ block, result, isRecent }: ToolBlockProps) {
  const { theme } = useAppTheme();
  const input = toolInput(block);
  const inputStr = formatToolInput(input);
  const output = getToolResultText(result?.content);
  const hasError = isToolResultError(result);

  return (
    <ToolBlockShell
      id="generic"
      label={block.toolName || 'Tool'}
      glyph="●"
      toolName={block.toolName}
      preview={preview(inputStr)}
      hasError={hasError}
      defaultExpanded={isRecent}
    >
      {inputStr ? (
        <Text
          style={[
            styles.mono,
            { color: theme.colors.textSecondary, fontFamily: theme.typography.fontFamilyMono },
          ]}
        >
          {inputStr}
        </Text>
      ) : null}
      {output ? (
        <Text
          style={[
            styles.output,
            {
              color: theme.colors.text,
              backgroundColor: theme.colors.backgroundElevated,
              fontFamily: theme.typography.fontFamilyMono,
            },
          ]}
        >
          {output}
        </Text>
      ) : null}
    </ToolBlockShell>
  );
});

interface TodoItem {
  content?: string;
  activeForm?: string;
  status?: 'pending' | 'in_progress' | 'completed' | string;
}

function todoGlyph(status?: string): string {
  if (status === 'completed') return '✓';
  if (status === 'in_progress') return '→';
  return '○';
}

export const TodoBlock = memo(function TodoBlock({ block }: ToolBlockProps) {
  const { theme } = useAppTheme();
  const input = toolInput(block);
  const todos = Array.isArray(input.todos) ? (input.todos as TodoItem[]) : [];

  return (
    <View testID="block-todo" style={styles.todoWrapper}>
      <View style={styles.todoHeader}>
        <Text style={[styles.todoDot, { color: theme.colors.success }]}>●</Text>
        <Text style={[styles.todoTitle, { color: theme.colors.text }]}>Todo</Text>
      </View>
      <View style={[styles.todoList, { borderLeftColor: theme.colors.border }]}>
        {todos.map((todo, i) => {
          const done = todo.status === 'completed';
          return (
            <View key={i} style={styles.todoRow}>
              <Text style={[styles.todoGlyph, { color: theme.colors.textSecondary }]}>
                {todoGlyph(todo.status)}
              </Text>
              <Text
                style={[
                  styles.todoText,
                  { color: theme.colors.text },
                  done && [styles.todoTextDone, { color: theme.colors.textTertiary }],
                ]}
              >
                {todo.status === 'in_progress' ? todo.activeForm : todo.content}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
});

const PLAN_CHOICES: { id: string; label: string }[] = [
  { id: 'full-control', label: 'Execute with Full Control' },
  { id: 'review', label: 'Execute and Review Edits' },
  { id: 'revise', label: 'Revise Plan' },
];

export interface ExitPlanModeBlockProps extends ToolBlockProps {
  /** Choose an execution mode. Wired separately. */
  onChoice?: (choiceId: string) => void;
}

export const ExitPlanModeBlock = memo(function ExitPlanModeBlock({
  block,
  onChoice,
}: ExitPlanModeBlockProps) {
  const { theme } = useAppTheme();
  const input = toolInput(block);
  const plan = typeof input.plan === 'string' ? input.plan : 'No plan provided';

  return (
    <View
      testID="block-exit-plan"
      style={[
        styles.planWrapper,
        {
          borderColor: withAlpha(theme.colors.primary, '40'),
          backgroundColor: withAlpha(theme.colors.primary, '14'),
        },
      ]}
    >
      <View style={styles.planHeader}>
        <Text style={styles.planGlyph}>🚀</Text>
        <Text style={[styles.planTitle, { color: theme.colors.text }]}>Ready to code?</Text>
      </View>
      <MarkdownText content={plan} testID="block-exit-plan-content" />
      <View style={styles.planButtons}>
        {PLAN_CHOICES.map((choice) => (
          <Pressable
            key={choice.id}
            testID={`block-exit-plan-${choice.id}`}
            accessibilityRole="button"
            style={[styles.planButton, { backgroundColor: theme.colors.primary }]}
            onPress={() => onChoice?.(choice.id)}
          >
            <Text style={[styles.planButtonText, { color: theme.colors.textInverse }]}>
              {choice.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
});

export interface ActionsBlockProps {
  block: ClaudeStreamBlock;
  /** Click handler. Wired separately. */
  onActionClick?: (action: MessageAction) => void;
}

export const ActionsBlock = memo(function ActionsBlock({
  block,
  onActionClick,
}: ActionsBlockProps) {
  const { theme } = useAppTheme();
  const actions = Array.isArray(block.actions) ? (block.actions as MessageAction[]) : [];
  if (actions.length === 0) return null;

  return (
    <View testID="block-actions" style={styles.actionsWrapper}>
      {actions.map((action) => (
        <Pressable
          key={action.id}
          testID={`block-action-${action.id}`}
          accessibilityRole="button"
          style={[
            styles.actionChip,
            { borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceHover },
          ]}
          onPress={() => onActionClick?.(action)}
        >
          <Text style={[styles.actionText, { color: theme.colors.text }]}>{action.label}</Text>
        </Pressable>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  mono: { fontSize: 12 },
  output: {
    fontSize: 12,
    borderRadius: 6,
    padding: 8,
  },
  todoWrapper: { marginVertical: 6 },
  todoHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  todoDot: { fontSize: 10 },
  todoTitle: { fontWeight: '600', fontSize: 14 },
  todoList: { marginLeft: 16, paddingLeft: 10, borderLeftWidth: 2 },
  todoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginBottom: 4 },
  todoGlyph: { fontSize: 13 },
  todoText: { flex: 1, fontSize: 13 },
  todoTextDone: { textDecorationLine: 'line-through' },
  planWrapper: {
    marginVertical: 6,
    padding: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  planHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  planGlyph: { fontSize: 16 },
  planTitle: { fontWeight: '700', fontSize: 15 },
  planButtons: { gap: 6 },
  planButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center',
  },
  planButtonText: { fontWeight: '600', fontSize: 13 },
  actionsWrapper: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  actionChip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  actionText: { fontSize: 12 },
});
