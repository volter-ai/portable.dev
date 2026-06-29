/**
 * WebSearchBlock / WebFetchBlock / PlaywrightBlock / TunnelBlock — network &
 * browser tool blocks.
 *
 * Each renders through the shared `ToolBlockShell` (collapsible header + body) and
 * surfaces the tool's input + result. Links open via `Linking.openURL`. The
 * runtime-overlay auto-open on a streamed result (Playwright/Tunnel) is the
 * RuntimeBox epic; here the blocks render natively and never fall back to raw JSON.
 */

import { memo } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

import { useAppTheme } from '../../../theme';
import { ToolBlockShell } from './ToolBlockShell';
import {
  getToolResultText,
  isToolResultError,
  preview,
  toolInput,
  type ToolResult,
} from './blockHelpers';

export interface NetToolBlockProps {
  block: ClaudeStreamBlock;
  result?: ToolResult;
  isRecent?: boolean;
}

function LinkRow({ label, url }: { label: string; url: string }) {
  const { theme } = useAppTheme();
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => {
        void Linking.openURL(url).catch(() => {});
      }}
    >
      <Text style={[styles.link, { color: theme.colors.link }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

interface ParsedLink {
  title: string;
  url: string;
}

/** Parse the `Links: [...]` JSON array the WebSearch tool emits in its result. */
function parseSearchResults(text: string): ParsedLink[] {
  const match = text.match(/Links:\s*(\[[\s\S]*?\])/);
  if (match?.[1]) {
    try {
      const arr = JSON.parse(match[1]) as { title?: string; url?: string }[];
      return arr.map((l) => ({ title: l.title || 'Untitled', url: l.url || '#' }));
    } catch {
      // fall through to regex
    }
  }
  const results: ParsedLink[] = [];
  const re = /\{"title":"([^"]+)","url":"([^"]+)"\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) results.push({ title: m[1], url: m[2] });
  return results;
}

export const WebSearchBlock = memo(function WebSearchBlock({
  block,
  result,
  isRecent,
}: NetToolBlockProps) {
  const { theme } = useAppTheme();
  const input = toolInput(block);
  const query = typeof input.query === 'string' ? input.query : '';
  const text = getToolResultText(result?.content);
  const hasError = isToolResultError(result);
  const links = text ? parseSearchResults(text) : [];

  return (
    <ToolBlockShell
      id="web-search"
      label="Web Search"
      glyph="🔎"
      toolName="WebSearch"
      preview={preview(query)}
      badge={links.length ? `${links.length}` : undefined}
      hasError={hasError}
      defaultExpanded={isRecent}
    >
      {query ? (
        <Text
          style={[
            styles.query,
            { color: theme.colors.textSecondary, fontFamily: theme.typography.fontFamilyMono },
          ]}
        >
          &ldquo;{query}&rdquo;
        </Text>
      ) : null}
      <View testID="web-search-results">
        {links.map((link, i) => (
          <LinkRow key={i} label={link.title} url={link.url} />
        ))}
      </View>
      {!links.length && text ? (
        <Text
          style={[
            styles.output,
            {
              color: theme.colors.text,
              backgroundColor: theme.colors.surface,
              fontFamily: theme.typography.fontFamilyMono,
            },
          ]}
        >
          {text}
        </Text>
      ) : null}
    </ToolBlockShell>
  );
});

export const WebFetchBlock = memo(function WebFetchBlock({
  block,
  result,
  isRecent,
}: NetToolBlockProps) {
  const { theme } = useAppTheme();
  const input = toolInput(block);
  const url = typeof input.url === 'string' ? input.url : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const text = getToolResultText(result?.content);
  const hasError = isToolResultError(result);

  return (
    <ToolBlockShell
      id="web-fetch"
      label="Web Fetch"
      glyph="🌐"
      toolName="WebFetch"
      preview={preview(url)}
      hasError={hasError}
      defaultExpanded={isRecent}
    >
      {url ? <LinkRow label={url} url={url} /> : null}
      {prompt ? (
        <Text
          style={[
            styles.query,
            { color: theme.colors.textSecondary, fontFamily: theme.typography.fontFamilyMono },
          ]}
        >
          &ldquo;{prompt}&rdquo;
        </Text>
      ) : null}
      {text ? (
        <Text
          style={[
            styles.output,
            {
              color: theme.colors.text,
              backgroundColor: theme.colors.surface,
              fontFamily: theme.typography.fontFamilyMono,
            },
          ]}
        >
          {text}
        </Text>
      ) : null}
    </ToolBlockShell>
  );
});

export const PlaywrightBlock = memo(function PlaywrightBlock({
  block,
  result,
  isRecent,
}: NetToolBlockProps) {
  const { theme } = useAppTheme();
  const action = (block.toolName || '')
    .replace('mcp__playwright__browser_', '')
    .replace(/_/g, ' ')
    .trim();
  const label = action ? `Browser: ${action}` : 'Browser';
  const text = getToolResultText(result?.content);
  const hasError = isToolResultError(result);
  const input = toolInput(block);
  const target = typeof input.url === 'string' ? input.url : '';

  return (
    <ToolBlockShell
      id="playwright"
      label={label}
      glyph="🧭"
      toolName={block.toolName}
      preview={preview(target)}
      hasError={hasError}
      defaultExpanded={isRecent}
    >
      {target ? <LinkRow label={target} url={target} /> : null}
      {text ? (
        <Text
          style={[
            styles.output,
            {
              color: theme.colors.text,
              backgroundColor: theme.colors.surface,
              fontFamily: theme.typography.fontFamilyMono,
            },
          ]}
        >
          {text}
        </Text>
      ) : null}
    </ToolBlockShell>
  );
});

/** Extract the first `https://…` URL the tunnel tool reports in its result. */
function extractTunnelUrl(text: string): string {
  const m = text.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : '';
}

export const TunnelBlock = memo(function TunnelBlock({
  block,
  result,
  isRecent,
}: NetToolBlockProps) {
  const { theme } = useAppTheme();
  const input = toolInput(block);
  const port = input.port != null ? String(input.port) : '';
  const text = getToolResultText(result?.content);
  const hasError = isToolResultError(result);
  const tunnelUrl = extractTunnelUrl(text);

  return (
    <ToolBlockShell
      id="tunnel"
      label="Tunnel"
      glyph="🚇"
      toolName="create_tunnel"
      preview={port ? `port ${port}` : undefined}
      hasError={hasError}
      defaultExpanded={isRecent}
    >
      {tunnelUrl ? <LinkRow label={tunnelUrl} url={tunnelUrl} /> : null}
      {text ? (
        <Text
          style={[
            styles.output,
            {
              color: theme.colors.text,
              backgroundColor: theme.colors.surface,
              fontFamily: theme.typography.fontFamilyMono,
            },
          ]}
        >
          {text}
        </Text>
      ) : null}
    </ToolBlockShell>
  );
});

const styles = StyleSheet.create({
  link: { fontSize: 13, textDecorationLine: 'underline', marginBottom: 2 },
  query: { fontSize: 12, marginBottom: 4 },
  output: {
    fontSize: 12,
    borderRadius: 6,
    padding: 8,
  },
});
