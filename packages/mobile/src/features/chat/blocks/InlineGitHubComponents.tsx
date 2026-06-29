/**
 * Inline GitHub component renderers for `GitHubIssue` / `GitHubPR` /
 * `GitHubWorkflow` tags.
 *
 * Parses `<GitHubIssue repo="owner/repo" number={123} />` tags
 * embedded in text blocks and renders them as clickable cards that open the
 * in-app viewer:
 *
 *   - `parseInlineComponents(content)` — splits a text string into alternating
 *     plain-text and parsed-component segments.
 *   - `InlineGitHubIssue` / `InlineGitHubPR` — presentational tappable cards;
 *     callers (i.e. `TextBlock`) own the `ViewerTarget` state and mount a single
 *     `TaskItemViewer` for all inline cards in the block (avoids N idle socket
 *     subscriptions for N inline references).
 *   - `InlineGitHubWorkflow` — tappable card that opens the run URL in the
 *     system browser (no in-app workflow viewer yet).
 *
 * Unrecognised component names leave their segment as plain text (no breakage).
 */

import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../../theme';
import type { ViewerTarget } from '../../tasks/viewer/viewerTypes';

// ─── Parser ──────────────────────────────────────────────────────────────────

/** Self-closing PascalCase JSX-like tag. */
const INLINE_TAG_RE = /<([A-Z][a-zA-Z0-9]*)\s+([^>]*?)\/>/g;

export interface TextSegment {
  kind: 'text';
  content: string;
}

export interface ComponentSegment {
  kind: 'component';
  name: string;
  props: Record<string, string | number | boolean>;
}

export type ContentSegment = TextSegment | ComponentSegment;

/** Parse a props attribute string into a plain object. */
function parseProps(propsStr: string): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};

  // key="string"
  const strPropRe = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = strPropRe.exec(propsStr)) !== null) {
    result[m[1]] = m[2];
  }

  // key={value} — number, boolean literal, or fallback string
  const exprPropRe = /(\w+)=\{([^}]+)\}/g;
  while ((m = exprPropRe.exec(propsStr)) !== null) {
    const val = m[2].trim();
    if (val === 'true') result[m[1]] = true;
    else if (val === 'false') result[m[1]] = false;
    else {
      const n = Number(val);
      result[m[1]] = Number.isNaN(n) ? val : n;
    }
  }

  // bare boolean: `compact` (no = sign); `$` handles no trailing space before `/>`
  const barePropRe = /(?:^|\s)(\w+)(?=\s|\/|$)/g;
  while ((m = barePropRe.exec(propsStr)) !== null) {
    if (!(m[1] in result)) result[m[1]] = true;
  }

  return result;
}

const KNOWN_COMPONENTS = new Set(['GitHubIssue', 'GitHubPR', 'GitHubWorkflow']);

/**
 * Split `content` into alternating text and component segments. Tags whose
 * component name is not in `KNOWN_COMPONENTS` are left as plain text.
 *
 * Returns a single `[{ kind: 'text', content }]` segment when there are no
 * inline components — callers can fast-path this case.
 */
export function parseInlineComponents(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let lastIndex = 0;

  // Must reset before each use — the regex is module-level (stateful lastIndex).
  INLINE_TAG_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = INLINE_TAG_RE.exec(content)) !== null) {
    const [fullTag, name, propsStr] = match;
    if (!KNOWN_COMPONENTS.has(name)) continue;

    if (match.index > lastIndex) {
      segments.push({ kind: 'text', content: content.slice(lastIndex, match.index) });
    }
    segments.push({ kind: 'component', name, props: parseProps(propsStr) });
    lastIndex = match.index + fullTag.length;
  }

  if (lastIndex < content.length) {
    segments.push({ kind: 'text', content: content.slice(lastIndex) });
  }

  // Degenerate: no known component found — return the whole string as text.
  if (segments.length === 0) {
    return [{ kind: 'text', content }];
  }

  return segments;
}

// ─── Shared inline card chrome ────────────────────────────────────────────────

function InlineCard({
  testID,
  glyph,
  line,
  onPress,
}: {
  testID: string;
  glyph: string;
  line: string;
  onPress: () => void;
}) {
  const { theme } = useAppTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="link"
      style={[
        styles.card,
        {
          borderColor: theme.tool.github.icon,
          backgroundColor: theme.colors.backgroundElevated,
        },
      ]}
      onPress={onPress}
    >
      <View style={styles.row}>
        <Text style={styles.glyph}>{glyph}</Text>
        <Text style={[styles.line, { color: theme.colors.textSecondary }]} numberOfLines={1}>
          {line}
        </Text>
      </View>
    </Pressable>
  );
}

// ─── Inline components ────────────────────────────────────────────────────────

export interface InlineGitHubIssueProps {
  repo: string;
  number: number;
  /**
   * Called with the derived `ViewerTarget` when the user taps. The caller
   * (`TextBlock`) owns the viewer state — this keeps the component presentational
   * and avoids N idle `TaskItemViewer` mounts per message block.
   */
  onPress: (target: ViewerTarget) => void;
}

/**
 * Renders an inline `<GitHubIssue repo="owner/repo" number={N} />` tag as a
 * tappable card. Calls `onPress` with the `ViewerTarget`; falls back to
 * `Linking.openURL` when `repo` can't be split into owner/repo.
 */
export function InlineGitHubIssue({ repo, number, onPress }: InlineGitHubIssueProps) {
  const slash = repo.indexOf('/');

  const handlePress = () => {
    if (slash > 0) {
      const owner = repo.slice(0, slash);
      const repoName = repo.slice(slash + 1);
      onPress({ kind: 'issue', owner, repo: repoName, number });
    } else {
      void Linking.openURL(`https://github.com/${repo}/issues/${number}`).catch(() => {});
    }
  };

  return (
    <InlineCard
      testID="inline-github-issue"
      glyph="●"
      line={`${repo} #${number}`}
      onPress={handlePress}
    />
  );
}

export interface InlineGitHubPRProps {
  repo: string;
  number: number;
  /** Same as `InlineGitHubIssueProps.onPress`. */
  onPress: (target: ViewerTarget) => void;
}

/**
 * Renders an inline `<GitHubPR repo="owner/repo" number={N} />` tag as a
 * tappable card. Calls `onPress` with the `ViewerTarget`.
 */
export function InlineGitHubPR({ repo, number, onPress }: InlineGitHubPRProps) {
  const slash = repo.indexOf('/');

  const handlePress = () => {
    if (slash > 0) {
      const owner = repo.slice(0, slash);
      const repoName = repo.slice(slash + 1);
      onPress({ kind: 'pull', owner, repo: repoName, number });
    } else {
      void Linking.openURL(`https://github.com/${repo}/pull/${number}`).catch(() => {});
    }
  };

  return (
    <InlineCard
      testID="inline-github-pr"
      glyph="⑂"
      line={`${repo} #${number}`}
      onPress={handlePress}
    />
  );
}

export interface InlineGitHubWorkflowProps {
  repo: string;
  runId?: number;
}

/**
 * Renders an inline `<GitHubWorkflow repo="owner/repo" runId={N} />` tag.
 * Opens the workflow run in the system browser (no in-app workflow viewer yet).
 */
export function InlineGitHubWorkflow({ repo, runId }: InlineGitHubWorkflowProps) {
  const handlePress = () => {
    const url =
      runId != null
        ? `https://github.com/${repo}/actions/runs/${runId}`
        : `https://github.com/${repo}/actions`;
    void Linking.openURL(url).catch(() => {});
  };

  return (
    <InlineCard
      testID="inline-github-workflow"
      glyph="⚙"
      line={runId != null ? `${repo} run ${runId}` : repo}
      onPress={handlePress}
    />
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginVertical: 4,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  glyph: { fontSize: 14 },
  line: { fontSize: 12, fontWeight: '600', flex: 1 },
});
