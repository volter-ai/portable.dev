/**
 * GitHub block renderers — the GitHub entity set the PRD §7 enumeration calls for
 * (issue, PR, branch, workflow-run, commit, comment, repo).
 *
 * Renders GitHub references as presentational cards from the data carried on the
 * block (the streamed block already holds the repo / number / title / state),
 * tapping opens the GitHub URL via `Linking`. Every renderer dispatches to a real
 * native component — NONE falls back to the raw-JSON `FallbackBlock` (the AC's
 * anti-requirement). Repo-viewer navigation is the Repositories epic; here the
 * blocks render natively.
 *
 * testIDs: `block-github-{issue,pr,branch,workflow-run,commit,comment,repo}`.
 */

import { memo, type ComponentType, type ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

import { useAppTheme, withAlpha } from '../../../theme';

type BadgeTone = 'open' | 'closed' | 'merged' | 'success' | 'failure' | 'neutral';

/**
 * Resolve a badge tone to its themed { bg, fg } pair. Open/success → success;
 * closed/failure → error; merged → an accent (purple-ish) tint; neutral → the
 * muted surface-hover fill with secondary text.
 */
function toneColors(
  tone: BadgeTone,
  theme: ReturnType<typeof useAppTheme>['theme']
): { backgroundColor: string; color: string } {
  switch (tone) {
    case 'open':
    case 'success':
      return {
        backgroundColor: withAlpha(theme.colors.success, '22'),
        color: theme.colors.success,
      };
    case 'closed':
    case 'failure':
      return { backgroundColor: withAlpha(theme.colors.error, '22'), color: theme.colors.error };
    case 'merged':
      return { backgroundColor: theme.colors.accentSoft, color: theme.colors.link };
    case 'neutral':
    default:
      return { backgroundColor: theme.colors.surfaceHover, color: theme.colors.textSecondary };
  }
}

export interface GitHubBlockProps {
  block: ClaudeStreamBlock;
}

/** Loosely-typed read of the block's fields (top-level first, then `toolInput`). */
function field(block: ClaudeStreamBlock, key: string): unknown {
  if (block[key] != null) return block[key];
  const input = block.toolInput;
  if (input && typeof input === 'object') return (input as Record<string, unknown>)[key];
  return undefined;
}

function str(block: ClaudeStreamBlock, key: string): string {
  const v = field(block, key);
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function num(block: ClaudeStreamBlock, key: string): string {
  const v = field(block, key);
  return v == null ? '' : String(v);
}

function openUrl(url: string) {
  if (!url) return;
  void Linking.openURL(url).catch(() => {});
}

/**
 * Shared GitHub card chrome: a glyph + a repo·identifier line, an optional title,
 * an optional state/status badge, and tap-to-open when a URL is present.
 */
function GitHubCard({
  testID,
  glyph,
  line,
  title,
  badge,
  badgeTone = 'neutral',
  url,
  children,
}: {
  testID: string;
  glyph: string;
  line: string;
  title?: string;
  badge?: string;
  badgeTone?: BadgeTone;
  url?: string;
  children?: ReactNode;
}) {
  const { theme } = useAppTheme();
  const Wrapper = url ? Pressable : View;
  const badgeColors = toneColors(badgeTone, theme);
  return (
    <Wrapper
      testID={testID}
      accessibilityRole={url ? 'link' : undefined}
      style={[
        styles.card,
        {
          borderColor: theme.tool.github.icon,
          backgroundColor: theme.colors.backgroundElevated,
        },
      ]}
      onPress={url ? () => openUrl(url) : undefined}
    >
      <View style={styles.headerRow}>
        <Text style={styles.glyph}>{glyph}</Text>
        <Text style={[styles.line, { color: theme.colors.textSecondary }]} numberOfLines={1}>
          {line}
        </Text>
        {badge ? (
          <Text
            style={[
              styles.badge,
              { backgroundColor: badgeColors.backgroundColor, color: badgeColors.color },
            ]}
            numberOfLines={1}
          >
            {badge}
          </Text>
        ) : null}
      </View>
      {title ? (
        <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={2}>
          {title}
        </Text>
      ) : null}
      {children}
    </Wrapper>
  );
}

function repoLabel(block: ClaudeStreamBlock): string {
  return str(block, 'repo') || str(block, 'repository') || str(block, 'full_name');
}

function htmlUrl(block: ClaudeStreamBlock): string {
  return str(block, 'html_url') || str(block, 'url');
}

function stateTone(state: string): 'open' | 'closed' | 'merged' | 'neutral' {
  const s = state.toLowerCase();
  if (s === 'open') return 'open';
  if (s === 'merged') return 'merged';
  if (s === 'closed') return 'closed';
  return 'neutral';
}

export const GitHubIssueBlock = memo(function GitHubIssueBlock({ block }: GitHubBlockProps) {
  const repo = repoLabel(block);
  const number = num(block, 'number');
  const state = str(block, 'state');
  return (
    <GitHubCard
      testID="block-github-issue"
      glyph="●"
      line={[repo, number ? `#${number}` : ''].filter(Boolean).join(' ')}
      title={str(block, 'title')}
      badge={state || undefined}
      badgeTone={stateTone(state)}
      url={htmlUrl(block)}
    />
  );
});

export const GitHubPRBlock = memo(function GitHubPRBlock({ block }: GitHubBlockProps) {
  const repo = repoLabel(block);
  const number = num(block, 'number');
  const merged = field(block, 'merged') === true;
  const state = merged ? 'merged' : str(block, 'state');
  return (
    <GitHubCard
      testID="block-github-pr"
      glyph="⑂"
      line={[repo, number ? `#${number}` : ''].filter(Boolean).join(' ')}
      title={str(block, 'title')}
      badge={state || undefined}
      badgeTone={stateTone(state)}
      url={htmlUrl(block)}
    />
  );
});

export const GitHubBranchBlock = memo(function GitHubBranchBlock({ block }: GitHubBlockProps) {
  const repo = repoLabel(block);
  const branch = str(block, 'branch') || str(block, 'name') || str(block, 'ref');
  return (
    <GitHubCard
      testID="block-github-branch"
      glyph="⎇"
      line={repo}
      title={branch}
      url={htmlUrl(block)}
    />
  );
});

export const GitHubWorkflowRunBlock = memo(function GitHubWorkflowRunBlock({
  block,
}: GitHubBlockProps) {
  const repo = repoLabel(block);
  const runId = num(block, 'runId') || num(block, 'run_id') || num(block, 'id');
  const conclusion = str(block, 'conclusion');
  const status = str(block, 'status');
  const label = conclusion || status;
  const tone: 'success' | 'failure' | 'neutral' =
    conclusion.toLowerCase() === 'success'
      ? 'success'
      : conclusion.toLowerCase() === 'failure'
        ? 'failure'
        : 'neutral';
  return (
    <GitHubCard
      testID="block-github-workflow-run"
      glyph="⚙"
      line={[repo, runId ? `run ${runId}` : ''].filter(Boolean).join(' ')}
      title={str(block, 'name') || str(block, 'workflow') || str(block, 'title')}
      badge={label || undefined}
      badgeTone={tone}
      url={htmlUrl(block)}
    />
  );
});

export const GitHubCommitBlock = memo(function GitHubCommitBlock({ block }: GitHubBlockProps) {
  const repo = repoLabel(block);
  const sha = str(block, 'sha') || str(block, 'oid');
  const shortSha = sha ? sha.slice(0, 7) : '';
  return (
    <GitHubCard
      testID="block-github-commit"
      glyph="◆"
      line={[repo, shortSha].filter(Boolean).join(' ')}
      title={str(block, 'message') || str(block, 'title')}
      url={htmlUrl(block)}
    />
  );
});

export const GitHubCommentBlock = memo(function GitHubCommentBlock({ block }: GitHubBlockProps) {
  const { theme } = useAppTheme();
  const repo = repoLabel(block);
  const author = str(block, 'author') || str(block, 'user') || str(block, 'login');
  const body = str(block, 'body') || str(block, 'message');
  return (
    <GitHubCard
      testID="block-github-comment"
      glyph="💬"
      line={[repo, author ? `@${author}` : ''].filter(Boolean).join(' ')}
      url={htmlUrl(block)}
    >
      {body ? (
        <Text style={[styles.body, { color: theme.colors.textSecondary }]} numberOfLines={4}>
          {body}
        </Text>
      ) : null}
    </GitHubCard>
  );
});

export const GitHubRepoBlock = memo(function GitHubRepoBlock({ block }: GitHubBlockProps) {
  const repo = repoLabel(block);
  return (
    <GitHubCard
      testID="block-github-repo"
      glyph="📦"
      line={repo}
      title={str(block, 'description')}
      url={htmlUrl(block)}
    />
  );
});

/**
 * `block.type` → native GitHub renderer. Keyed on the GitHub entity type carried
 * by the streamed block; aliases map the common synonyms (`github_pr` /
 * `github_pull_request`, `github_workflow` / `github_workflow_run`, …) the backend
 * may emit. Returns `undefined` when the type is not a GitHub entity.
 */
const GITHUB_RENDERERS: Record<string, ComponentType<GitHubBlockProps>> = {
  github_issue: GitHubIssueBlock,
  github_pr: GitHubPRBlock,
  github_pull_request: GitHubPRBlock,
  github_branch: GitHubBranchBlock,
  github_workflow: GitHubWorkflowRunBlock,
  github_workflow_run: GitHubWorkflowRunBlock,
  github_commit: GitHubCommitBlock,
  github_comment: GitHubCommentBlock,
  github_repo: GitHubRepoBlock,
  github_repository: GitHubRepoBlock,
};

export function resolveGitHubRenderer(type: string): ComponentType<GitHubBlockProps> | undefined {
  return GITHUB_RENDERERS[type];
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 10,
    marginBottom: 6,
    gap: 4,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  glyph: { fontSize: 14 },
  line: { flex: 1, fontSize: 12, fontWeight: '600' },
  title: { fontSize: 14, fontWeight: '500' },
  body: { fontSize: 13 },
  badge: {
    fontSize: 11,
    fontWeight: '600',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 1,
    overflow: 'hidden',
    textTransform: 'capitalize',
  },
});
