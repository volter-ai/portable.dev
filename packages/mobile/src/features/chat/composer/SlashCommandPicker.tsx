/**
 * SlashCommandPicker — the active-chat / repo composer's `/` autocomplete (the
 * "enriched form for slash commands"). When the user types a leading `/`, this
 * panel lists the slash commands + Agent Skills the SDK will actually execute for
 * the chat/repo (from `useChatCommands`/`useRepoCommands`). Selecting one inserts
 * `/<name> ` into the input (the caller keeps focus) so the user can add arguments
 * before sending.
 *
 * Two modes (the key to good UX — see {@link rankSlashCommands}):
 *   - BROWSE (empty query, bare `/`): the whole catalog, GROUPED + labelled
 *     (Skills / Commands / Built-in) in the server's order.
 *   - SEARCH (anything typed): a FLAT, best-match-first list (relevance wins; kind
 *     is only a tie-breaker, shown as a small per-row badge). This is why `/comp`
 *     surfaces `compact` first instead of burying it under weakly-matching skills.
 *
 * It is an OVERLAY, not an inline block: the panel is absolutely positioned so it
 * NEVER reflows the surrounding content. It opens in the direction the input needs —
 * `up` for bottom-docked inputs (the active-chat composer), `down` for inputs near
 * the top of a page (the repo Overview "Work on…" input). A full-screen transparent
 * backdrop catches a tap anywhere outside the panel and cancels it (`onDismiss`).
 * The list scrolls within the panel's bounded height.
 */

import type { SlashCommandInfo } from '@vgit2/shared/types';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { useAppTheme } from '../../../theme';
import { rankSlashCommands } from './rankSlashCommands';

/**
 * The live filter query for the picker, or `null` when the input is NOT in
 * slash-command mode. Active only while the whole input is a single leading-slash
 * token (`/`, `/dep`, …) with no space yet — i.e. the user is choosing a command.
 * A space means they've moved on to arguments, so the picker should close. The
 * captured group (text after the `/`) is what the picker filters on.
 */
export function parseSlashQuery(text: string): string | null {
  const match = /^\/(\S*)$/.exec(text);
  return match ? match[1] : null;
}

export interface SlashCommandPickerProps {
  /** Commands + skills available to the chat/repo (already SDK-scoped + sorted). */
  commands: SlashCommandInfo[];
  /** The text typed AFTER the leading slash (the live filter query). */
  query: string;
  /** True while the list is still loading and nothing is cached yet. */
  loading?: boolean;
  /** Insert the chosen command (name without the leading slash). */
  onSelect: (name: string) => void;
  /**
   * Which way the panel opens relative to the anchored input: `up` for a
   * bottom-docked input (active-chat composer), `down` for a top-of-page input
   * (repo Overview). Default `up`.
   */
  direction?: 'up' | 'down';
  /** Tap-outside (backdrop) → cancel. When omitted, no backdrop is rendered. */
  onDismiss?: () => void;
  testID?: string;
}

const KIND_LABEL: Record<SlashCommandInfo['kind'], string> = {
  skill: 'Skills',
  command: 'Commands',
  builtin: 'Built-in',
};
const KIND_ORDER: SlashCommandInfo['kind'][] = ['skill', 'command', 'builtin'];
// Singular per-row badge for the flat SEARCH list (the section header conveys kind in
// browse mode, so the badge is only shown while searching).
const KIND_BADGE: Record<SlashCommandInfo['kind'], string> = {
  skill: 'skill',
  command: 'cmd',
  builtin: 'built-in',
};

export function SlashCommandPicker({
  commands,
  query,
  loading,
  onSelect,
  direction = 'up',
  onDismiss,
  testID = 'slash-command-picker',
}: SlashCommandPickerProps) {
  const { theme } = useAppTheme();
  const { width, height } = useWindowDimensions();

  // Browse (empty query) vs search. Search ranks by relevance and renders FLAT;
  // browse keeps the server's grouped catalog.
  const searching = query.trim() !== '';
  const ranked = rankSlashCommands(query, commands);

  const showLoading = !!loading && commands.length === 0;
  // Hide entirely when nothing matches (e.g. the user typed a file path like
  // `/usr/...`) so an empty box never gets in the way.
  if (!showLoading && ranked.length === 0) return null;

  // Browse mode: group by kind in the server's skill→command→builtin order.
  const groups = KIND_ORDER.map((kind) => ({
    kind,
    items: ranked.filter((c) => c.kind === kind),
  })).filter((g) => g.items.length > 0);

  // One option row, shared by both modes. `showKind` adds the singular kind badge
  // used in the flat search list (browse rows rely on their section header instead).
  const renderOption = (cmd: SlashCommandInfo, showKind: boolean) => (
    <Pressable
      key={`${cmd.kind}:${cmd.name}`}
      testID={`slash-command-option-${cmd.name}`}
      accessibilityRole="button"
      style={styles.option}
      onPress={() => onSelect(cmd.name)}
    >
      <View style={styles.optionMain}>
        <Text style={[styles.optionName, { color: theme.colors.text }]}>
          /{cmd.name}
          {cmd.argumentHint ? (
            <Text style={[styles.optionHint, { color: theme.colors.textTertiary }]}>
              {' '}
              {cmd.argumentHint}
            </Text>
          ) : null}
        </Text>
        {cmd.description ? (
          <Text
            style={[styles.optionDesc, { color: theme.colors.textSecondary }]}
            numberOfLines={1}
          >
            {cmd.description}
          </Text>
        ) : null}
      </View>
      {showKind ? (
        <Text style={[styles.kindTag, { color: theme.colors.textTertiary }]}>
          {KIND_BADGE[cmd.kind]}
        </Text>
      ) : null}
      {cmd.scope === 'global' ? (
        <Text style={[styles.scopeTag, { color: theme.colors.textTertiary }]}>global</Text>
      ) : null}
    </Pressable>
  );

  return (
    <>
      {onDismiss ? (
        <Pressable
          testID={`${testID}-backdrop`}
          accessibilityLabel="Dismiss command menu"
          onPress={onDismiss}
          // Extends a full screen in every direction from the anchor so a tap
          // ANYWHERE outside the panel cancels. Transparent — it's a dropdown, not a
          // modal, so the input keeps focus and the content stays visible.
          style={[styles.backdrop, { top: -height, bottom: -height, left: -width, right: -width }]}
        />
      ) : null}
      <View
        testID={testID}
        style={[
          styles.panel,
          direction === 'up' ? styles.up : styles.down,
          {
            backgroundColor: theme.colors.backgroundElevated,
            borderColor: theme.colors.borderLight,
          },
          theme.shadows.lg,
        ]}
      >
        {showLoading ? (
          <Text
            testID={`${testID}-loading`}
            style={[styles.hint, { color: theme.colors.textTertiary }]}
          >
            Loading commands…
          </Text>
        ) : searching ? (
          // SEARCH: one flat, relevance-ranked list (best match first).
          <ScrollView keyboardShouldPersistTaps="always" style={styles.scroll}>
            {ranked.map((cmd) => renderOption(cmd, true))}
          </ScrollView>
        ) : (
          // BROWSE: the grouped catalog (skill → command → built-in).
          <ScrollView keyboardShouldPersistTaps="always" style={styles.scroll}>
            {groups.map((group) => (
              <View key={group.kind}>
                <Text style={[styles.sectionHeader, { color: theme.colors.textTertiary }]}>
                  {KIND_LABEL[group.kind]}
                </Text>
                {group.items.map((cmd) => renderOption(cmd, false))}
              </View>
            ))}
          </ScrollView>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  // Transparent tap-catcher; default z (below the panel) so it sits behind the panel
  // and behind the input the consumer renders after it.
  backdrop: { position: 'absolute' },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    // Float above sibling content (and Android-elevated cards) without reflowing it.
    zIndex: 1000,
    elevation: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    overflow: 'hidden',
  },
  // Opens upward from a bottom-docked input (panel's bottom sits just above the input).
  up: { bottom: '100%', marginBottom: 6 },
  // Opens downward from a top-of-page input (panel's top sits just below the input).
  down: { top: '100%', marginTop: 6 },
  scroll: { maxHeight: 240 },
  hint: { fontSize: 13, paddingVertical: 14, paddingHorizontal: 12 },
  sectionHeader: {
    fontSize: 10.4,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    paddingTop: 10,
    paddingBottom: 4,
    paddingHorizontal: 12,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  optionMain: { flex: 1, gap: 2 },
  optionName: { fontSize: 15, fontWeight: '600' },
  // The argument-hint shown grey + normal-weight inline after the bold command name.
  optionHint: { fontWeight: '400' },
  optionDesc: { fontSize: 12, lineHeight: 16 },
  // Per-row kind badge in the flat search list ("skill"/"cmd"/"built-in").
  kindTag: { fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 },
  scopeTag: { fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 },
});
