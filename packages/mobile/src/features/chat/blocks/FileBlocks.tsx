/**
 * ReadBlock / WriteBlock / EditBlock / MultiEditBlock — file-operation blocks.
 *
 * Read/Write show the file contents
 * syntax-highlighted (language detected from the path); Edit shows a native
 * +/- diff of `old_string` → `new_string`; MultiEdit shows one diff per sub-edit
 * under a single file header. The file-icon set + in-app file-viewer navigation
 * are deferred — this covers the content rendering + diff.
 */

import { memo } from 'react';

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

import { CodeHighlight } from './CodeHighlight';
import { DiffHighlight } from './DiffHighlight';
import { ToolBlockShell } from './ToolBlockShell';
import {
  detectLanguage,
  fileName,
  getToolResultText,
  isToolResultError,
  toolInput,
  type ToolResult,
} from './blockHelpers';

interface FileBlockProps {
  block: ClaudeStreamBlock;
  result?: ToolResult;
  isRecent?: boolean;
}

export const ReadBlock = memo(function ReadBlock({ block, result, isRecent }: FileBlockProps) {
  const input = toolInput(block);
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  const name = fileName(filePath);
  const contents = getToolResultText(result?.content);
  const hasError = isToolResultError(result);

  return (
    <ToolBlockShell
      id="read"
      label="Read"
      glyph="📄"
      toolName="Read"
      preview={name}
      hasError={hasError}
      defaultExpanded={isRecent}
    >
      <CodeHighlight code={contents} language={detectLanguage(name)} />
    </ToolBlockShell>
  );
});

export const WriteBlock = memo(function WriteBlock({ block, result, isRecent }: FileBlockProps) {
  const input = toolInput(block);
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  const name = fileName(filePath);
  const content = typeof input.content === 'string' ? input.content : '';
  const hasError = isToolResultError(result);

  return (
    <ToolBlockShell
      id="write"
      label="Write"
      glyph="✎"
      toolName="Write"
      preview={name}
      hasError={hasError}
      defaultExpanded={isRecent}
    >
      <CodeHighlight code={content} language={detectLanguage(name)} />
    </ToolBlockShell>
  );
});

export const EditBlock = memo(function EditBlock({ block, result, isRecent }: FileBlockProps) {
  const input = toolInput(block);
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  const name = fileName(filePath);
  const oldString = typeof input.old_string === 'string' ? input.old_string : '';
  const newString = typeof input.new_string === 'string' ? input.new_string : '';
  const hasError = isToolResultError(result);

  const added = newString ? newString.split('\n').length : 0;
  const removed = oldString ? oldString.split('\n').length : 0;

  return (
    <ToolBlockShell
      id="edit"
      label="Edit"
      glyph="✦"
      toolName="Edit"
      preview={name}
      badge={`+${added} −${removed}`}
      hasError={hasError}
      defaultExpanded={isRecent}
    >
      <DiffHighlight oldString={oldString} newString={newString} />
    </ToolBlockShell>
  );
});

interface MultiEditSubEdit {
  old_string?: string;
  new_string?: string;
}

export const MultiEditBlock = memo(function MultiEditBlock({
  block,
  result,
  isRecent,
}: FileBlockProps) {
  const input = toolInput(block);
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  const name = fileName(filePath);
  const edits = Array.isArray(input.edits) ? (input.edits as MultiEditSubEdit[]) : [];
  const hasError = isToolResultError(result);

  let added = 0;
  let removed = 0;
  for (const edit of edits) {
    const newString = typeof edit.new_string === 'string' ? edit.new_string : '';
    const oldString = typeof edit.old_string === 'string' ? edit.old_string : '';
    if (newString) added += newString.split('\n').length;
    if (oldString) removed += oldString.split('\n').length;
  }

  return (
    <ToolBlockShell
      id="multi-edit"
      label="Edit"
      glyph="✦"
      toolName="MultiEdit"
      preview={name}
      badge={`+${added} −${removed}`}
      hasError={hasError}
      defaultExpanded={isRecent}
    >
      {edits.map((edit, i) => (
        <DiffHighlight
          key={i}
          testID={`diff-highlight-${i}`}
          oldString={typeof edit.old_string === 'string' ? edit.old_string : ''}
          newString={typeof edit.new_string === 'string' ? edit.new_string : ''}
        />
      ))}
    </ToolBlockShell>
  );
});
