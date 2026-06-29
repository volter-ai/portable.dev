/**
 * Settings feature barrel. The settings/profile root + its
 * ViewModel, section catalog, native avatar picker, and the
 * individual section screens.
 */
export { SettingsScreen, type SettingsScreenProps } from './SettingsScreen';
export { SettingsConnectPc, type SettingsConnectPcProps } from './SettingsConnectPc';
export { useSettingsViewModel } from './useSettingsViewModel';
export type { SettingsViewModel, SettingsViewModelDeps } from './useSettingsViewModel';
export { SETTINGS_SECTIONS, sectionRoute, filterSections } from './settingsSections';
export type { SettingsSection } from './settingsSections';
export { pickAvatarImage } from './avatarPicker';
export * from './chrome';
// NB: LegalScreen renders via MarkdownText → any TEST importing THIS BARREL must
// mock 'react-native-markdown-display' (the chat-barrel rule).
export { LegalScreen, type LegalDoc, type LegalScreenProps } from './legal/LegalScreen';
