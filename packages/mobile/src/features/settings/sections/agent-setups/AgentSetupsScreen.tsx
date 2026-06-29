/**
 * Agent Setups settings section (`/settings/agent-setups`) — READ-ONLY.
 * Displays the agent-setup catalog: avatar + name badge, description,
 * sub-agent chips, and the DERIVED orchestration badge. Selection happens in
 * the chat composer (`AgentSetupButton`, already built) — this page
 * never persists anything.
 *
 * Thin view over {@link useAgentSetupsSection}; cards render via the shared
 * settings chrome ({@link SettingsCard}).
 *
 * testIDs:
 *   - `settings-agent-setups` (root) / `settings-agent-setups-back` (chrome)
 *   - `settings-agent-setups-loading` / `settings-agent-setups-error`
 *     (+`-retry`) / `settings-agent-setups-empty`
 *   - `settings-agent-setups-card-<id>`
 *   - `settings-agent-setups-avatar-<id>` (wrapper) /
 *     `settings-agent-setups-avatar-image-<id>` (dicebear `Image`, seed = setup.id)
 *   - `settings-agent-setups-name-<id>` / `settings-agent-setups-description-<id>`
 *   - `settings-agent-setups-orchestration-<id>` — DERIVED label
 *     ('Delegation-Based' | 'Direct Execution', NEVER from the API)
 *   - `settings-agent-setups-subagent-<setupId>-<type>` (chip) /
 *     `settings-agent-setups-subagent-avatar-<setupId>-<type>` (wrapper) /
 *     `settings-agent-setups-subagent-avatar-image-<setupId>-<type>`
 *     (dicebear `Image`, seed = subAgent.type)
 *
 * Deliberate gaps:
 *   - The card omits the setup's enabled MCP servers chip cluster (the MCP
 *     catalog lives at `/settings/mcp`).
 *   - Dicebear avatars use the `/png` endpoint instead of `/svg`
 *     (RN `Image` cannot decode SVG; same seed → identical avatar), with a
 *     colored-circle + initial fallback rendered beneath while loading.
 *   - An empty catalog renders an explicit `SectionEmpty` message
 *     (mobile chrome convention).
 */

import { Image, StyleSheet, Text, View } from 'react-native';

import type { AgentSetup, SubAgentDefinition } from '@vgit2/shared/types';

import { useAppTheme } from '../../../../theme';
import {
  SectionEmpty,
  SectionError,
  SectionLoading,
  SettingsCard,
  SettingsSectionScreen,
} from '../../chrome';
import {
  FALLBACK_AVATAR_COLOR,
  getAgentAvatarUrl,
  getOrchestrationLabel,
} from './agentSetupHelpers';
import { useAgentSetupsSection } from './useAgentSetupsSection';

export interface AgentSetupsScreenProps {
  /** Back action override (default: chrome `router.back()`); injectable for tests. */
  onBack?: () => void;
}

export function AgentSetupsScreen({ onBack }: AgentSetupsScreenProps) {
  const vm = useAgentSetupsSection();

  return (
    <SettingsSectionScreen title="Agent Setups" testID="settings-agent-setups" onBack={onBack}>
      {vm.loading ? (
        <SectionLoading testID="settings-agent-setups-loading" caption="Loading agent setups..." />
      ) : vm.error ? (
        <SectionError
          testID="settings-agent-setups-error"
          message={`Error loading agent setups: ${vm.error}`}
          onRetry={vm.retry}
        />
      ) : vm.setups.length === 0 ? (
        <SectionEmpty testID="settings-agent-setups-empty" message="No agent setups available." />
      ) : (
        vm.setups.map((setup) => <AgentSetupCard key={setup.id} setup={setup} />)
      )}
    </SettingsSectionScreen>
  );
}

/**
 * Circular dicebear avatar over a colored disc (`background + backgroundImage`
 * layering): the disc + initial render beneath and the remote PNG covers them
 * once loaded.
 */
function AgentAvatar({
  seed,
  color,
  size,
  initial,
  testID,
  imageTestID,
}: {
  seed: string;
  color: string;
  size: number;
  initial: string;
  testID: string;
  imageTestID: string;
}) {
  const radius = size / 2;
  return (
    <View
      testID={testID}
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: radius, backgroundColor: color },
      ]}
    >
      <Text style={[styles.avatarInitial, { fontSize: radius }]} allowFontScaling={false}>
        {initial}
      </Text>
      <Image
        testID={imageTestID}
        source={{ uri: getAgentAvatarUrl(seed) }}
        style={[StyleSheet.absoluteFill, { borderRadius: radius }]}
        resizeMode="cover"
      />
    </View>
  );
}

function AgentSetupCard({ setup }: { setup: AgentSetup }) {
  const { theme } = useAppTheme();
  const setupColor = setup.colorTheme || FALLBACK_AVATAR_COLOR;

  return (
    <SettingsCard testID={`settings-agent-setups-card-${setup.id}`}>
      {/* Header: avatar + colored name badge. */}
      <View style={styles.headerRow}>
        <AgentAvatar
          seed={setup.id}
          color={setupColor}
          size={24}
          initial={(setup.name.charAt(0) || '?').toUpperCase()}
          testID={`settings-agent-setups-avatar-${setup.id}`}
          imageTestID={`settings-agent-setups-avatar-image-${setup.id}`}
        />
        <View style={[styles.nameBadge, { backgroundColor: setupColor }]}>
          <Text
            testID={`settings-agent-setups-name-${setup.id}`}
            numberOfLines={1}
            style={[styles.nameBadgeText, { color: theme.colors.surface }]}
          >
            {setup.name}
          </Text>
        </View>
      </View>

      <Text
        testID={`settings-agent-setups-description-${setup.id}`}
        style={[styles.description, { color: theme.colors.textSecondary }]}
      >
        {setup.description}
      </Text>

      {setup.subAgents.length > 0 ? (
        <View style={styles.subAgentsBlock}>
          <Text style={[styles.subAgentsLabel, { color: theme.colors.textTertiary }]}>
            Sub-Agents
          </Text>
          <View style={styles.chipRow}>
            {setup.subAgents.map((subAgent: SubAgentDefinition) => (
              <View
                key={subAgent.type}
                testID={`settings-agent-setups-subagent-${setup.id}-${subAgent.type}`}
                style={[styles.subAgentChip, { backgroundColor: theme.colors.surfaceHover }]}
              >
                <AgentAvatar
                  seed={subAgent.type}
                  color={subAgent.colorTheme || FALLBACK_AVATAR_COLOR}
                  size={14}
                  initial={(subAgent.name.charAt(0) || '?').toUpperCase()}
                  testID={`settings-agent-setups-subagent-avatar-${setup.id}-${subAgent.type}`}
                  imageTestID={`settings-agent-setups-subagent-avatar-image-${setup.id}-${subAgent.type}`}
                />
                <Text style={[styles.subAgentName, { color: theme.colors.textSecondary }]}>
                  {subAgent.name}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {/* Orchestration badge — DERIVED, never read from the API. */}
      <View style={styles.badgeRow}>
        <View
          testID={`settings-agent-setups-orchestration-${setup.id}`}
          style={[
            styles.badge,
            {
              backgroundColor: theme.colors.surfaceHover,
              borderColor: theme.colors.borderLight,
            },
          ]}
        >
          <Text style={[styles.badgeText, { color: theme.colors.textSecondary }]}>
            {getOrchestrationLabel(setup)}
          </Text>
        </View>
      </View>
    </SettingsCard>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  avatar: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 },
  // Fallback letter is white-on-color regardless of theme (avatar disc).
  avatarInitial: { color: '#fff', fontWeight: '600' },
  nameBadge: {
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 4,
    flexShrink: 1,
  },
  nameBadgeText: { fontSize: 10, fontWeight: '600' },
  description: { fontSize: 13, lineHeight: 18, marginTop: 12 },
  subAgentsBlock: { marginTop: 12 },
  subAgentsLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  subAgentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 4,
  },
  subAgentName: { fontSize: 10 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  badge: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    borderWidth: 1,
  },
  badgeText: { fontSize: 12 },
});
