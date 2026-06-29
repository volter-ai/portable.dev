/**
 * TextBlock — assistant text rendered as Markdown.
 *
 * Inline `<GitHubIssue />`, `<GitHubPR />`, and
 * `<GitHubWorkflow />` tags embedded in the text are parsed and rendered as
 * tappable native cards.
 * Pure-text blocks (no inline tags) take the fast path to a single `MarkdownText`.
 *
 * A single `TaskItemViewer` is hoisted here so multiple inline cards in one block
 * share one modal mount (avoids N idle socket subscriptions per N inline cards).
 */

import { stripAutopilotStopWord } from '@vgit2/shared/utils/autopilotHelpers';
import { memo, useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';

import { stripTaskNotifications } from '../taskNotification';

import { TaskItemViewer } from '../../tasks/viewer/TaskItemViewer';
import type { ViewerTarget } from '../../tasks/viewer/viewerTypes';
import { MarkdownText } from './MarkdownText';
import {
  parseInlineComponents,
  InlineGitHubIssue,
  InlineGitHubPR,
  InlineGitHubWorkflow,
} from './InlineGitHubComponents';

export interface TextBlockProps {
  content: string;
}

export const TextBlock = memo(function TextBlock({ content }: TextBlockProps) {
  // Strip the autopilot stop word (`<promise>COMPLETE</promise>`) the agent emits to
  // signal completion AND any background-task notification blob the runtime injected —
  // neither must render in the assistant bubble (the `<task-notification>` leak).
  const cleaned = useMemo(() => stripTaskNotifications(stripAutopilotStopWord(content)), [content]);
  const segments = useMemo(() => parseInlineComponents(cleaned), [cleaned]);

  // Fast path: no inline components — single MarkdownText (unchanged behaviour).
  if (segments.length === 1 && segments[0].kind === 'text') {
    return (
      <View testID="block-text" style={styles.container}>
        <MarkdownText content={cleaned} />
      </View>
    );
  }

  return <TextBlockWithViewer segments={segments} />;
});

/**
 * Inner component that owns the viewer state. Extracted so `useState` only runs
 * when there are inline components to render (fast-path pure-text blocks avoid it).
 */
function TextBlockWithViewer({ segments }: { segments: ReturnType<typeof parseInlineComponents> }) {
  const [activeTarget, setActiveTarget] = useState<ViewerTarget | null>(null);

  return (
    <View testID="block-text" style={styles.container}>
      {segments.map((seg, i) => {
        if (seg.kind === 'text') {
          // Skip whitespace-only segments that appear between inline components.
          return seg.content.trim() ? <MarkdownText key={i} content={seg.content} /> : null;
        }

        const { name, props } = seg;
        const repo = typeof props.repo === 'string' ? props.repo : '';
        const num = typeof props.number === 'number' ? props.number : Number(props.number ?? 0);

        switch (name) {
          case 'GitHubIssue':
            return <InlineGitHubIssue key={i} repo={repo} number={num} onPress={setActiveTarget} />;
          case 'GitHubPR':
            return <InlineGitHubPR key={i} repo={repo} number={num} onPress={setActiveTarget} />;
          case 'GitHubWorkflow': {
            const runId =
              typeof props.runId === 'number'
                ? props.runId
                : props.runId != null
                  ? Number(props.runId)
                  : undefined;
            return <InlineGitHubWorkflow key={i} repo={repo} runId={runId} />;
          }
          default:
            return null;
        }
      })}
      {/* Single viewer shared by all inline issue/PR cards in this block. */}
      <TaskItemViewer
        target={activeTarget}
        onClose={() => setActiveTarget(null)}
        onOpenTarget={setActiveTarget}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: 4 },
});
