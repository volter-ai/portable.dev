/**
 * NewProjectModal — the "New project" form opened from the home Linked-Projects
 * "＋ New" tile. A centered modal (the chat-delete-confirm convention): a single
 * name field + Cancel / Create. The entered name becomes the folder + GitHub repo
 * name; the actual create call lives in the screen (this is presentational).
 *
 * testIDs: `new-project-modal` / `-name` / `-cancel` / `-submit` / `-error`.
 */

import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { useAppTheme } from '../../theme';

export interface NewProjectCreateOptions {
  /** Also create a private GitHub repo + push (else local-only, git-ready to push later). */
  createGithubRepo: boolean;
}

export interface NewProjectModalProps {
  visible: boolean;
  /** Disables the form + flips the button to "Creating…" during the request. */
  submitting?: boolean;
  /** Error message to surface (e.g. a failed create), shown above the actions. */
  error?: string | null;
  onSubmit: (name: string, options: NewProjectCreateOptions) => void;
  onCancel: () => void;
}

export function NewProjectModal({
  visible,
  submitting = false,
  error,
  onSubmit,
  onCancel,
}: NewProjectModalProps) {
  const { theme } = useAppTheme();
  const [name, setName] = useState('');
  const [createGithubRepo, setCreateGithubRepo] = useState(false);

  // Start each open with a blank field + the default (local-only) repo choice.
  useEffect(() => {
    if (visible) {
      setName('');
      setCreateGithubRepo(false);
    }
  }, [visible]);

  const trimmed = name.trim();
  const canCreate = trimmed.length > 0 && !submitting;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View
          style={[
            styles.card,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
          ]}
          testID="new-project-modal"
        >
          <Text style={[styles.title, { color: theme.colors.text }]}>New project</Text>
          <Text style={[styles.body, { color: theme.colors.textSecondary }]}>
            Creates a project folder on your machine (a git repo) and adds it to your projects.
          </Text>

          <TextInput
            testID="new-project-name"
            value={name}
            onChangeText={setName}
            placeholder="project-name"
            placeholderTextColor={theme.colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            editable={!submitting}
            returnKeyType="done"
            onSubmitEditing={() => {
              if (canCreate) onSubmit(trimmed, { createGithubRepo });
            }}
            style={[
              styles.input,
              {
                color: theme.colors.text,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.background,
              },
            ]}
          />

          {/* Optional remote: off = local-only (git-ready), on = create a private GitHub repo + push. */}
          <View style={styles.toggleRow}>
            <View style={styles.toggleLabel}>
              <Text style={[styles.toggleTitle, { color: theme.colors.text }]}>
                Create GitHub repo
              </Text>
              <Text style={[styles.toggleHint, { color: theme.colors.textTertiary }]}>
                {createGithubRepo
                  ? 'A private repo will be created and pushed.'
                  : 'Local only — push to GitHub whenever you want.'}
              </Text>
            </View>
            <Switch
              testID="new-project-github-toggle"
              value={createGithubRepo}
              onValueChange={setCreateGithubRepo}
              disabled={submitting}
              trackColor={{ true: theme.colors.primary }}
            />
          </View>

          {error ? (
            <Text testID="new-project-error" style={[styles.error, { color: theme.colors.danger }]}>
              {error}
            </Text>
          ) : null}

          <View style={styles.actions}>
            <Pressable
              testID="new-project-cancel"
              onPress={onCancel}
              disabled={submitting}
              style={[styles.button, { borderColor: theme.colors.border }]}
            >
              <Text style={[styles.buttonText, { color: theme.colors.textSecondary }]}>Cancel</Text>
            </Pressable>
            <Pressable
              testID="new-project-submit"
              onPress={() => onSubmit(trimmed, { createGithubRepo })}
              disabled={!canCreate}
              style={[
                styles.button,
                { backgroundColor: theme.colors.primary, opacity: canCreate ? 1 : 0.5 },
              ]}
            >
              <Text style={[styles.buttonText, { color: '#fff', fontWeight: '700' }]}>
                {submitting ? 'Creating…' : 'Create'}
              </Text>
            </Pressable>
          </View>
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
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 20,
    gap: 8,
  },
  title: { fontSize: 16, fontWeight: '700' },
  body: { fontSize: 13, lineHeight: 18 },
  input: {
    marginTop: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  error: { fontSize: 12, marginTop: 2 },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 10,
  },
  toggleLabel: { flex: 1, gap: 2 },
  toggleTitle: { fontSize: 14, fontWeight: '600' },
  toggleHint: { fontSize: 11, lineHeight: 15 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 12 },
  button: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    minWidth: 80,
    alignItems: 'center',
  },
  buttonText: { fontSize: 14, fontWeight: '500' },
});
