/**
 * FollowUpComposer — the active-chat input (web `ChatInputField` variant='default').
 *
 * The native parity of the web's "same input, different container" model: it reuses
 * the SAME visual body as the home {@link ChatComposer} (the attachment "+",
 * text field, unified mic↔send button, and the agent / permissions /
 * model / effort control row + the shared {@link SelectorSheet} bottom sheets) but
 * with the ACTIVE-CHAT container chrome — docked to the bottom of the transcript: a
 * single top border, top-rounded corners, transparent background, NO shadow (vs the
 * home elevated pill). And, crucially, a DIFFERENT wiring:
 *
 *   - it sends a FOLLOW-UP into the EXISTING chat via the injected {@link onSend}
 *     (ActiveChatScreen passes the offline-queue `send`, so a message survives a
 *     disconnect + auto-flushes on reconnect) — NOT the new-chat creation flow;
 *   - the model / permissions / effort / agent selectors read + write the
 *     PER-CHAT settings (`useChatSettings(chatId)`), persisting via
 *     `PATCH /api/chat/:id/settings` — NOT the global new-chat defaults. Effort is
 *     only offered for models that support it (hidden entirely for Haiku), and only
 *     the levels the current model supports (e.g. no X-High for Sonnet), so the
 *     picker can never send a value the model would reject — like a model change,
 *     it applies starting with the next message (the backend recreates any live
 *     session whose effort no longer matches, same as a model/permissions change);
 *   - a Stop button appears while the run is `running`/`interrupting`
 *     (`claude:interrupt`) — a red strike-through glyph (circle-slash) on a
 *     transparent field that lives in the CONTROL ROW the whole time a run is
 *     processing. The trailing slot is ALWAYS the shared mic↔send control
 *     (same pattern as the home composer: mic until you type, then the holdable
 *     Send widget), so the user can dictate/compose the next message mid-run without
 *     the Stop hijacking the mic slot.
 *
 * There is intentionally NO project-selection trigger / framework strip / intent
 * analysis here — the chat's project is already fixed (the active-chat input omits
 * those home-only affordances).
 */

import {
  DEFAULT_EFFORT_LEVEL,
  EFFORT_LEVELS,
  getSupportedEffortLevels,
  type EffortLevel,
} from '@vgit2/shared/effort';
import { isModelMode, MODELS, MODEL_MODES, type ModelMode } from '@vgit2/shared/models';
import { PERMISSIONS, PERMISSION_MODES, type PermissionMode } from '@vgit2/shared/permissions';
import type { AgentSetup, ChatStatus } from '@vgit2/shared/types';
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { AttachmentBar, type AttachmentBarHandle, type UploadedAttachment } from './attachments';
import {
  AgentAvatar,
  AgentSelectorSheet,
  AttachButton,
  SelectorSheet,
  ShortFormComposer,
  SlashCommandPicker,
  parseSlashQuery,
} from './composer';
import { DEFAULT_AGENT_SETUP } from './useChatComposer';
import { useAgentSetups, useChatCommands } from '../api/hooks';
import type { ChatSettings } from '../state';

import { Icon, useAppTheme } from '../../theme';

type SheetKind = 'model' | 'permissions' | 'agent' | 'effort' | null;

export interface FollowUpComposerProps {
  /** The chat this composer sends follow-ups into. */
  chatId: string;
  /** Fully-resolved per-chat settings (from `useChatSettings`). */
  settings: Required<ChatSettings>;
  /** Persist a per-chat settings change (`useChatSettings.update` → PATCH). */
  onUpdateSettings: (partial: ChatSettings) => void;
  /** Send a follow-up message into the existing chat (offline-queue aware). */
  onSend: (content: string, attachments?: UploadedAttachment[]) => void;
  /** Current run status — surfaces the Stop button while running/interrupting. */
  status?: ChatStatus;
  /** Interrupt the running chat (`claude:interrupt`). */
  onStop?: () => void;
}

/**
 * Imperative handle for the composer. `insertText` pre-fills the input
 * with an AI follow-up action's prompt (`actionType: 'prefill_input'`) so the
 * user can edit before sending.
 */
export interface FollowUpComposerHandle {
  insertText: (text: string) => void;
}

export const FollowUpComposer = forwardRef<FollowUpComposerHandle, FollowUpComposerProps>(
  function FollowUpComposer({ chatId, settings, onUpdateSettings, onSend, status, onStop }, ref) {
    const { theme } = useAppTheme();
    const [text, setText] = useState('');
    const [uploaded, setUploaded] = useState<UploadedAttachment[]>([]);
    const [isUploading, setIsUploading] = useState(false);
    const [sheet, setSheet] = useState<SheetKind>(null);
    const [isFocused, setIsFocused] = useState(false);
    const [attachmentCount, setAttachmentCount] = useState(0);
    // Tap-outside cancels the slash picker without clearing the typed `/…`; any further
    // keystroke re-opens it (reset in the input's onChangeText).
    const [slashDismissed, setSlashDismissed] = useState(false);
    // The send↔voice / dictation-phase plumbing (incl. hiding the TextInput while the voice
    // surface is active) now lives inside the shared ShortFormComposer; it reports its
    // active state back here so the inline attach "+" + the slash picker hide while recording.
    const [voiceActive, setVoiceActive] = useState(false);
    const attachRef = useRef<AttachmentBarHandle>(null);
    const inputRef = useRef<TextInput>(null);

    // Pre-fill the composer for a `prefill_input` action: append the prompt
    // (space-separated when the input is non-empty — the voice-transcription pattern)
    // and focus the field so it expands and the user can edit before sending.
    useImperativeHandle(
      ref,
      () => ({
        insertText: (insert: string) => {
          if (!insert) return;
          setText((current) => (current.trim() ? `${current.trim()} ${insert}` : insert));
          setIsFocused(true);
          inputRef.current?.focus();
        },
      }),
      []
    );

    const agentSetupsQuery = useAgentSetups();
    const agentSetups = useMemo<AgentSetup[]>(() => {
      const fromServer = agentSetupsQuery.data?.agentSetups ?? [];
      const seen = new Set(fromServer.map((s) => s.id));
      return seen.has(DEFAULT_AGENT_SETUP.id) ? fromServer : [DEFAULT_AGENT_SETUP, ...fromServer];
    }, [agentSetupsQuery.data]);

    const currentSetup = agentSetups.find((a) => a.id === settings.agentSetupId) ?? agentSetups[0];
    const permissionColor =
      PERMISSIONS[settings.permissions as PermissionMode]?.color ?? theme.colors.textSecondary;

    // Effort (reasoning depth) is only offered when the chat's current model
    // supports it at all (Haiku doesn't), and only the levels THAT model
    // supports (Sonnet has no 'xhigh') — never let the picker send a value the
    // model would reject.
    const supportedEffortLevels = isModelMode(settings.model)
      ? getSupportedEffortLevels(settings.model as ModelMode)
      : [];
    const effortSupported = supportedEffortLevels.length > 0;
    const effortColor = EFFORT_LEVELS[settings.effort as keyof typeof EFFORT_LEVELS]?.color;

    // Slash-command picker (the "enriched form for slash commands"): the SDK-scoped
    // commands + skills available to this chat's repo.
    const commandsQuery = useChatCommands(chatId);

    const hasText = text.trim().length > 0;
    // Active while the input is a single leading-slash token (the user is choosing a
    // command); hidden once a space starts the arguments or while dictating.
    const slashQuery = parseSlashQuery(text);
    const slashActive = slashQuery !== null && !voiceActive && !slashDismissed;

    // Argument-hint ghost text: once a command is fully typed/selected (`/name ` with no
    // args yet), show its `argument-hint` greyed after the value — hidden while the picker
    // is open (still choosing the name) or once the user starts typing arguments.
    const argHint = useMemo(() => {
      const m = /^\/(\S+)\s*$/.exec(text);
      if (!m) return '';
      const cmd = (commandsQuery.data?.commands ?? []).find((c) => c.name === m[1]);
      if (!cmd?.argumentHint) return '';
      return (text.endsWith(' ') ? '' : ' ') + cmd.argumentHint;
    }, [text, commandsQuery.data]);

    // Insert `/<name> ` and keep focus so the user can add arguments before sending.
    // The trailing space ends the slash token, which dismisses the picker.
    const handlePickCommand = (name: string) => {
      setText(`/${name} `);
      setIsFocused(true);
      inputRef.current?.focus();
    };
    const isRunning = status === 'running' || status === 'interrupting';
    const interrupting = status === 'interrupting';
    // Expand/collapse parity (web `ChatInputField`): collapsed shows the inline "+" +
    // mic; focusing / typing / attaching — or an in-flight run (to surface Stop) —
    // expands the card to reveal the control row, with the "+" relocated to its left.
    const isExpanded = isFocused || hasText || attachmentCount > 0 || isRunning;

    const handleSend = () => {
      const content = text.trim();
      if (!content || isUploading) return;
      const attachments = uploaded.length > 0 ? uploaded : undefined;
      onSend(content, attachments);
      setText('');
      if (attachments) attachRef.current?.clear();
    };

    return (
      <View
        style={[styles.card, { borderTopColor: theme.colors.border }]}
        testID="follow-up-composer"
      >
        {/* Slash-command / skill picker — opens UP as an overlay above this
            bottom-docked input; tap outside to cancel. */}
        {slashActive ? (
          <SlashCommandPicker
            direction="up"
            commands={commandsQuery.data?.commands ?? []}
            query={slashQuery ?? ''}
            loading={commandsQuery.isLoading}
            onSelect={handlePickCommand}
            onDismiss={() => setSlashDismissed(true)}
          />
        ) : null}

        <AttachmentBar
          ref={attachRef}
          onChange={setUploaded}
          onItemCountChange={setAttachmentCount}
          onUploadingChange={setIsUploading}
        />

        <View
          style={[styles.inputRow, isExpanded ? styles.inputRowExpanded : styles.inputRowCollapsed]}
        >
          {/* The shared short-form composer (the SAME widget as the home + repo detail
              pages). The trailing slot is ALWAYS the mic↔send control (mic while
              empty, the holdable Send widget once the user types) — a run in progress no
              longer hijacks this slot, so the user can dictate the next message mid-run.
              The Stop lives in the control row instead (below). */}
          <ShortFormComposer
            value={text}
            onChangeText={(t) => {
              setText(t);
              setSlashDismissed(false);
            }}
            onSubmit={handleSend}
            canSend={hasText && !isUploading}
            disabled={isUploading}
            placeholder="Message..."
            multiline
            inputRef={inputRef}
            inputStyle={styles.input}
            ghostText={slashActive ? undefined : argHint}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            onVoiceActiveChange={setVoiceActive}
            leading={
              !isExpanded ? (
                <AttachButton
                  variant="inline"
                  onPress={() => attachRef.current?.openSourceSheet()}
                />
              ) : null
            }
            inputTestID="active-chat-composer-input"
            sendTestID="active-chat-send"
            voiceTestID="active-chat-voice"
          />
        </View>

        {/* Control row — revealed once the input expands (web parity). */}
        {isExpanded ? (
          <View style={styles.controlRow}>
            <AttachButton variant="row" onPress={() => attachRef.current?.openSourceSheet()} />

            <Pressable
              testID="open-agent-sheet"
              accessibilityRole="button"
              style={styles.control}
              onPress={() => setSheet('agent')}
            >
              <AgentAvatar setup={currentSetup} size={18} />
              <Icon name="chevron-up" size={10} color={theme.colors.textSecondary} />
            </Pressable>

            <Pressable
              testID="open-permissions-sheet"
              accessibilityRole="button"
              style={styles.control}
              onPress={() => setSheet('permissions')}
            >
              <Icon name="shield" size={14} color={permissionColor} />
              <Icon name="chevron-up" size={10} color={theme.colors.textSecondary} />
            </Pressable>

            {/* Effort — hidden entirely when the current model doesn't support it
                (Haiku), rather than shown disabled. */}
            {effortSupported ? (
              <Pressable
                testID="open-effort-sheet"
                accessibilityRole="button"
                style={styles.control}
                onPress={() => setSheet('effort')}
              >
                <Icon name="bolt" size={14} color={effortColor ?? theme.colors.textSecondary} />
                <Icon name="chevron-up" size={10} color={theme.colors.textSecondary} />
              </Pressable>
            ) : null}

            <View style={styles.spacer} />

            {isRunning && onStop ? (
              // The Stop now ALWAYS lives in the control row while a run is
              // processing — the trailing slot is reserved for the mic↔send control so
              // the user can compose/dictate the next message mid-run. A red
              // circle-slash glyph on a transparent field (the glyph IS the button).
              <Pressable
                testID="active-chat-stop"
                accessibilityRole="button"
                accessibilityLabel="Stop"
                accessibilityState={{ disabled: interrupting }}
                style={styles.control}
                disabled={interrupting}
                onPress={onStop}
              >
                <Icon
                  name="circle-slash"
                  size={22}
                  color={interrupting ? theme.colors.textSecondary : theme.colors.error}
                />
              </Pressable>
            ) : null}

            <Pressable
              testID="open-model-sheet"
              accessibilityRole="button"
              style={styles.control}
              onPress={() => setSheet('model')}
            >
              <Icon name="ellipsis" size={18} color={theme.colors.textSecondary} />
            </Pressable>
          </View>
        ) : null}

        {/* Model bottom sheet */}
        <SelectorSheet
          testID="model-sheet"
          visible={sheet === 'model'}
          title="Select Model"
          onClose={() => setSheet(null)}
          options={MODEL_MODES.map((m) => ({ id: m, name: MODELS[m].label }))}
          selectedId={settings.model}
          optionTestIdPrefix="model-option"
          onSelect={(id) => {
            // The new model may not support the currently-selected effort level
            // (e.g. Opus X-High -> Sonnet) — clamp it in the SAME update so the
            // chat never carries a stale, model-incompatible effort value.
            const nextSupported = isModelMode(id) ? getSupportedEffortLevels(id as ModelMode) : [];
            const effortStillSupported = nextSupported.includes(settings.effort as EffortLevel);
            onUpdateSettings({
              model: id,
              ...(nextSupported.length > 0 && !effortStillSupported
                ? {
                    effort: nextSupported.includes(DEFAULT_EFFORT_LEVEL)
                      ? DEFAULT_EFFORT_LEVEL
                      : nextSupported[nextSupported.length - 1],
                  }
                : {}),
            });
            setSheet(null);
          }}
        />

        {/* Permissions bottom sheet */}
        <SelectorSheet
          testID="permissions-sheet"
          visible={sheet === 'permissions'}
          title="Permission Mode"
          onClose={() => setSheet(null)}
          options={PERMISSION_MODES.map((p) => ({
            id: p,
            name: PERMISSIONS[p].label,
            description: PERMISSIONS[p].description,
          }))}
          selectedId={settings.permissions}
          optionTestIdPrefix="permissions-option"
          onSelect={(id) => {
            onUpdateSettings({ permissions: id });
            setSheet(null);
          }}
        />

        {/* Effort bottom sheet — only the levels the current model supports. */}
        <SelectorSheet
          testID="effort-sheet"
          visible={sheet === 'effort'}
          title="Reasoning Effort"
          onClose={() => setSheet(null)}
          options={supportedEffortLevels.map((e) => ({
            id: e,
            name: EFFORT_LEVELS[e].label,
            description: EFFORT_LEVELS[e].description,
          }))}
          selectedId={settings.effort}
          optionTestIdPrefix="effort-option"
          onSelect={(id) => {
            onUpdateSettings({ effort: id });
            setSheet(null);
          }}
        />

        {/* Agent setup bottom sheet — rich, colored options (web `AgentSetupButton`). */}
        <AgentSelectorSheet
          testID="agent-sheet"
          visible={sheet === 'agent'}
          setups={agentSetups}
          selectedId={settings.agentSetupId}
          onSelect={(id) => {
            onUpdateSettings({ agentSetupId: id });
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      </View>
    );
  }
);

const styles = StyleSheet.create({
  // Active-chat container chrome (web variant='default'): docked to the bottom of
  // the transcript — a single top border + top-rounded corners, transparent bg, no
  // shadow (vs the home composer's elevated pill).
  card: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    paddingHorizontal: 8,
    paddingTop: 8,
    gap: 8,
    // The slash picker overlays UPWARD out of the card (bottom:'100%'); allow it to
    // render beyond the card bounds rather than being clipped.
    overflow: 'visible',
  },
  inputRow: { flexDirection: 'row', gap: 8 },
  inputRowCollapsed: { alignItems: 'center' },
  inputRowExpanded: { alignItems: 'flex-end' },
  input: {
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
    minHeight: 24,
    maxHeight: 160,
    paddingHorizontal: 8,
    paddingVertical: 6,
    textAlignVertical: 'top',
  },
  iconButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  control: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    minHeight: 32,
    paddingHorizontal: 4,
  },
  spacer: { flex: 1 },
});
