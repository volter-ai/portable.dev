/**
 * AgentSelectorSheet — the rich agent-setup picker (web `AgentSetupButton` parity).
 *
 * Unlike the generic text-only {@link SelectorSheet} (model / permissions), the agent
 * sheet mirrors the web option design: a per-agent colored avatar (dicebear
 * "notionists", seeded by the setup id) + a name badge tinted with the setup's
 * `colorTheme`, the description, and a mosaic of the sub-agents — each its own
 * colored avatar (seeded by sub-agent `type`) + name. The selected option gets a
 * left accent bar + a tint of its color, exactly like the web popover. Any setup
 * shipping no `colorTheme` falls back to the same neutral gray the web uses
 * (`#586069`). The avatars come from the same dicebear endpoint the web uses (PNG
 * here so RN's `<Image>` can render it; the seed/figure is identical to the web SVG).
 *
 * Shared by both composers (home {@link ChatComposer} + active-chat
 * {@link FollowUpComposer}); the trigger avatar is {@link AgentAvatar}.
 */

import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgentSetup, SubAgentDefinition } from '@vgit2/shared/types';

import { useBottomInset } from './useBottomInset';

import { useAppTheme, withAlpha } from '../../../theme';

/** The web default when an agent ships no `colorTheme` (`AgentSetupButton`). */
const FALLBACK_COLOR = '#586069';

/** Dicebear "notionists" avatar, seeded like the web (PNG so RN `<Image>` renders it). */
function avatarUrl(seed: string): string {
  return `https://api.dicebear.com/7.x/notionists/png?seed=${encodeURIComponent(seed)}`;
}

/** The colored, dicebear-seeded avatar reused by the trigger + each option header. */
export function AgentAvatar({
  setup,
  size = 18,
}: {
  setup: AgentSetup | undefined;
  size?: number;
}) {
  const color = setup?.colorTheme || FALLBACK_COLOR;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        overflow: 'hidden',
      }}
    >
      {setup ? (
        <Image source={{ uri: avatarUrl(setup.id) }} style={{ width: size, height: size }} />
      ) : null}
    </View>
  );
}

export interface AgentSelectorSheetProps {
  testID: string;
  visible: boolean;
  setups: AgentSetup[];
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function AgentSelectorSheet(props: AgentSelectorSheetProps) {
  const { theme } = useAppTheme();
  // Bottom-pinned sheet: absorb the system bottom inset (Android nav bar / iOS
  // home indicator) so the last option isn't hidden behind it.
  const bottomInset = useBottomInset();
  if (!props.visible) return null;
  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={props.onClose}
      testID={props.testID}
    >
      <Pressable
        style={styles.backdrop}
        onPress={props.onClose}
        testID={`${props.testID}-backdrop`}
      />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: theme.colors.backgroundElevated,
            paddingBottom: 16 + bottomInset,
          },
        ]}
      >
        <Text style={[styles.title, { color: theme.colors.text }]}>Select Agent</Text>
        <ScrollView>
          {props.setups.map((setup) => (
            <AgentOption
              key={setup.id}
              setup={setup}
              selected={setup.id === props.selectedId}
              onPress={() => props.onSelect(setup.id)}
            />
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

function AgentOption({
  setup,
  selected,
  onPress,
}: {
  setup: AgentSetup;
  selected: boolean;
  onPress: () => void;
}) {
  const { theme } = useAppTheme();
  const color = setup.colorTheme || FALLBACK_COLOR;
  // The server type guarantees `subAgents`, but a thin/mocked setup may omit it.
  const subAgents: SubAgentDefinition[] = setup.subAgents ?? [];
  return (
    <Pressable
      testID={`agent-option-${setup.id}`}
      onPress={onPress}
      style={[
        styles.option,
        {
          borderLeftColor: selected ? color : 'transparent',
          backgroundColor: selected ? withAlpha(color, '15') : 'transparent',
        },
      ]}
    >
      <View style={styles.header}>
        <AgentAvatar setup={setup} size={28} />
        <View style={[styles.nameBadge, { backgroundColor: color }]}>
          <Text style={[styles.nameText, { color: theme.colors.surface }]} numberOfLines={1}>
            {setup.name}
          </Text>
        </View>
      </View>

      {setup.description ? (
        <Text style={[styles.desc, { color: theme.colors.textSecondary }]}>
          {setup.description}
        </Text>
      ) : null}

      {subAgents.length > 0 ? (
        <View style={styles.subRow}>
          {subAgents.map((sa) => (
            <View key={sa.type} style={[styles.chip, { backgroundColor: theme.colors.background }]}>
              <View
                style={[styles.chipAvatar, { backgroundColor: sa.colorTheme || FALLBACK_COLOR }]}
              >
                <Image source={{ uri: avatarUrl(sa.type) }} style={styles.chipAvatarImg} />
              </View>
              <Text
                style={[styles.chipText, { color: theme.colors.textSecondary }]}
                numberOfLines={1}
              >
                {sa.name}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    gap: 8,
    maxHeight: '70%',
  },
  title: { fontSize: 18, fontWeight: '700', marginBottom: 4 },
  option: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderLeftWidth: 3,
    gap: 8,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nameBadge: { paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6 },
  nameText: { fontSize: 12, fontWeight: '600' },
  desc: { fontSize: 13, lineHeight: 18 },
  subRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  chipAvatar: { width: 16, height: 16, borderRadius: 8, overflow: 'hidden' },
  chipAvatarImg: { width: 16, height: 16 },
  chipText: { fontSize: 11 },
});
