/**
 * Shared composer presentational kit — the bottom-sheet option picker reused by
 * both the home {@link ChatComposer} (new chat) and the active-chat
 * {@link FollowUpComposer} (follow-up send), mirroring the web's single
 * `ChatInputField` rendering the same selectors in both contexts.
 */

export { SelectorSheet, type SelectorOption, type SelectorSheetProps } from './SelectorSheet';
export { AttachButton, type AttachButtonProps } from './AttachButton';
export {
  AgentSelectorSheet,
  AgentAvatar,
  type AgentSelectorSheetProps,
} from './AgentSelectorSheet';
export { InputActionButton, type InputActionButtonProps } from './InputActionButton';
export { ShortFormComposer, type ShortFormComposerProps } from './ShortFormComposer';
export {
  SlashCommandPicker,
  parseSlashQuery,
  type SlashCommandPickerProps,
} from './SlashCommandPicker';
