/**
 * Native chat block renderers. Barrel for the BlockRenderer
 * dispatch scaffold + the core block components. New
 * renderers are added here and to `BlockRenderer.TOOL_RENDERERS` / the type switch.
 */

export {
  BlockRenderer,
  TOOL_RENDERERS,
  resolveToolRenderer,
  BLOCK_COVERAGE,
  type BlockRendererProps,
} from './BlockRenderer';
export { renderMessageBlocks } from './renderMessageBlocks';
export { TextBlock } from './TextBlock';
export {
  parseInlineComponents,
  InlineGitHubIssue,
  InlineGitHubPR,
  InlineGitHubWorkflow,
  type ContentSegment,
  type TextSegment,
  type ComponentSegment,
  type InlineGitHubIssueProps,
  type InlineGitHubPRProps,
  type InlineGitHubWorkflowProps,
} from './InlineGitHubComponents';
export { BashBlock, BashOutputBlock, type ToolBlockProps } from './BashBlock';
export { ReadBlock, WriteBlock, EditBlock } from './FileBlocks';
export { GrepBlock, GlobBlock } from './SearchBlocks';
export { ImageBlock, VideoBlock } from './MediaBlocks';
export {
  ToolBlock,
  TodoBlock,
  ExitPlanModeBlock,
  ActionsBlock,
  type ExitPlanModeBlockProps,
  type ActionsBlockProps,
} from './AgentToolBlocks';
export { WebSearchBlock, WebFetchBlock, PlaywrightBlock, TunnelBlock } from './WebToolBlocks';
export {
  PermissionBlock,
  SecretsBlock,
  ConnectionRequestBlock,
  type PermissionBlockProps,
  type SecretsBlockProps,
  type ConnectionRequestBlockProps,
} from './InteractionBlocks';
export {
  getImageSource,
  getVideoSource,
  isInlineUri,
  resolveAuthedMediaSource,
  type AuthedMediaSource,
} from './mediaSource';
export { FallbackBlock } from './FallbackBlock';
export { ErrorBlock, type ErrorBlockProps } from './ErrorBlock';
export {
  GitHubIssueBlock,
  GitHubPRBlock,
  GitHubBranchBlock,
  GitHubWorkflowRunBlock,
  GitHubCommitBlock,
  GitHubCommentBlock,
  GitHubRepoBlock,
  resolveGitHubRenderer,
  type GitHubBlockProps,
} from './GitHubBlocks';
export { MarkdownText } from './MarkdownText';
export { CodeHighlight } from './CodeHighlight';
export { DiffHighlight } from './DiffHighlight';
export { ToolBlockShell } from './ToolBlockShell';
export {
  consolidateBlocks,
  getToolResultText,
  isToolResultError,
  detectLanguage,
  isSecretsBlock,
  isConnectionRequestBlock,
  needsPermission,
  permissionRequestId,
  type ToolResult,
  type ConsolidatedBlock,
} from './blockHelpers';
