/**
 * ChatComposer — the native new-chat input surface:
 *
 *   - a project-selection trigger (Auto detect / New project / recent repo) above
 *   - a rounded, elevated input card holding the text field, the attachment "+",
 *     and a unified mic↔send button, with a bottom control row (agent setup,
 *     permission mode, and the model "more" button)
 *   - a horizontal framework-pill strip shown while creating a new project
 *
 * All logic stays in {@link useChatComposer}: drafts auto-save (debounced) to MMKV,
 * the model/permissions/agentSetup selectors persist to the new-chat
 * preferences, and submitting runs the `createNewChat` / `chat:create` flow (intent
 * analysis OR the explicit project selection → project creation → first message).
 */

import { MODELS, MODEL_MODES, type ModelMode } from '@vgit2/shared/models';
import { PERMISSIONS, PERMISSION_MODES, type PermissionMode } from '@vgit2/shared/permissions';
import { type ReactNode, useRef, useState } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AttachmentBar, type AttachmentBarHandle, type UploadedAttachment } from './attachments';
import {
  AgentAvatar,
  AgentSelectorSheet,
  AttachButton,
  SelectorSheet,
  ShortFormComposer,
} from './composer';
import { useBottomInset } from './composer/useBottomInset';
import { faviconUrl, HOME_FRAMEWORKS } from './frameworks';
import { ProjectCreationOverlay } from './ProjectCreationOverlay';
import { useRecentProjects } from '../api/hooks';
import {
  useChatComposer,
  type ProjectSelection,
  type UseChatComposerOptions,
} from './useChatComposer';

import { Icon, useAppTheme } from '../../theme';

export interface ChatComposerProps extends UseChatComposerOptions {
  /**
   * Optional content rendered on the RIGHT of the project-trigger row. The home
   * screen passes its profile pill here so it sits on the same line as the
   * "Auto detect" selector instead of floating in dead space above the composer.
   */
  headerRight?: ReactNode;
}

type SheetKind = 'model' | 'permissions' | 'agent' | 'project' | null;

export function ChatComposer({ headerRight, ...props }: ChatComposerProps) {
  const composer = useChatComposer(props);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const { theme } = useAppTheme();

  // Recent projects feed the project-selection sheet; fetched only while open.
  const recentProjectsQuery = useRecentProjects(10, { enabled: sheet === 'project' });
  const recentProjects = recentProjectsQuery.data?.projects ?? [];

  // Expand/collapse: collapsed (empty + unfocused +
  // no attachments) shows just the inline "+" beside the placeholder and the mic;
  // focusing / typing / attaching expands the card to reveal the control row, where
  // the "+" relocates to the left. The attachment count comes from AttachmentBar.
  const [isFocused, setIsFocused] = useState(false);
  const [attachmentCount, setAttachmentCount] = useState(0);
  // Successfully-uploaded attachments — ride the first message as `files`;
  // the bar is cleared after a successful submit.
  const [uploaded, setUploaded] = useState<UploadedAttachment[]>([]);
  // The send↔voice / dictation-phase plumbing (incl. hiding the TextInput while the voice
  // surface is active) now lives inside the shared ShortFormComposer.
  const attachRef = useRef<AttachmentBarHandle>(null);

  const currentSetup =
    composer.agentSetups.find((a) => a.id === composer.settings.agentSetupId) ??
    composer.agentSetups[0];
  const permissionColor =
    PERMISSIONS[composer.settings.permissions as PermissionMode]?.color ??
    theme.colors.textSecondary;

  const hasText = composer.text.trim().length > 0;
  const isExpanded = isFocused || hasText || attachmentCount > 0;
  const placeholder =
    composer.framework && composer.projectSelection.type === 'new-project'
      ? `Build with ${composer.framework}...`
      : composer.projectSelection.type === 'existing-project'
        ? `Work on ${composer.projectSelection.repo}...`
        : 'Work on anything';

  return (
    <View style={styles.container} testID="chat-composer">
      {/* Header row above the card: the project-selection trigger (Auto detect /
          New project / recent repo), the default-permissions trigger, and the
          default-model trigger on the left, an optional slot (the home profile
          pill) on the right — same baseline, so the pill doesn't float in dead
          space. */}
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Pressable
            testID="composer-project-trigger"
            accessibilityRole="button"
            style={styles.projectTrigger}
            onPress={() => setSheet('project')}
          >
            <ProjectTriggerContent
              selection={composer.projectSelection}
              color={theme.colors.textTertiary}
            />
            <Icon name="chevron-down" size={10} color={theme.colors.textTertiary} />
          </Pressable>

          {/* Default-permissions trigger: sets the permission every NEW chat inherits
              (a chat already sticky to its own permission wins over this default — see
              `resolveNewChatSettings`). Always visible (unlike the identical picker
              hidden in the control row below) so the active default is visible at a
              glance without expanding the composer. */}
          <Pressable
            testID="composer-permissions-trigger"
            accessibilityRole="button"
            accessibilityLabel={`Default permission: ${PERMISSIONS[composer.settings.permissions as PermissionMode]?.label ?? composer.settings.permissions}`}
            style={[styles.projectTrigger, styles.permissionsTrigger]}
            onPress={() => setSheet('permissions')}
          >
            <Icon name="shield" size={14} color={permissionColor} />
            <Text
              style={[styles.projectTriggerText, { color: theme.colors.textTertiary }]}
              numberOfLines={1}
            >
              {PERMISSIONS[composer.settings.permissions as PermissionMode]?.label ??
                composer.settings.permissions}
            </Text>
            <Icon name="chevron-down" size={10} color={theme.colors.textTertiary} />
          </Pressable>

          {/* Default-model trigger: sets the model every NEW chat inherits (same
              store + sheet as the control-row "more" button — one picker, two entry
              points). Plain label + chevron, deliberately NO icon: an icon here
              reads as the Agents control. */}
          <Pressable
            testID="composer-model-trigger"
            accessibilityRole="button"
            accessibilityLabel={`Default model: ${MODELS[composer.settings.model as ModelMode]?.label ?? composer.settings.model}`}
            style={[styles.projectTrigger, styles.modelTrigger]}
            onPress={() => setSheet('model')}
          >
            <Text
              style={[styles.projectTriggerText, { color: theme.colors.textTertiary }]}
              numberOfLines={1}
            >
              {MODELS[composer.settings.model as ModelMode]?.label ?? composer.settings.model}
            </Text>
            <Icon name="chevron-down" size={10} color={theme.colors.textTertiary} />
          </Pressable>
        </View>
        {headerRight ? <View style={styles.headerRight}>{headerRight}</View> : null}
      </View>

      {/* The elevated input card */}
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.backgroundElevated,
            borderColor: theme.colors.borderLight,
          },
          theme.shadows.lg,
        ]}
      >
        <AttachmentBar
          ref={attachRef}
          onChange={setUploaded}
          onItemCountChange={setAttachmentCount}
        />

        <View
          style={[styles.inputRow, isExpanded ? styles.inputRowExpanded : styles.inputRowCollapsed]}
        >
          {/* The shared short-form composer (the SAME widget as the repo detail page): the
              inline attach "+" (collapsed only) rides as the leading slot; the text field +
              the unified mic↔send button + the headless voice surface come from the kit. */}
          <ShortFormComposer
            value={composer.text}
            onChangeText={composer.setText}
            onSubmit={() => {
              void composer.submit(uploaded.map((a) => a.response)).then((ok) => {
                // Attachments rode the sent message — empty the strip (web
                // `clearFiles` parity). A failed submit keeps them attached.
                if (ok) attachRef.current?.clear();
              });
            }}
            canSend={composer.canSubmit}
            placeholder={placeholder}
            multiline
            inputStyle={styles.input}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            leading={
              !isExpanded ? (
                <AttachButton
                  variant="inline"
                  onPress={() => attachRef.current?.openSourceSheet()}
                />
              ) : null
            }
            inputTestID="chat-composer-input"
            sendTestID="chat-composer-send"
            voiceTestID="chat-composer-voice"
          />
        </View>

        {/* Bottom control row — revealed once the input expands (web parity). */}
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

            <View style={styles.spacer} />

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
      </View>

      {/* Framework pills — shown while building a new project */}
      {composer.projectSelection.type === 'new-project' ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.frameworkRow}
          testID="composer-frameworks"
        >
          {HOME_FRAMEWORKS.map((fw) => {
            const selected = composer.framework === fw.id;
            return (
              <Pressable
                key={fw.id}
                testID={`framework-pill-${fw.id}`}
                onPress={() => composer.setFramework(selected ? null : fw.id)}
                style={[
                  styles.frameworkPill,
                  { backgroundColor: selected ? theme.colors.primary : theme.colors.surface },
                ]}
              >
                {fw.url ? (
                  <Image
                    source={{ uri: faviconUrl(fw.url) }}
                    style={[styles.frameworkIcon, { opacity: selected ? 1 : 0.8 }]}
                  />
                ) : null}
                <Text
                  style={[
                    styles.frameworkLabel,
                    { color: selected ? '#FFFFFF' : theme.colors.textSecondary },
                  ]}
                >
                  {fw.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {composer.error ? (
        <Text testID="chat-composer-error" style={[styles.error, { color: theme.colors.error }]}>
          {composer.error}
        </Text>
      ) : null}

      {/* Full-screen creation animation while the submit flow runs (web
          `ProjectCreationModal` parity) — mounted per session so its animation
          values start fresh every time. */}
      {composer.creation ? <ProjectCreationOverlay status={composer.creation} /> : null}

      {/* Model bottom sheet */}
      <SelectorSheet
        testID="model-sheet"
        visible={sheet === 'model'}
        title="Select Model"
        onClose={() => setSheet(null)}
        options={MODEL_MODES.map((m) => ({ id: m, name: MODELS[m].label }))}
        selectedId={composer.settings.model}
        optionTestIdPrefix="model-option"
        onSelect={(id) => {
          composer.setModel(id);
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
        selectedId={composer.settings.permissions}
        optionTestIdPrefix="permissions-option"
        onSelect={(id) => {
          composer.setPermissions(id);
          setSheet(null);
        }}
      />

      {/* Agent setup bottom sheet — rich, colored options (web `AgentSetupButton`). */}
      <AgentSelectorSheet
        testID="agent-sheet"
        visible={sheet === 'agent'}
        setups={composer.agentSetups}
        selectedId={composer.settings.agentSetupId}
        onSelect={(id) => {
          composer.setAgentSetupId(id);
          setSheet(null);
        }}
        onClose={() => setSheet(null)}
      />

      {/* Project selection bottom sheet */}
      <ProjectSheet
        visible={sheet === 'project'}
        selection={composer.projectSelection}
        recentProjects={recentProjects}
        loading={recentProjectsQuery.isLoading}
        onClose={() => setSheet(null)}
        onSelect={(selection) => {
          composer.setProjectSelection(selection);
          if (selection.type !== 'new-project') composer.setFramework(null);
          setSheet(null);
        }}
      />
    </View>
  );
}

function ProjectTriggerContent({
  selection,
  color,
}: {
  selection: ProjectSelection;
  color: string;
}) {
  if (selection.type === 'new-project') {
    return (
      <View style={styles.projectTriggerInner}>
        <Icon name="plus" size={14} color={color} />
        <Text style={[styles.projectTriggerText, { color }]}>New project</Text>
      </View>
    );
  }
  if (selection.type === 'existing-project') {
    return (
      <View style={styles.projectTriggerInner}>
        <Image
          source={{ uri: `https://github.com/${selection.owner}.png?size=64` }}
          style={styles.projectTriggerAvatar}
        />
        <Text style={[styles.projectTriggerText, { color }]} numberOfLines={1}>
          {selection.repo}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.projectTriggerInner}>
      <Icon name="bolt" size={14} color={color} />
      <Text style={[styles.projectTriggerText, { color }]}>Auto detect</Text>
    </View>
  );
}

/** A recent local project (web `RecentProject`: name/path/owner). */
interface RecentProjectItem {
  name: string;
  path: string;
  owner: string | null;
}

function ProjectSheet(props: {
  visible: boolean;
  selection: ProjectSelection;
  recentProjects: RecentProjectItem[];
  loading: boolean;
  onClose: () => void;
  onSelect: (selection: ProjectSelection) => void;
}) {
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
      testID="project-sheet"
    >
      <Pressable
        style={styles.sheetBackdrop}
        onPress={props.onClose}
        testID="project-sheet-backdrop"
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
        <Text style={[styles.sheetTitle, { color: theme.colors.text }]}>Project</Text>
        <ScrollView>
          <Pressable
            testID="project-option-auto-detect"
            style={styles.projectOption}
            onPress={() => props.onSelect({ type: 'auto-detect' })}
          >
            <Icon name="bolt" size={16} color={theme.colors.textSecondary} />
            <Text style={[styles.projectOptionText, { color: theme.colors.text }]}>
              Auto detect
            </Text>
          </Pressable>
          <Pressable
            testID="project-option-new-project"
            style={styles.projectOption}
            onPress={() => props.onSelect({ type: 'new-project' })}
          >
            <Icon name="plus" size={16} color={theme.colors.textSecondary} />
            <Text style={[styles.projectOptionText, { color: theme.colors.text }]}>
              New project
            </Text>
          </Pressable>

          {props.loading ? (
            <Text style={[styles.projectLoading, { color: theme.colors.textTertiary }]}>
              Loading projects...
            </Text>
          ) : props.recentProjects.length > 0 ? (
            <>
              <Text style={[styles.projectSectionHeader, { color: theme.colors.textTertiary }]}>
                Recent Projects
              </Text>
              {props.recentProjects.map((project) => (
                <Pressable
                  key={project.path}
                  testID={`project-option-${project.path}`}
                  style={styles.projectOption}
                  onPress={() =>
                    props.onSelect({
                      type: 'existing-project',
                      owner: project.owner ?? '',
                      repo: project.name,
                      path: project.path,
                    })
                  }
                >
                  {project.owner ? (
                    <Image
                      source={{ uri: `https://github.com/${project.owner}.png?size=64` }}
                      style={styles.projectAvatar}
                    />
                  ) : (
                    <Icon name="folder" size={16} color={theme.colors.textSecondary} />
                  )}
                  <Text
                    style={[styles.projectOptionText, { color: theme.colors.text }]}
                    numberOfLines={1}
                  >
                    {project.name}
                  </Text>
                </Pressable>
              ))}
            </>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', gap: 8 },
  // The project trigger (left) + an optional right slot (the home profile pill) share
  // one baseline-aligned row so the pill no longer floats alone above the composer.
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  // Shrinks (rather than overflowing under the profile pill) when the project trigger's
  // repo name + the permissions label don't both fit a narrow header row.
  headerLeft: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  headerRight: { alignItems: 'flex-end' },
  projectTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 4,
    flexShrink: 1,
  },
  // The permissions label is short ("Ask for Edit" is the longest) — cap it well below
  // the project trigger's 220 so the pair always leaves room for the profile pill.
  permissionsTrigger: { flexShrink: 2, maxWidth: 110 },
  // Model labels ("Sonnet 4.6", "Opus 4.8") are similarly short — same cap so the
  // project + permissions + model triple still leaves room for the profile pill.
  modelTrigger: { flexShrink: 2, maxWidth: 110 },
  projectTriggerInner: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 220 },
  projectTriggerText: { fontSize: 12, flexShrink: 1 },
  projectTriggerAvatar: { width: 14, height: 14, borderRadius: 7 },

  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 24,
    padding: 8,
    gap: 8,
    overflow: 'hidden',
  },
  inputRow: { flexDirection: 'row', gap: 8 },
  // Collapsed: single line, "+" / placeholder / mic vertically centered.
  inputRowCollapsed: { alignItems: 'center' },
  // Expanded: multiline grows up; the send/mic stays pinned to the bottom.
  inputRowExpanded: { alignItems: 'flex-end' },
  input: {
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
    minHeight: 36,
    maxHeight: 200,
    paddingHorizontal: 8,
    paddingVertical: 8,
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

  frameworkRow: { gap: 8, paddingVertical: 4, paddingHorizontal: 2 },
  frameworkPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  frameworkIcon: { width: 16, height: 16, borderRadius: 4 },
  frameworkLabel: { fontSize: 13, fontWeight: '500' },

  error: { fontSize: 13, paddingHorizontal: 8 },

  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    gap: 8,
    maxHeight: '60%',
  },
  sheetTitle: { fontSize: 18, fontWeight: '700', marginBottom: 4 },

  projectOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  projectOptionText: { fontSize: 15, flexShrink: 1 },
  projectOptionTextCol: { flexShrink: 1, gap: 1 },
  projectOptionSub: { fontSize: 11 },
  projectAvatar: { width: 18, height: 18, borderRadius: 9 },
  projectLoading: { fontSize: 13, paddingVertical: 12, paddingHorizontal: 8 },
  projectSectionHeader: {
    fontSize: 10.4,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
});
