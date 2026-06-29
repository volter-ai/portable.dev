/**
 * SelectorSheet — the shared bottom-sheet option picker used by BOTH composers
 * (the home {@link ChatComposer} new-chat input and the active-chat
 * {@link FollowUpComposer}). A slide-up `Modal` with a title and a scrollable
 * list of selectable options (name + optional description + a ✓ on the current
 * one). Extracted from the original ChatComposer so the model /
 * permissions / agent pickers look identical in both contexts (home + active chat).
 *
 * Optionally `searchable`: a search box above the list filters the
 * options by case-insensitive substring of `name`/`id` — turning the static
 * select into a type-to-filter autocomplete for long lists (e.g. the Tasks repo
 * picker). Off by default, so every existing selector renders identically.
 */

import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAppTheme } from '../../../theme';

/** A selectable option (id + display name + optional description). */
export interface SelectorOption {
  id: string;
  name: string;
  description?: string;
}

export interface SelectorSheetProps {
  testID: string;
  visible: boolean;
  title: string;
  options: SelectorOption[];
  selectedId: string;
  optionTestIdPrefix: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** Show a type-to-filter search box above the list. */
  searchable?: boolean;
  /** Placeholder for the search box (when `searchable`). */
  searchPlaceholder?: string;
}

export function SelectorSheet(props: SelectorSheetProps) {
  const { theme } = useAppTheme();
  const [search, setSearch] = useState('');
  // Start every reopen with a clean search (the sheet returns null while
  // hidden but stays mounted, so the query would otherwise persist).
  useEffect(() => {
    if (!props.visible) setSearch('');
  }, [props.visible]);

  if (!props.visible) return null;

  const query = props.searchable ? search.trim().toLowerCase() : '';
  const visibleOptions = query
    ? props.options.filter(
        (opt) => opt.name.toLowerCase().includes(query) || opt.id.toLowerCase().includes(query)
      )
    : props.options;

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={props.onClose}
      testID={props.testID}
    >
      <Pressable
        style={styles.sheetBackdrop}
        onPress={props.onClose}
        testID={`${props.testID}-backdrop`}
      />
      <View style={[styles.sheet, { backgroundColor: theme.colors.backgroundElevated }]}>
        <Text style={[styles.sheetTitle, { color: theme.colors.text }]}>{props.title}</Text>
        {props.searchable ? (
          <TextInput
            testID={`${props.testID}-search`}
            style={[
              styles.sheetSearch,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                color: theme.colors.text,
              },
            ]}
            placeholder={props.searchPlaceholder ?? 'Search…'}
            placeholderTextColor={theme.colors.textTertiary}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
          />
        ) : null}
        <ScrollView keyboardShouldPersistTaps="handled">
          {query && visibleOptions.length === 0 ? (
            <Text
              testID={`${props.testID}-empty`}
              style={[styles.sheetEmpty, { color: theme.colors.textTertiary }]}
            >
              No matches
            </Text>
          ) : null}
          {visibleOptions.map((opt) => {
            const selected = opt.id === props.selectedId;
            return (
              <Pressable
                key={opt.id}
                testID={`${props.optionTestIdPrefix}-${opt.id}`}
                style={[styles.sheetOption, selected && { backgroundColor: theme.colors.hover }]}
                onPress={() => props.onSelect(opt.id)}
              >
                <View style={styles.sheetOptionMain}>
                  <Text
                    style={[
                      styles.sheetOptionText,
                      { color: theme.colors.text, fontWeight: selected ? '600' : '400' },
                    ]}
                  >
                    {opt.name}
                  </Text>
                  {opt.description ? (
                    <Text
                      style={[styles.sheetOptionDesc, { color: theme.colors.textSecondary }]}
                      numberOfLines={2}
                    >
                      {opt.description}
                    </Text>
                  ) : null}
                </View>
                {selected ? (
                  <Text style={[styles.sheetOptionCheck, { color: theme.colors.primary }]}>✓</Text>
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    gap: 8,
    maxHeight: '60%',
  },
  sheetTitle: { fontSize: 18, fontWeight: '700', marginBottom: 4 },
  sheetSearch: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  sheetEmpty: { fontSize: 13, paddingVertical: 16, textAlign: 'center' },
  sheetOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 12,
  },
  sheetOptionMain: { flex: 1, gap: 4 },
  sheetOptionText: { fontSize: 16 },
  sheetOptionDesc: { fontSize: 12, lineHeight: 16 },
  sheetOptionCheck: { fontSize: 16, fontWeight: '700' },
});
