/**
 * RepoChatInput — the ONE repo "start a chat" input card.
 *
 * The Overview "Work on {repo}…" widget, extracted so every repo surface that
 * starts a chat renders the SAME composer: the shared {@link ShortFormComposer}
 * (a mic while the input is empty, the holdable Send widget once the user
 * types) inside the surface card, with the slash-command picker and the greyed
 * `argument-hint` ghost text. Used by the Overview tab (picker opens DOWN —
 * the input sits at the top of the page) and by the worktree-scoped
 * {@link WorktreeChatComposer} docked at the bottom (picker opens UP over the
 * change list).
 *
 * Owns the draft text and the clear-on-send / restore-on-failure cycle:
 * `onSubmit` receives the message and a REJECTED promise restores the input
 * for a retry (no navigation happened).
 */

import { useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { useAppTheme } from '../../theme';
import { useRepoCommands } from '../api/hooks';
// Direct FILE imports (the sanctioned cross-feature pattern — never the chat barrel).
import { ShortFormComposer } from '../chat/composer/ShortFormComposer';
import { SlashCommandPicker, parseSlashQuery } from '../chat/composer/SlashCommandPicker';

export interface RepoChatInputProps {
  /** Repo coordinates — scope the slash-command / skill catalog. */
  owner: string;
  repo: string;
  /** Placeholder shown in the empty field. */
  placeholder: string;
  /** External send gate (socket ready / not already sending) — ANDed with text presence. */
  canSend: boolean;
  /**
   * Perform the hand-off. The input clears immediately; a rejection restores
   * it for a retry (the caller must NOT swallow failures).
   */
  onSubmit: (message: string) => Promise<void> | void;
  /** Which way the slash-command picker opens (top-of-page input = 'down', docked footer = 'up'). */
  direction: 'up' | 'down';
  /** testIDs (preserved per call-site so existing contracts hold). */
  inputTestID: string;
  sendTestID: string;
  voiceTestID: string;
}

export function RepoChatInput({
  owner,
  repo,
  placeholder,
  canSend,
  onSubmit,
  direction,
  inputTestID,
  sendTestID,
  voiceTestID,
}: RepoChatInputProps) {
  const { theme } = useAppTheme();
  const [text, setText] = useState('');
  const [slashDismissed, setSlashDismissed] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const sendAllowed = canSend && text.trim().length > 0;

  // Slash-command / skill picker — loaded for the repo so the commands are present
  // in this initial window (before any chat exists). Active while typing `/…`.
  const commandsQuery = useRepoCommands(owner, repo);
  const slashQuery = parseSlashQuery(text);
  const slashActive = slashQuery !== null && !slashDismissed;

  // Argument-hint ghost text: once a command is fully typed/selected (`/name `), show its
  // `argument-hint` greyed after the value — hidden while the picker is still open.
  const argHint = (() => {
    const m = /^\/(\S+)\s*$/.exec(text);
    if (!m) return '';
    const cmd = (commandsQuery.data?.commands ?? []).find((c) => c.name === m[1]);
    if (!cmd?.argumentHint) return '';
    return (text.endsWith(' ') ? '' : ' ') + cmd.argumentHint;
  })();

  const send = () => {
    if (!sendAllowed) return;
    const message = text;
    setText('');
    void Promise.resolve(onSubmit(message)).catch(() => setText(message));
  };

  // Insert `/<name> ` and keep focus so the user can add arguments before sending.
  const pickCommand = (name: string) => {
    setText(`/${name} `);
    inputRef.current?.focus();
  };

  // `zIndex` floats the overlay (+ its dropdown) above the sibling sections; the
  // picker itself is absolute, so it never reflows them.
  return (
    <View style={styles.wrap}>
      {slashActive ? (
        <SlashCommandPicker
          direction={direction}
          commands={commandsQuery.data?.commands ?? []}
          query={slashQuery ?? ''}
          loading={commandsQuery.isLoading}
          onSelect={pickCommand}
          onDismiss={() => setSlashDismissed(true)}
        />
      ) : null}
      <View style={[styles.inputCard, { backgroundColor: theme.colors.surface }, theme.shadows.sm]}>
        <ShortFormComposer
          value={text}
          onChangeText={(t) => {
            setText(t);
            setSlashDismissed(false);
          }}
          onSubmit={send}
          canSend={sendAllowed}
          placeholder={placeholder}
          inputRef={inputRef}
          inputStyle={styles.input}
          ghostText={slashActive ? undefined : argHint}
          inputTestID={inputTestID}
          sendTestID={sendTestID}
          voiceTestID={voiceTestID}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { zIndex: 1000 },
  inputCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    paddingVertical: 8,
    paddingLeft: 14,
    paddingRight: 8,
  },
  input: { flex: 1, fontSize: 15, paddingVertical: 6 },
});
