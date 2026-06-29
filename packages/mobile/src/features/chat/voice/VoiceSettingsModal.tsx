/**
 * VoiceSettingsModal — the voice-input settings popup (opened by the cog in the recording
 * controls). Lets the user pick a recognition STRATEGY (privacy/accuracy trade-off) and
 * manage the custom PHRASES that bias the recognizer toward their vocabulary.
 *
 * The strategy is a per-device preference ({@link useVoiceSettingsStore}, MMKV). The
 * phrases live on the PC (portable metadata) — fetched via {@link useVoicePhrases} (cached)
 * and mutated via {@link useAddVoicePhrase} / {@link useRemoveVoicePhrase}, which bust the
 * cache. testIDs: `voice-settings-modal`, `voice-strategy-<id>`, `voice-phrase-<text>` /
 * `-remove-<text>`, `voice-phrase-input`, `voice-phrase-add`, `voice-settings-done`.
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useAddVoicePhrase, useRemoveVoicePhrase, useVoicePhrases } from '../../api/hooks';
import { VOICE_LANGUAGES, getVoiceLanguageLabel } from './voiceLanguages';
import { useVoiceSettingsStore } from './voiceSettingsStore';
import { VOICE_STRATEGIES, VOICE_STRATEGY_ORDER } from './voiceStrategies';
import { Icon, useAppTheme, withAlpha } from '../../../theme';

export interface VoiceSettingsModalProps {
  visible: boolean;
  onClose: () => void;
}

export function VoiceSettingsModal({ visible, onClose }: VoiceSettingsModalProps) {
  const { theme } = useAppTheme();
  const strategyId = useVoiceSettingsStore((s) => s.strategyId);
  const setStrategyId = useVoiceSettingsStore((s) => s.setStrategyId);
  const languageTag = useVoiceSettingsStore((s) => s.languageTag);
  const setLanguageTag = useVoiceSettingsStore((s) => s.setLanguageTag);

  const phrasesQuery = useVoicePhrases();
  const addPhrase = useAddVoicePhrase();
  const removePhrase = useRemoveVoicePhrase();
  const phrases = phrasesQuery.data?.phrases ?? [];

  const [draft, setDraft] = useState('');
  const [languageExpanded, setLanguageExpanded] = useState(false);

  const submitPhrase = () => {
    const trimmed = draft.trim();
    if (!trimmed || addPhrase.isPending) return;
    addPhrase.mutate(trimmed, { onSuccess: () => setDraft('') });
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View
          testID="voice-settings-modal"
          style={[
            styles.card,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
          ]}
        >
          <Text style={[styles.title, { color: theme.colors.text }]}>Voice input</Text>

          <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
            {/* Language picker — COLLAPSIBLE (shows the selected language) so it doesn't eat
                space. English is the default; picking another only changes THIS device's
                recognition language (so non-English speech isn't forced into English). */}
            <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>
              Language
            </Text>
            <Pressable
              testID="voice-language-toggle"
              onPress={() => setLanguageExpanded((v) => !v)}
              style={[styles.languageHeader, { borderColor: theme.colors.border }]}
            >
              <Text
                testID="voice-language-current"
                style={[styles.optionLabel, { color: theme.colors.text }]}
              >
                {getVoiceLanguageLabel(languageTag)}
              </Text>
              <Text style={[styles.languageCaret, { color: theme.colors.textTertiary }]}>
                {languageExpanded ? '▾' : '▸'}
              </Text>
            </Pressable>
            {languageExpanded
              ? VOICE_LANGUAGES.map((lng) => {
                  const selected = lng.tag === languageTag;
                  return (
                    <Pressable
                      key={lng.tag}
                      testID={`voice-language-${lng.tag}`}
                      onPress={() => {
                        setLanguageTag(lng.tag);
                        setLanguageExpanded(false);
                      }}
                      style={[
                        styles.languageRow,
                        {
                          borderColor: selected ? theme.colors.primary : theme.colors.border,
                          backgroundColor: selected
                            ? withAlpha(theme.colors.primary, '14')
                            : 'transparent',
                        },
                      ]}
                    >
                      <Icon
                        name={selected ? 'circle-dot' : 'circle'}
                        size={16}
                        color={selected ? theme.colors.primary : theme.colors.textTertiary}
                      />
                      <Text style={[styles.optionLabel, { color: theme.colors.text }]}>
                        {lng.label}
                      </Text>
                    </Pressable>
                  );
                })
              : null}

            {/* Strategy picker */}
            <Text
              style={[styles.sectionLabel, { color: theme.colors.textSecondary, marginTop: 18 }]}
            >
              Recognition mode
            </Text>
            {VOICE_STRATEGY_ORDER.map((id) => {
              const s = VOICE_STRATEGIES[id];
              const selected = id === strategyId;
              return (
                <Pressable
                  key={id}
                  testID={`voice-strategy-${id}`}
                  onPress={() => setStrategyId(id)}
                  style={[
                    styles.option,
                    {
                      borderColor: selected ? theme.colors.primary : theme.colors.border,
                      backgroundColor: selected
                        ? withAlpha(theme.colors.primary, '14')
                        : 'transparent',
                    },
                  ]}
                >
                  <View style={styles.optionHeader}>
                    <Icon
                      name={selected ? 'circle-dot' : 'circle'}
                      size={16}
                      color={selected ? theme.colors.primary : theme.colors.textTertiary}
                    />
                    <Text style={[styles.optionLabel, { color: theme.colors.text }]}>
                      {s.label}
                    </Text>
                    {!s.onDevice ? (
                      <Text style={[styles.privacyTag, { color: theme.colors.warning }]}>
                        sends audio off-device
                      </Text>
                    ) : null}
                  </View>
                  <Text style={[styles.optionDesc, { color: theme.colors.textSecondary }]}>
                    {s.description}
                  </Text>
                </Pressable>
              );
            })}

            {/* Custom phrases */}
            <Text
              style={[styles.sectionLabel, { color: theme.colors.textSecondary, marginTop: 18 }]}
            >
              Custom phrases
            </Text>
            <Text style={[styles.hint, { color: theme.colors.textTertiary }]}>
              Words the recognizer should listen for — project names, libraries, jargon.
            </Text>

            <View style={styles.addRow}>
              <TextInput
                testID="voice-phrase-input"
                value={draft}
                onChangeText={setDraft}
                placeholder="Add a phrase"
                placeholderTextColor={theme.colors.textTertiary}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={submitPhrase}
                style={[
                  styles.input,
                  {
                    color: theme.colors.text,
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.background,
                  },
                ]}
              />
              <Pressable
                testID="voice-phrase-add"
                onPress={submitPhrase}
                disabled={!draft.trim() || addPhrase.isPending}
                style={[
                  styles.addButton,
                  {
                    backgroundColor: theme.colors.primary,
                    opacity: draft.trim() && !addPhrase.isPending ? 1 : 0.5,
                  },
                ]}
              >
                <Icon name="plus" size={16} color="#fff" />
              </Pressable>
            </View>

            {phrasesQuery.isLoading ? (
              <ActivityIndicator
                testID="voice-phrases-loading"
                color={theme.colors.primary}
                style={styles.phrasesLoading}
              />
            ) : (
              <View style={styles.chips}>
                {phrases.map((phrase) => (
                  <View
                    key={phrase}
                    testID={`voice-phrase-${phrase}`}
                    style={[styles.chip, { backgroundColor: theme.colors.surfaceHover }]}
                  >
                    <Text style={[styles.chipText, { color: theme.colors.text }]}>{phrase}</Text>
                    <Pressable
                      testID={`voice-phrase-remove-${phrase}`}
                      onPress={() => removePhrase.mutate(phrase)}
                      hitSlop={6}
                    >
                      <Icon name="xmark" size={12} color={theme.colors.textSecondary} />
                    </Pressable>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>

          <Pressable
            testID="voice-settings-done"
            onPress={onClose}
            style={[styles.doneButton, { backgroundColor: theme.colors.primary }]}
          >
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    maxHeight: '85%',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 18,
  },
  title: { fontSize: 17, fontWeight: '700', marginBottom: 10 },
  scroll: { flexGrow: 0 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  option: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  languageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 6,
  },
  languageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 6,
  },
  languageCaret: { marginLeft: 'auto', fontSize: 14, fontWeight: '600' },
  optionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  optionLabel: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  privacyTag: { fontSize: 10, fontWeight: '600', marginLeft: 'auto' },
  optionDesc: { fontSize: 12, lineHeight: 16, marginTop: 4, marginLeft: 24 },
  hint: { fontSize: 12, lineHeight: 16, marginBottom: 10 },
  addRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 15,
  },
  addButton: {
    width: 42,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  phrasesLoading: { marginVertical: 16 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 10,
    paddingRight: 8,
    paddingVertical: 6,
    borderRadius: 14,
  },
  chipText: { fontSize: 13 },
  doneButton: {
    marginTop: 14,
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: 'center',
  },
  doneText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
