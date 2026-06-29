/**
 * WorkflowsTab — the RepoPage Workflows tab.
 *
 * Lists the repo's workflow files and supports the file operations:
 * view (fetch a file's content), create (new file), update (edit an
 * existing file), and delete. Three local sub-views switched by component state
 * (no nested route): the file list, a
 * create form, and a per-file view/edit panel.
 *
 * Thin view over {@link useWorkflows} (list + view/create/update/delete).
 */

import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useWorkflows, type WorkflowFileEntry } from './useWorkflows';
import { RowCard } from './RowCard';
import { useAppTheme, withAlpha } from '../../theme';

export interface WorkflowsTabProps {
  owner: string;
  repo: string;
}

type PanelView = { mode: 'list' } | { mode: 'create' } | { mode: 'file'; path: string };

export function WorkflowsTab({ owner, repo }: WorkflowsTabProps) {
  const vm = useWorkflows(owner, repo);
  const [view, setView] = useState<PanelView>({ mode: 'list' });
  const { theme } = useAppTheme();

  if (view.mode === 'create') {
    return (
      <WorkflowCreateForm
        onCancel={() => setView({ mode: 'list' })}
        onCreate={(input) => {
          vm.createFile(input);
          setView({ mode: 'list' });
        }}
        isMutating={vm.isMutating}
      />
    );
  }

  if (view.mode === 'file') {
    return (
      <WorkflowFilePanel
        path={view.path}
        viewFile={vm.viewFile}
        onUpdate={(content, sha) => vm.updateFile({ path: view.path, content, sha })}
        onDelete={(sha) => {
          vm.deleteFile({ path: view.path, sha });
          setView({ mode: 'list' });
        }}
        onBack={() => setView({ mode: 'list' })}
        isMutating={vm.isMutating}
      />
    );
  }

  return (
    <View style={styles.fill}>
      <View style={styles.toolbar}>
        <Pressable
          testID="repo-workflows-new"
          style={[styles.newBtn, { backgroundColor: theme.colors.accentSoft }]}
          onPress={() => setView({ mode: 'create' })}
        >
          <Text style={[styles.newBtnText, { color: theme.colors.primary }]}>＋ New workflow</Text>
        </Pressable>
      </View>

      {/* Virtualization-proof list length. */}
      <Text style={styles.hidden} testID="repo-workflows-count">
        {vm.workflows.length}
      </Text>

      {vm.isLoading ? (
        <ActivityIndicator
          testID="repo-workflows-loading"
          style={styles.center}
          color={theme.colors.primary}
        />
      ) : vm.isError ? (
        <View style={styles.center} testID="repo-workflows-error">
          <Text style={[styles.errorText, { color: theme.colors.error }]}>
            Couldn’t load workflows
          </Text>
        </View>
      ) : (
        <FlatList
          testID="repo-workflows-list"
          data={vm.workflows}
          keyExtractor={(w) => String(w.id)}
          renderItem={({ item }) => (
            <WorkflowRow
              workflow={item}
              onPress={() => setView({ mode: 'file', path: item.path })}
            />
          )}
          ListEmptyComponent={
            <Text
              style={[styles.emptyText, { color: theme.colors.textSecondary }]}
              testID="repo-workflows-empty"
            >
              No workflow files
            </Text>
          }
        />
      )}
    </View>
  );
}

function WorkflowRow({ workflow, onPress }: { workflow: WorkflowFileEntry; onPress: () => void }) {
  const { theme } = useAppTheme();
  return (
    <RowCard testID={`repo-workflow-open-${workflow.id}`} onPress={onPress}>
      <View style={styles.rowMain}>
        <Text style={[styles.rowTitle, { color: theme.colors.text }]} numberOfLines={1}>
          {workflow.name}
        </Text>
        <Text style={[styles.rowMeta, { color: theme.colors.textSecondary }]} numberOfLines={1}>
          {workflow.path}
          {workflow.state ? ` · ${workflow.state}` : ''}
        </Text>
      </View>
    </RowCard>
  );
}

function WorkflowCreateForm({
  onCancel,
  onCreate,
  isMutating,
}: {
  onCancel: () => void;
  onCreate: (input: { path: string; content: string }) => void;
  isMutating: boolean;
}) {
  const [path, setPath] = useState('.github/workflows/');
  const [content, setContent] = useState('');
  const { theme } = useAppTheme();

  const inputStyle = {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    color: theme.colors.text,
  };

  return (
    <ScrollView contentContainerStyle={styles.detailScroll} testID="repo-workflow-create">
      <Pressable
        testID="repo-workflow-create-back"
        onPress={onCancel}
        hitSlop={8}
        style={styles.back}
      >
        <Text style={[styles.backText, { color: theme.colors.primary }]}>‹ Workflows</Text>
      </Pressable>
      <Text style={[styles.detailTitle, { color: theme.colors.text }]}>New workflow</Text>

      <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary }]}>Path</Text>
      <TextInput
        testID="repo-workflow-create-path"
        style={[styles.input, inputStyle]}
        autoCapitalize="none"
        autoCorrect={false}
        value={path}
        onChangeText={setPath}
        placeholder=".github/workflows/ci.yml"
        placeholderTextColor={theme.colors.textTertiary}
      />

      <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary }]}>Content</Text>
      <TextInput
        testID="repo-workflow-create-content"
        style={[
          styles.input,
          styles.codeInput,
          inputStyle,
          { fontFamily: theme.typography.fontFamilyMono },
        ]}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        value={content}
        onChangeText={setContent}
        placeholder={'name: CI\non: [push]\n…'}
        placeholderTextColor={theme.colors.textTertiary}
      />

      <Pressable
        testID="repo-workflow-create-submit"
        style={[styles.submitBtn, { backgroundColor: theme.colors.primary }]}
        disabled={isMutating || !path.trim() || !content.trim()}
        onPress={() => onCreate({ path: path.trim(), content })}
      >
        <Text style={[styles.submitText, { color: theme.colors.textInverse }]}>
          {isMutating ? 'Creating…' : 'Create workflow'}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

function WorkflowFilePanel({
  path,
  viewFile,
  onUpdate,
  onDelete,
  onBack,
  isMutating,
}: {
  path: string;
  viewFile: (path: string) => Promise<{ content: string; sha: string }>;
  onUpdate: (content: string, sha: string) => void;
  onDelete: (sha: string) => void;
  onBack: () => void;
  isMutating: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [content, setContent] = useState('');
  const [sha, setSha] = useState<string | null>(null);
  const { theme } = useAppTheme();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    viewFile(path)
      .then((file) => {
        if (cancelled) return;
        setContent(file.content);
        setSha(file.sha);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, viewFile]);

  return (
    <ScrollView contentContainerStyle={styles.detailScroll} testID="repo-workflow-file">
      <Pressable testID="repo-workflow-file-back" onPress={onBack} hitSlop={8} style={styles.back}>
        <Text style={[styles.backText, { color: theme.colors.primary }]}>‹ Workflows</Text>
      </Pressable>
      <Text
        style={[styles.detailTitle, { color: theme.colors.text }]}
        numberOfLines={1}
        testID="repo-workflow-file-path"
      >
        {path}
      </Text>

      {loading ? (
        <ActivityIndicator
          testID="repo-workflow-file-loading"
          style={styles.center}
          color={theme.colors.primary}
        />
      ) : error ? (
        <View style={styles.center} testID="repo-workflow-file-error">
          <Text style={[styles.errorText, { color: theme.colors.error }]}>
            Couldn’t load this workflow file
          </Text>
        </View>
      ) : (
        <>
          <TextInput
            testID="repo-workflow-file-content"
            style={[
              styles.input,
              styles.codeInput,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                color: theme.colors.text,
                fontFamily: theme.typography.fontFamilyMono,
              },
            ]}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            value={content}
            onChangeText={setContent}
          />
          <View style={styles.fileActions}>
            <Pressable
              testID="repo-workflow-file-update"
              style={[styles.submitBtn, { backgroundColor: theme.colors.primary }]}
              disabled={isMutating || !sha || !content.trim()}
              onPress={() => sha && onUpdate(content, sha)}
            >
              <Text style={[styles.submitText, { color: theme.colors.textInverse }]}>
                {isMutating ? 'Saving…' : 'Save changes'}
              </Text>
            </Pressable>
            <Pressable
              testID="repo-workflow-file-delete"
              style={[styles.deleteBtn, { backgroundColor: withAlpha(theme.colors.error, '22') }]}
              disabled={isMutating || !sha}
              onPress={() => sha && onDelete(sha)}
            >
              <Text style={[styles.deleteText, { color: theme.colors.error }]}>Delete</Text>
            </Pressable>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hidden: { height: 0, opacity: 0 },
  toolbar: { flexDirection: 'row', justifyContent: 'flex-end', paddingBottom: 8 },
  newBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
  },
  newBtnText: { fontWeight: '600', fontSize: 13 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 24 },
  errorText: { fontSize: 15, fontWeight: '600' },
  emptyText: { opacity: 0.6, paddingVertical: 24, textAlign: 'center' },
  rowMain: { gap: 2 },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowMeta: { fontSize: 12, opacity: 0.6 },
  detailScroll: { paddingBottom: 48, gap: 8 },
  back: { paddingVertical: 6 },
  backText: { fontSize: 15, fontWeight: '600' },
  detailTitle: { fontSize: 18, fontWeight: '700' },
  fieldLabel: { fontSize: 13, fontWeight: '700', marginTop: 12, opacity: 0.7 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  codeInput: { minHeight: 160, textAlignVertical: 'top' },
  fileActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  submitBtn: {
    flex: 1,
    marginTop: 8,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  submitText: { fontWeight: '700' },
  deleteBtn: {
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteText: { fontWeight: '700' },
});
