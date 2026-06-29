/**
 * MCP Servers settings section (`/settings/mcp`) — READ-ONLY. Shows every MCP
 * server with its icon, status, description, category and tool count; token
 * configuration happens elsewhere (Secrets / connections) — the 'Configuration
 * Required' status is informational only.
 *
 * Thin view over {@link useMcpServers}; cards render via the shared settings
 * chrome ({@link SettingsCard}) + the native {@link McpIcon}.
 *
 * testIDs:
 *   - `settings-mcp` (root) / `settings-mcp-back` (chrome back button)
 *   - `settings-mcp-loading` / `settings-mcp-error` (+`-retry`) / `settings-mcp-empty`
 *   - `settings-mcp-card-<id>`
 *   - `settings-mcp-icon-<id>` (+`-emoji` | `-image` | `-fallback` per resolution)
 *   - `settings-mcp-name-<id>` / `settings-mcp-status-<id>` / `settings-mcp-description-<id>`
 *   - `settings-mcp-tools-<id>` (ONLY when `mcp.toolCount` is set, truthy check)
 *   - `settings-mcp-category-<id>` (exact labels: Automation/Development/
 *     Productivity/Platform/Media/Other)
 *   - `settings-mcp-requirements-<id>` (ONLY when status === 'missing_token'
 *     AND `requirements.length > 0`)
 *
 * Deliberate gaps:
 *   - Cards render as a flat list with the category as a per-card badge (rather
 *     than per-category `<h3>` header groups).
 *   - The capitalized `mcp.type` badge ('external'/'custom') is omitted; the
 *     card set is icon/name/status/description/category/tool-count/requirements.
 *   - The requirements badge uses a warning-tinted (`withAlpha`) surface with
 *     warning text/border (rather than warning text on a warning background,
 *     which is unreadable).
 *   - Emoji icons render as a native `Text` glyph rather than a Fluent-Emoji CDN
 *     image (no SVG decoding on RN; same visual glyph).
 *   - An empty catalog renders an explicit `SectionEmpty` message
 *     (mobile chrome convention).
 */

import { StyleSheet, Text, View } from 'react-native';

import { useAppTheme, withAlpha } from '../../../../theme';
import {
  SectionEmpty,
  SectionError,
  SectionLoading,
  SettingsCard,
  SettingsSectionScreen,
} from '../../chrome';
import { McpIcon } from './McpIcon';
import {
  MCP_STATUS_CONFIG,
  formatMissingRequirements,
  formatToolCount,
  getMcpCategoryLabel,
  type McpStatus,
} from './mcpHelpers';
import { useMcpServers } from './useMcpServers';

export interface McpServersScreenProps {
  /** Back action override (default: chrome `router.back()`); injectable for tests. */
  onBack?: () => void;
}

export function McpServersScreen({ onBack }: McpServersScreenProps) {
  const vm = useMcpServers();

  return (
    <SettingsSectionScreen title="MCP Servers" testID="settings-mcp" onBack={onBack}>
      {vm.loading ? (
        <SectionLoading testID="settings-mcp-loading" caption="Loading MCP servers..." />
      ) : vm.error ? (
        <SectionError
          testID="settings-mcp-error"
          message={`Error loading MCPs: ${vm.error}`}
          onRetry={vm.retry}
        />
      ) : vm.mcps.length === 0 ? (
        <SectionEmpty testID="settings-mcp-empty" message="No MCP servers available." />
      ) : (
        vm.mcps.map((mcp) => <McpCard key={mcp.id} mcp={mcp} />)
      )}
    </SettingsSectionScreen>
  );
}

function McpCard({ mcp }: { mcp: McpStatus }) {
  const { theme } = useAppTheme();
  const status = MCP_STATUS_CONFIG[mcp.status];
  const statusColor =
    status.tone === 'success'
      ? theme.colors.success
      : status.tone === 'warning'
        ? theme.colors.warning
        : theme.colors.textTertiary;
  const badgeStyle = {
    backgroundColor: theme.colors.surfaceHover,
    borderColor: theme.colors.borderLight,
  };

  return (
    <SettingsCard testID={`settings-mcp-card-${mcp.id}`}>
      <View style={styles.headerRow}>
        <McpIcon mcp={mcp} size={32} testID={`settings-mcp-icon-${mcp.id}`} />
        <View style={styles.headerText}>
          <Text
            testID={`settings-mcp-name-${mcp.id}`}
            numberOfLines={1}
            style={[styles.name, { color: theme.colors.text }]}
          >
            {mcp.name}
          </Text>
          <Text
            testID={`settings-mcp-status-${mcp.id}`}
            style={[styles.status, { color: statusColor }]}
          >
            {`${status.glyph} ${status.label}`}
          </Text>
        </View>
      </View>

      <Text
        testID={`settings-mcp-description-${mcp.id}`}
        style={[styles.description, { color: theme.colors.textSecondary }]}
      >
        {mcp.description}
      </Text>

      <View style={styles.badgeRow}>
        {/* Truthy check — toolCount 0/undefined hides the badge. */}
        {mcp.toolCount ? (
          <View style={[styles.badge, badgeStyle]} testID={`settings-mcp-tools-${mcp.id}`}>
            <Text style={[styles.badgeText, { color: theme.colors.textSecondary }]}>
              {formatToolCount(mcp.toolCount)}
            </Text>
          </View>
        ) : null}

        <View style={[styles.badge, badgeStyle]} testID={`settings-mcp-category-${mcp.id}`}>
          <Text style={[styles.badgeText, { color: theme.colors.textSecondary }]}>
            {getMcpCategoryLabel(mcp)}
          </Text>
        </View>

        {mcp.status === 'missing_token' && mcp.requirements.length > 0 ? (
          <View
            style={[
              styles.badge,
              styles.requirementsBadge,
              {
                backgroundColor: withAlpha(theme.colors.warning, '20'),
                borderColor: theme.colors.warning,
              },
            ]}
            testID={`settings-mcp-requirements-${mcp.id}`}
          >
            <Text style={[styles.requirementsText, { color: theme.colors.warning }]}>
              {formatMissingRequirements(mcp.requirements)}
            </Text>
          </View>
        ) : null}
      </View>
    </SettingsCard>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerText: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, fontWeight: '600', marginBottom: 2 },
  status: { fontSize: 12 },
  description: { fontSize: 13, lineHeight: 18, marginTop: 12 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  badge: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    borderWidth: 1,
  },
  badgeText: { fontSize: 12 },
  // `flex: 1 0 100%` — the requirements line takes its own full row.
  requirementsBadge: { flexBasis: '100%' },
  requirementsText: { fontSize: 11 },
});
