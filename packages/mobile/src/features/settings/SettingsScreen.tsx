/**
 * Settings / profile root screen: header with back + centered "Profile" title +
 * "Search settings..." bar, the compact profile card (36px avatar → photo action
 * sheet, name, `@login`, `⋯` menu with Logout), the searchable section list, the
 * centered ToS/Privacy footer links, and the Danger Zone with the INLINE
 * delete-account confirmation.
 *
 * Logic lives in `useSettingsViewModel`; this is a thin view. All seams are
 * forwarded so tests can mount it with injected picker / delete / navigate.
 */

import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { useWindowInsets } from '../shell/windowInsets';
import { Icon, useAppTheme, withAlpha } from '../../theme';
import { SettingsConnectPc, type SettingsConnectPcProps } from './SettingsConnectPc';
import { useSettingsViewModel, type SettingsViewModelDeps } from './useSettingsViewModel';

export interface SettingsScreenProps extends SettingsViewModelDeps {
  /** Seams forwarded to the always-on "Connect PC" entry (tests). */
  connectPc?: SettingsConnectPcProps;
}

export function SettingsScreen({ connectPc, ...props }: SettingsScreenProps = {}) {
  const vm = useSettingsViewModel(props);
  const insets = useSafeAreaInsets();
  // The ⋯ menu lives in a transparent full-window Modal, which escapes any
  // in-flow safe-area override — position it by the WINDOW insets, not the
  // (possibly zeroed) ambient ones (see src/features/shell/windowInsets.tsx).
  const windowInsets = useWindowInsets();
  const { theme } = useAppTheme();

  const hasQuery = vm.searchQuery.trim().length > 0;

  return (
    <View
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      testID="settings-screen"
    >
      {/* ── Header: back + centered title + search ── */}
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, borderBottomColor: theme.colors.border },
        ]}
      >
        <View style={styles.headerRow}>
          <Pressable
            testID="settings-back"
            accessibilityRole="button"
            hitSlop={8}
            style={styles.headerButton}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          >
            <Icon name="chevron-left" size={20} color={theme.colors.textSecondary} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Profile</Text>
          <View style={styles.headerButton} />
        </View>
        <View style={[styles.searchBox, { borderColor: theme.colors.border }]}>
          <Icon name="search" size={14} color={theme.colors.textSecondary} />
          <TextInput
            testID="settings-search"
            style={[styles.searchInput, { color: theme.colors.text }]}
            placeholder="Search settings..."
            placeholderTextColor={theme.colors.textTertiary}
            value={vm.searchQuery}
            onChangeText={vm.setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {hasQuery && (
            <Pressable
              testID="settings-search-clear"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => vm.setSearchQuery('')}
            >
              <Icon name="xmark" size={14} color={theme.colors.textSecondary} />
            </Pressable>
          )}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Profile card ── */}
        <View style={[styles.profileCard, { backgroundColor: theme.colors.surface }]}>
          <Pressable
            testID="settings-avatar"
            accessibilityRole="button"
            onPress={vm.openAvatarSheet}
            disabled={vm.photoBusy}
          >
            {vm.avatarUrl ? (
              <Image
                testID="settings-avatar-image"
                source={{ uri: vm.avatarUrl }}
                style={[styles.avatar, { backgroundColor: theme.colors.surfaceHover }]}
              />
            ) : (
              <View
                testID="settings-avatar-placeholder"
                style={[
                  styles.avatar,
                  styles.avatarEmpty,
                  { backgroundColor: theme.colors.primary },
                ]}
              >
                <Text style={[styles.avatarInitial, { color: '#fff' }]}>
                  {(vm.displayName || '?').slice(0, 1).toUpperCase()}
                </Text>
              </View>
            )}
            {vm.photoBusy && (
              <View style={styles.avatarBusyOverlay}>
                <ActivityIndicator testID="settings-avatar-busy" color="#fff" size="small" />
              </View>
            )}
          </Pressable>

          <View style={styles.profileText}>
            <View style={styles.nameRow}>
              <Text
                style={[styles.name, { color: theme.colors.text }]}
                numberOfLines={1}
                testID="settings-name"
              >
                {vm.displayName}
              </Text>
            </View>
            <Text
              style={[styles.handle, { color: theme.colors.textTertiary }]}
              numberOfLines={1}
              testID="settings-email"
            >
              @{vm.login || vm.email}
            </Text>
          </View>

          <Pressable
            testID="settings-menu"
            accessibilityRole="button"
            hitSlop={8}
            onPress={vm.openMenu}
          >
            <Icon name="ellipsis" size={18} color={theme.colors.textSecondary} />
          </Pressable>
        </View>
        {vm.photoError && (
          <Text
            testID="settings-avatar-error"
            style={[styles.error, { color: theme.colors.error }]}
          >
            {vm.photoError}
          </Text>
        )}

        {/* ── Connect PC (always-on re-pair / scan-QR entry) ── */}
        {!hasQuery && (
          <SettingsConnectPc getPcId={connectPc?.getPcId} pcConnect={connectPc?.pcConnect} />
        )}

        {/* ── Section list ── */}
        <View style={styles.sections}>
          {vm.sections.map((section) => (
            <Pressable
              key={section.key}
              testID={`settings-section-${section.key}`}
              accessibilityRole="button"
              style={[styles.sectionRow, { backgroundColor: theme.colors.surface }]}
              onPress={() => vm.openSection(section.route)}
            >
              <View style={styles.sectionTextWrap}>
                <Text style={[styles.sectionLabel, { color: theme.colors.text }]}>
                  {section.label}
                </Text>
                <Text style={[styles.sectionDescription, { color: theme.colors.textTertiary }]}>
                  {section.description}
                </Text>
              </View>
              <Text style={[styles.chevron, { color: theme.colors.textTertiary }]}>›</Text>
            </Pressable>
          ))}
          {hasQuery && vm.sections.length === 0 && (
            <Text
              testID="settings-search-empty"
              style={[styles.noResults, { color: theme.colors.textTertiary }]}
            >
              No settings found for "{vm.searchQuery}"
            </Text>
          )}
        </View>

        {/* ── Developer (hidden 10-tap dev mode only) ── */}
        {vm.devModeEnabled && !hasQuery && (
          <View style={styles.sections}>
            <Text style={[styles.dangerLabel, { color: theme.colors.textTertiary }]}>
              Developer
            </Text>
            <Pressable
              testID="settings-dev-sentry-test"
              accessibilityRole="button"
              style={[styles.sectionRow, { backgroundColor: theme.colors.surface }]}
              onPress={() => vm.openSection('/settings/sentry-test')}
            >
              <View style={styles.sectionTextWrap}>
                <Text style={[styles.sectionLabel, { color: theme.colors.text }]}>Sentry Test</Text>
                <Text style={[styles.sectionDescription, { color: theme.colors.textTertiary }]}>
                  Send a test exception to verify error reporting
                </Text>
              </View>
              <Text style={[styles.chevron, { color: theme.colors.textTertiary }]}>›</Text>
            </Pressable>
          </View>
        )}

        {!hasQuery && (
          <>
            {/* ── Legal links (footer) ── */}
            <View style={styles.legalRow}>
              <Pressable
                testID="settings-legal-tos-link"
                accessibilityRole="button"
                onPress={() => vm.openLegal('tos')}
              >
                <Text style={[styles.legalText, { color: theme.colors.textTertiary }]}>
                  Terms of Service
                </Text>
              </Pressable>
              <Pressable
                testID="settings-legal-privacy-link"
                accessibilityRole="button"
                onPress={() => vm.openLegal('privacy')}
              >
                <Text style={[styles.legalText, { color: theme.colors.textTertiary }]}>
                  Privacy Policy
                </Text>
              </Pressable>
            </View>

            {/* ── Danger zone (inline confirm) ── */}
            <View style={styles.dangerZone}>
              <Text style={[styles.dangerLabel, { color: theme.colors.textTertiary }]}>
                Danger Zone
              </Text>
              {!vm.deleteVisible ? (
                <Pressable
                  testID="settings-delete-account"
                  accessibilityRole="button"
                  style={[
                    styles.deleteButton,
                    { borderColor: withAlpha(theme.colors.error, '4D') },
                  ]}
                  onPress={vm.openDeleteConfirm}
                >
                  <Text style={[styles.deleteButtonText, { color: theme.colors.error }]}>
                    Delete Account
                  </Text>
                </Pressable>
              ) : (
                <View
                  testID="settings-delete-confirm-panel"
                  style={[styles.deletePanel, { borderColor: withAlpha(theme.colors.error, '4D') }]}
                >
                  <Text style={[styles.deleteWarning, { color: theme.colors.error }]}>
                    This action is permanent and cannot be undone. All your data will be lost.
                  </Text>
                  <TextInput
                    testID="settings-delete-email-input"
                    style={[
                      styles.input,
                      {
                        borderColor: theme.colors.border,
                        color: theme.colors.text,
                        backgroundColor: theme.colors.background,
                      },
                    ]}
                    placeholder="Type your email to confirm"
                    placeholderTextColor={theme.colors.textTertiary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    value={vm.confirmEmail}
                    editable={!vm.isDeleting}
                    onChangeText={vm.setConfirmEmail}
                  />
                  {vm.deleteError && (
                    <Text
                      testID="settings-delete-error"
                      style={[
                        styles.deleteErrorBox,
                        {
                          color: theme.colors.error,
                          backgroundColor: withAlpha(theme.colors.error, '1A'),
                        },
                      ]}
                    >
                      {vm.deleteError}
                    </Text>
                  )}
                  <View style={styles.deleteActions}>
                    <Pressable
                      testID="settings-delete-cancel"
                      accessibilityRole="button"
                      style={[
                        styles.deleteActionButton,
                        { borderColor: theme.colors.border, borderWidth: 1 },
                      ]}
                      disabled={vm.isDeleting}
                      onPress={vm.cancelDelete}
                    >
                      <Text style={{ color: theme.colors.textSecondary, fontWeight: '600' }}>
                        Cancel
                      </Text>
                    </Pressable>
                    <Pressable
                      testID="settings-delete-confirm"
                      accessibilityRole="button"
                      style={[
                        styles.deleteActionButton,
                        {
                          backgroundColor:
                            vm.emailMatches && !vm.isDeleting
                              ? theme.colors.error
                              : withAlpha(theme.colors.error, '4D'),
                        },
                      ]}
                      disabled={!vm.emailMatches || vm.isDeleting}
                      onPress={() => {
                        void vm.confirmDelete();
                      }}
                    >
                      {vm.isDeleting ? (
                        <ActivityIndicator color="#fff" testID="settings-delete-busy" />
                      ) : (
                        <Text style={{ color: '#fff', fontWeight: '600' }}>Delete Account</Text>
                      )}
                    </Pressable>
                  </View>
                </View>
              )}
            </View>
          </>
        )}
      </ScrollView>

      {/* ── ⋯ user menu (dropdown: Logout) ── */}
      {vm.menuVisible && (
        <Modal transparent animationType="fade" visible onRequestClose={vm.closeMenu}>
          <Pressable style={styles.menuBackdrop} onPress={vm.closeMenu}>
            <View
              style={[
                styles.menuCard,
                {
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.border,
                  marginTop: windowInsets.top + 96,
                },
              ]}
              testID="settings-menu-dropdown"
            >
              <Pressable
                testID="settings-sign-out"
                accessibilityRole="button"
                style={styles.menuItem}
                onPress={() => {
                  void vm.signOut();
                }}
              >
                <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>Logout</Text>
              </Pressable>
            </View>
          </Pressable>
        </Modal>
      )}

      {/* ── Avatar action sheet ──
          Kept MOUNTED with `visible` (RN Modal renders null when hidden, so
          queryByTestId stays deterministic) because `onDismiss` must fire
          after the iOS dismissal animation — the native image picker is only
          presented then (presenting mid-dismissal is the classic UIKit
          "view is not in the window hierarchy" race). */}
      <Modal
        transparent
        animationType="slide"
        visible={vm.avatarSheetVisible}
        onRequestClose={vm.closeAvatarSheet}
        onDismiss={vm.handleAvatarSheetDismissed}
      >
        <Pressable style={styles.sheetBackdrop} onPress={vm.closeAvatarSheet}>
          <View
            style={[styles.sheetCard, { backgroundColor: theme.colors.surface }]}
            testID="settings-avatar-sheet"
          >
            <Text style={[styles.sheetTitle, { color: theme.colors.text }]}>Profile photo</Text>
            <Pressable
              testID="settings-avatar-change"
              accessibilityRole="button"
              style={[styles.sheetItem, { backgroundColor: theme.colors.surfaceHover }]}
              onPress={vm.requestPhotoPick}
            >
              <Text style={{ color: theme.colors.text, fontWeight: '600' }}>Choose photo</Text>
            </Pressable>
            {vm.avatarUrl && (
              <Pressable
                testID="settings-avatar-remove"
                accessibilityRole="button"
                style={[styles.sheetItem, { backgroundColor: theme.colors.surfaceHover }]}
                onPress={() => {
                  void vm.removePhoto();
                }}
              >
                <Text style={{ color: theme.colors.error, fontWeight: '600' }}>Remove photo</Text>
              </Pressable>
            )}
            <Pressable
              testID="settings-avatar-sheet-cancel"
              accessibilityRole="button"
              style={styles.sheetItem}
              onPress={vm.closeAvatarSheet}
            >
              <Text style={{ color: theme.colors.textSecondary, fontWeight: '600' }}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerButton: { width: 32, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 14, fontWeight: '500' },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    minHeight: 40,
  },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 8 },
  content: { padding: 16, gap: 12 },

  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 8,
    borderRadius: 8,
  },
  avatar: { width: 36, height: 36, borderRadius: 18 },
  avatarEmpty: { alignItems: 'center', justifyContent: 'center' },
  avatarInitial: { fontSize: 16, fontWeight: '600' },
  avatarBusyOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileText: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  handle: { fontSize: 12, marginTop: 1 },

  sections: { gap: 4 },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    gap: 8,
  },
  sectionTextWrap: { flex: 1 },
  sectionLabel: { fontSize: 13, fontWeight: '600' },
  sectionDescription: { fontSize: 12, marginTop: 2 },
  chevron: { fontSize: 16, paddingTop: 2 },
  noResults: { textAlign: 'center', paddingVertical: 32, fontSize: 13 },

  legalRow: { flexDirection: 'row', justifyContent: 'center', gap: 16, paddingVertical: 8 },
  legalText: { fontSize: 12 },

  dangerZone: { marginTop: 12, gap: 8 },
  dangerLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  deleteButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  deleteButtonText: { fontSize: 13, fontWeight: '500' },
  deletePanel: { borderWidth: 1, borderRadius: 8, padding: 12, gap: 8 },
  deleteWarning: { fontSize: 12, lineHeight: 17 },
  input: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  deleteErrorBox: {
    fontSize: 12,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 6,
    overflow: 'hidden',
  },
  deleteActions: { flexDirection: 'row', gap: 8 },
  deleteActionButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 6,
  },
  error: { fontSize: 13 },

  menuBackdrop: { flex: 1, alignItems: 'flex-end', paddingRight: 16 },
  menuCard: {
    minWidth: 120,
    borderWidth: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  menuItem: { paddingVertical: 10, paddingHorizontal: 12 },

  sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheetCard: {
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    padding: 16,
    paddingBottom: 32,
    gap: 8,
  },
  sheetTitle: { fontSize: 15, fontWeight: '700', marginBottom: 4 },
  sheetItem: { borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
});
