/**
 * FileEditGroup — consolidated "Files edited" widget.
 *
 * The card `renderMessageBlocks` renders for a `groupFileEditBlocks` "file-edits"
 * segment: a single collapsible card (web/mobile `AgentGroup` parity — see
 * `MessageList.tsx`) standing in for what would otherwise be a stack of individual
 * Write/Edit/MultiEdit cards. Collapsed, it shows the file count + names so the
 * information survives even unexpanded; expanded, it renders each underlying edit
 * via `renderConsolidatedBlocks` — the SAME `EditBlock`/`WriteBlock`/`MultiEditBlock`
 * renderers used inline, each still independently expandable to its own diff.
 */

import { memo, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';
import type { MessageAction } from '@vgit2/shared/types';

import { renderConsolidatedBlocks } from './renderConsolidatedBlocks';
import { fileName, toolInput } from './blockHelpers';
import { isFileEditToolUse } from './groupFileEditBlocks';
import { useAppTheme } from '../../../theme';

export interface FileEditGroupProps {
  /** The consolidated group's raw blocks (file-edit tool_use + their tool_result). */
  blocks: ClaudeStreamBlock[];
  /** Key namespace forwarded to `renderConsolidatedBlocks` for the expanded body. */
  keyPrefix: string;
  onActionClick?: (action: MessageAction) => void;
}

interface FileEditSummary {
  id: string;
  name: string;
}

/** One row per edit tool_use in the group, in original order (repeats allowed — a file edited twice shows twice). */
function summarizeFileEdits(blocks: ClaudeStreamBlock[]): FileEditSummary[] {
  const out: FileEditSummary[] = [];
  for (const block of blocks) {
    if (!isFileEditToolUse(block)) continue;
    const input = toolInput(block);
    const filePath = typeof input.file_path === 'string' ? input.file_path : '';
    out.push({ id: block.id ?? `${out.length}`, name: fileName(filePath) || 'file' });
  }
  return out;
}

export const FileEditGroup = memo(function FileEditGroup({
  blocks,
  keyPrefix,
  onActionClick,
}: FileEditGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const { theme } = useAppTheme();
  const files = useMemo(() => summarizeFileEdits(blocks), [blocks]);
  // A real edit-tool block id (stable, unique) so the testID survives a list
  // re-render even if the positional `keyPrefix` shifts (e.g. a load-earlier prepend).
  const id = files[0]?.id ?? keyPrefix;
  const previewText = files.map((f) => f.name).join(', ');
  const tone = theme.tool.edit;

  return (
    <View
      style={[styles.wrapper, { backgroundColor: tone.soft, borderColor: tone.border }]}
      testID={`file-edit-group-${id}`}
    >
      <Pressable
        style={styles.header}
        onPress={() => setExpanded((v) => !v)}
        testID={`file-edit-group-toggle-${id}`}
        accessibilityRole="button"
      >
        <Text style={[styles.glyph, { color: tone.icon }]}>📝</Text>
        <Text style={[styles.label, { color: tone.text }]}>Files edited</Text>
        <Text
          style={[
            styles.count,
            { color: theme.colors.textSecondary, backgroundColor: theme.colors.surface },
          ]}
          testID={`file-edit-group-count-${id}`}
        >
          {files.length}
        </Text>
        {!expanded && previewText ? (
          <Text
            style={[styles.preview, { color: theme.colors.textSecondary }]}
            numberOfLines={1}
            testID={`file-edit-group-preview-${id}`}
          >
            {previewText}
          </Text>
        ) : null}
        <Text style={[styles.chevron, { color: theme.colors.textTertiary }]}>
          {expanded ? '▾' : '▸'}
        </Text>
      </Pressable>
      {expanded ? (
        <View testID={`file-edit-group-body-${id}`} style={styles.body}>
          {renderConsolidatedBlocks(blocks, keyPrefix, onActionClick)}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: { borderWidth: 1, borderRadius: 10, padding: 8, gap: 6, marginBottom: 6 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  glyph: { fontSize: 14 },
  label: { fontWeight: '600', fontSize: 14 },
  count: {
    fontSize: 11,
    fontWeight: '600',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  preview: { flex: 1, fontSize: 12, textAlign: 'right' },
  chevron: { marginLeft: 4 },
  body: { paddingVertical: 6, gap: 6 },
});
