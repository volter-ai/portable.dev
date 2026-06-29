/**
 * Secrets settings screen (`/settings/secrets`) — FULL CRUD over the user's
 * encrypted vault + connection-sourced secrets. Thin view over
 * `useSecretsViewModel` (all state/IO lives there).
 *
 * Layout:
 *   - Header "Secrets" with a `+` Add button (headerRight; the narrow native
 *     header gets the glyph, the accessibility label keeps the '+ Add Secret'
 *     copy).
 *   - Error banner (red rgba(239,68,68,.1) box) for validation/mutation
 *     errors; delete shows an in-app confirm card (copy
 *     `Delete secret "{key}"?`).
 *   - List mode: search box ('Search secrets...', instant case-insensitive
 *     filter on key/source/displayName/description) over a bordered card of
 *     rows sorted updatedAt DESC. Each row: mono key, MASKED value, source
 *     badge (Manual=info / Env Editor=success / connection displayName=primary)
 *     · relative time, a ✕ delete button (non-connection only) and a ›
 *     chevron. Connection rows are read-only (managed by the connection).
 *   - Row tap → view panel (key, VALUE box, DESCRIPTION, 'Source: …', Edit for
 *     non-connection rows + Close). Edit → 'Edit: {key}' form (value +
 *     description, Save Changes → PATCH). Add → 'Add New Secret' form
 *     (auto-UPPERCASE key, secure value with Show/Hide toggle, collapsed
 *     '+ Add description (optional)' toggle; 'Key and value are required'
 *     validation).
 *   - Loading 'Loading...' / list error 'Failed to load secrets' (+ retry) /
 *     empty 'No secrets yet. Add your first secret to get started.' states.
 *
 * testIDs:
 *   settings-secrets (root) / settings-secrets-back (chrome)
 *   settings-secrets-add (headerRight)
 *   settings-secrets-count (hidden, virtualization-proof filtered count)
 *   settings-secrets-search
 *   settings-secrets-loading / settings-secrets-error (+ -retry) /
 *   settings-secrets-empty / settings-secrets-error-banner
 *   settings-secrets-row-<KEY> (+ -value / -source / -time / -delete)
 *   settings-secrets-delete-confirm (+ -button) / settings-secrets-delete-cancel
 *   settings-secrets-view (+ -key / -value / -description / -source / -edit / -close)
 *   settings-secrets-edit (+ -value / -description / -save / -cancel)
 *   settings-secrets-add-form (+ -key / -value / -value-toggle /
 *     -description-toggle / -description / -submit / -cancel)
 *
 * Deliberate gaps:
 *   - The edit form's value field starts EMPTY and a NEW value is REQUIRED
 *     — prefilling `secret.value` would prefill the MASKED '••••••••' from
 *     the list response, so saving without retyping would overwrite the secret
 *     with literal dots. A blank value is a validation error (the backend
 *     PATCH has no "keep current" path).
 *   - The Add Secret button stays enabled when key/value are empty; pressing it
 *     surfaces the 'Key and value are required' validation banner.
 *   - Delete confirmation is an in-app confirm card (RN has no `confirm()`).
 *   - The view panel's VALUE box shows the value exactly as the API returns it
 *     (the masked `secret.value` from `GET /api/user/secrets`).
 */

import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { Secret } from '@vgit2/shared/types';

import { useAppTheme, withAlpha, type Theme } from '../../../../theme';
import {
  SectionEmpty,
  SectionError,
  SectionLabel,
  SectionLoading,
  SettingsSectionScreen,
} from '../../chrome';
import {
  formatSecretSource,
  isReadOnlySecret,
  useSecretsViewModel,
  type SecretsViewModel,
  type SecretsViewModelDeps,
  type SecretSourceTone,
} from './useSecretsViewModel';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export interface SecretsScreenProps {
  /** Back action (default: `router.back()`); injectable for tests. */
  onBack?: () => void;
  /** ViewModel seams (clock, etc.) — injectable for tests. */
  deps?: SecretsViewModelDeps;
}

function toneColor(tone: SecretSourceTone, theme: Theme): string {
  switch (tone) {
    case 'info':
      return theme.colors.info;
    case 'success':
      return theme.colors.success;
    case 'connection':
      return theme.colors.primary;
    default:
      return theme.colors.textTertiary;
  }
}

export function SecretsScreen({ onBack, deps }: SecretsScreenProps) {
  const vm = useSecretsViewModel(deps);
  const { theme } = useAppTheme();

  const headerRight =
    vm.panel.kind === 'list' ? (
      <Pressable
        testID="settings-secrets-add"
        accessibilityRole="button"
        accessibilityLabel="Add Secret"
        onPress={vm.openAdd}
        hitSlop={8}
      >
        <Text style={[styles.addGlyph, { color: theme.colors.primary }]}>+</Text>
      </Pressable>
    ) : null;

  return (
    <SettingsSectionScreen
      title="Secrets"
      testID="settings-secrets"
      onBack={onBack}
      headerRight={headerRight}
    >
      {/* Hidden, virtualization-proof filtered count (repo convention). */}
      <Text testID="settings-secrets-count" style={styles.hidden}>
        {String(vm.filteredCount)}
      </Text>

      {!!vm.formError && (
        <View
          testID="settings-secrets-error-banner"
          style={[styles.errorBanner, { backgroundColor: withAlpha(theme.colors.danger, '1A') }]}
        >
          <Text style={[styles.errorBannerText, { color: theme.colors.danger }]}>
            {vm.formError}
          </Text>
        </View>
      )}

      {!!vm.pendingDelete && <DeleteConfirmCard vm={vm} />}

      {vm.panel.kind === 'add' && <AddForm vm={vm} />}
      {vm.panel.kind === 'edit' && <EditForm vm={vm} />}
      {vm.panel.kind === 'view' && vm.viewedSecret && (
        <ViewPanel vm={vm} secret={vm.viewedSecret} />
      )}

      {(vm.panel.kind === 'list' || (vm.panel.kind === 'view' && !vm.viewedSecret)) && (
        <ListSection vm={vm} />
      )}
    </SettingsSectionScreen>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function ListSection({ vm }: { vm: SecretsViewModel }) {
  const { theme } = useAppTheme();

  if (vm.loading) {
    return <SectionLoading testID="settings-secrets-loading" caption="Loading..." />;
  }
  if (vm.listError) {
    return (
      <SectionError testID="settings-secrets-error" message={vm.listError} onRetry={vm.refetch} />
    );
  }
  if (vm.totalCount === 0) {
    return (
      <SectionEmpty
        testID="settings-secrets-empty"
        message="No secrets yet. Add your first secret to get started."
      />
    );
  }

  return (
    <View style={styles.listSection}>
      <TextInput
        testID="settings-secrets-search"
        value={vm.search}
        onChangeText={vm.setSearch}
        placeholder="Search secrets..."
        placeholderTextColor={theme.colors.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        style={[
          styles.input,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
            color: theme.colors.text,
          },
        ]}
      />
      <View
        style={[
          styles.listCard,
          { borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
        ]}
      >
        {vm.secrets.map((secret, index) => (
          <SecretRow
            key={secret.key}
            vm={vm}
            secret={secret}
            isLast={index === vm.secrets.length - 1}
          />
        ))}
      </View>
    </View>
  );
}

function SecretRow({
  vm,
  secret,
  isLast,
}: {
  vm: SecretsViewModel;
  secret: Secret;
  isLast: boolean;
}) {
  const { theme } = useAppTheme();
  const source = formatSecretSource(secret);
  const readOnly = isReadOnlySecret(secret);

  return (
    <Pressable
      testID={`settings-secrets-row-${secret.key}`}
      accessibilityRole="button"
      onPress={() => vm.openView(secret.key)}
      style={[styles.row, { borderBottomColor: theme.colors.border }, isLast && styles.rowLast]}
    >
      <View style={styles.rowContent}>
        <Text style={[styles.rowKey, { color: theme.colors.text }]}>{secret.key}</Text>
        <Text
          testID={`settings-secrets-row-${secret.key}-value`}
          style={[styles.rowValue, { color: theme.colors.textTertiary }]}
          numberOfLines={1}
        >
          {secret.value}
        </Text>
        <View style={styles.rowMeta}>
          <Text
            testID={`settings-secrets-row-${secret.key}-source`}
            style={[styles.rowMetaText, { color: toneColor(source.tone, theme) }]}
          >
            {source.label}
          </Text>
          <Text style={[styles.rowMetaText, { color: theme.colors.textTertiary }]}>·</Text>
          <Text
            testID={`settings-secrets-row-${secret.key}-time`}
            style={[styles.rowMetaText, { color: theme.colors.textTertiary }]}
          >
            {vm.formatTime(secret.updatedAt || secret.createdAt)}
          </Text>
        </View>
      </View>
      {!readOnly && (
        <Pressable
          testID={`settings-secrets-row-${secret.key}-delete`}
          accessibilityRole="button"
          accessibilityLabel="Delete secret"
          onPress={() => vm.requestDelete(secret.key)}
          hitSlop={8}
          style={styles.rowDelete}
        >
          <Text style={[styles.rowDeleteGlyph, { color: theme.colors.textTertiary }]}>✕</Text>
        </Pressable>
      )}
      <Text
        style={[
          styles.rowChevron,
          { color: theme.colors.textTertiary, marginLeft: readOnly ? 8 : 4 },
        ]}
      >
        ›
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Delete confirm (replaces a `confirm('Delete secret "{key}"?')` dialog)
// ---------------------------------------------------------------------------

function DeleteConfirmCard({ vm }: { vm: SecretsViewModel }) {
  const { theme } = useAppTheme();
  return (
    <View
      testID="settings-secrets-delete-confirm"
      style={[
        styles.panel,
        { backgroundColor: theme.colors.surfaceHover, borderColor: theme.colors.border },
      ]}
    >
      <Text style={[styles.panelTitle, { color: theme.colors.text }]}>
        {`Delete secret "${vm.pendingDelete}"?`}
      </Text>
      <View style={styles.buttonRow}>
        <Pressable
          testID="settings-secrets-delete-confirm-button"
          accessibilityRole="button"
          disabled={vm.saving}
          onPress={() => void vm.confirmDelete()}
          style={[
            styles.button,
            { backgroundColor: theme.colors.danger },
            vm.saving && styles.disabled,
          ]}
        >
          <Text style={[styles.buttonText, { color: theme.colors.textInverse }]}>
            {vm.saving ? 'Deleting...' : 'Delete'}
          </Text>
        </Pressable>
        <SecondaryButton
          testID="settings-secrets-delete-cancel"
          label="Cancel"
          disabled={vm.saving}
          onPress={vm.cancelDelete}
        />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// View panel
// ---------------------------------------------------------------------------

function ViewPanel({ vm, secret }: { vm: SecretsViewModel; secret: Secret }) {
  const { theme } = useAppTheme();
  const source = formatSecretSource(secret);
  const readOnly = isReadOnlySecret(secret);

  return (
    <View
      testID="settings-secrets-view"
      style={[
        styles.panel,
        { backgroundColor: theme.colors.surfaceHover, borderColor: theme.colors.border },
      ]}
    >
      <Text
        testID="settings-secrets-view-key"
        style={[styles.panelKey, { color: theme.colors.text }]}
      >
        {secret.key}
      </Text>

      <SectionLabel>Value</SectionLabel>
      <View
        style={[
          styles.valueBox,
          { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
        ]}
      >
        <Text
          testID="settings-secrets-view-value"
          style={[styles.valueBoxText, { color: theme.colors.text }]}
        >
          {secret.value}
        </Text>
      </View>

      {!!secret.description && (
        <View style={styles.panelBlock}>
          <SectionLabel>Description</SectionLabel>
          <Text
            testID="settings-secrets-view-description"
            style={[styles.panelDescription, { color: theme.colors.textSecondary }]}
          >
            {secret.description}
          </Text>
        </View>
      )}

      <Text
        testID="settings-secrets-view-source"
        style={[styles.panelSource, { color: theme.colors.textTertiary }]}
      >
        Source:{' '}
        <Text style={source.tone === 'connection' ? { color: theme.colors.primary } : undefined}>
          {source.label}
        </Text>
      </Text>

      <View style={styles.buttonRow}>
        {!readOnly && (
          <Pressable
            testID="settings-secrets-view-edit"
            accessibilityRole="button"
            onPress={() => vm.openEdit(secret.key)}
            style={[styles.button, { backgroundColor: theme.colors.primary }]}
          >
            <Text style={[styles.buttonText, { color: theme.colors.textInverse }]}>Edit</Text>
          </Pressable>
        )}
        <SecondaryButton
          testID="settings-secrets-view-close"
          label="Close"
          onPress={vm.closePanel}
        />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Edit form
// ---------------------------------------------------------------------------

function EditForm({ vm }: { vm: SecretsViewModel }) {
  const { theme } = useAppTheme();
  const key = vm.panel.kind === 'edit' ? vm.panel.key : '';

  return (
    <View
      testID="settings-secrets-edit"
      style={[
        styles.panel,
        { backgroundColor: theme.colors.surfaceHover, borderColor: theme.colors.border },
      ]}
    >
      <Text style={[styles.panelHeader, styles.mono, { color: theme.colors.text }]}>
        {`Edit: ${key}`}
      </Text>
      <TextInput
        testID="settings-secrets-edit-value"
        value={vm.editForm.value}
        onChangeText={vm.setEditValue}
        placeholder="New value (required)"
        placeholderTextColor={theme.colors.textTertiary}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        style={[
          styles.input,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
            color: theme.colors.text,
          },
        ]}
      />
      <TextInput
        testID="settings-secrets-edit-description"
        value={vm.editForm.description}
        onChangeText={vm.setEditDescription}
        placeholder="Description (optional)"
        placeholderTextColor={theme.colors.textTertiary}
        style={[
          styles.input,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
            color: theme.colors.text,
          },
        ]}
      />
      <View style={styles.buttonRow}>
        <Pressable
          testID="settings-secrets-edit-save"
          accessibilityRole="button"
          disabled={vm.saving}
          onPress={() => void vm.submitEdit()}
          style={[
            styles.button,
            { backgroundColor: theme.colors.success },
            vm.saving && styles.disabled,
          ]}
        >
          <Text style={[styles.buttonText, { color: theme.colors.textInverse }]}>
            {vm.saving ? 'Saving...' : 'Save Changes'}
          </Text>
        </Pressable>
        <SecondaryButton
          testID="settings-secrets-edit-cancel"
          label="Cancel"
          disabled={vm.saving}
          onPress={vm.closePanel}
        />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Add form
// ---------------------------------------------------------------------------

function AddForm({ vm }: { vm: SecretsViewModel }) {
  const { theme } = useAppTheme();

  return (
    <View
      testID="settings-secrets-add-form"
      style={[
        styles.panel,
        { backgroundColor: theme.colors.surfaceHover, borderColor: theme.colors.border },
      ]}
    >
      <Text style={[styles.panelHeader, { color: theme.colors.text }]}>Add New Secret</Text>
      <TextInput
        testID="settings-secrets-add-key"
        value={vm.addForm.key}
        onChangeText={vm.setAddKey}
        placeholder="KEY (e.g., OPENAI_API_KEY)"
        placeholderTextColor={theme.colors.textTertiary}
        autoCapitalize="characters"
        autoCorrect={false}
        style={[
          styles.input,
          styles.mono,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
            color: theme.colors.text,
          },
        ]}
      />
      <View style={styles.valueRow}>
        <TextInput
          testID="settings-secrets-add-value"
          value={vm.addForm.value}
          onChangeText={vm.setAddValue}
          placeholder="Value (secret)"
          placeholderTextColor={theme.colors.textTertiary}
          secureTextEntry={!vm.addValueVisible}
          autoCapitalize="none"
          autoCorrect={false}
          style={[
            styles.input,
            styles.valueInput,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
              color: theme.colors.text,
            },
          ]}
        />
        <Pressable
          testID="settings-secrets-add-value-toggle"
          accessibilityRole="button"
          accessibilityLabel={vm.addValueVisible ? 'Hide value' : 'Show value'}
          onPress={vm.toggleAddValueVisible}
          hitSlop={8}
        >
          <Text style={[styles.valueToggle, { color: theme.colors.primary }]}>
            {vm.addValueVisible ? 'Hide' : 'Show'}
          </Text>
        </Pressable>
      </View>

      {!vm.showAddDescription ? (
        <Pressable
          testID="settings-secrets-add-description-toggle"
          accessibilityRole="button"
          onPress={vm.revealAddDescription}
        >
          <Text style={[styles.descriptionToggle, { color: theme.colors.primary }]}>
            + Add description (optional)
          </Text>
        </Pressable>
      ) : (
        <TextInput
          testID="settings-secrets-add-description"
          value={vm.addForm.description}
          onChangeText={vm.setAddDescription}
          placeholder="Description (optional)"
          placeholderTextColor={theme.colors.textTertiary}
          style={[
            styles.input,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
              color: theme.colors.text,
            },
          ]}
        />
      )}

      <View style={styles.buttonRow}>
        <Pressable
          testID="settings-secrets-add-submit"
          accessibilityRole="button"
          disabled={vm.saving}
          onPress={() => void vm.submitAdd()}
          style={[
            styles.button,
            { backgroundColor: theme.colors.success },
            vm.saving && styles.disabled,
          ]}
        >
          <Text style={[styles.buttonText, { color: theme.colors.textInverse }]}>
            {vm.saving ? 'Adding...' : 'Add Secret'}
          </Text>
        </Pressable>
        <SecondaryButton
          testID="settings-secrets-add-cancel"
          label="Cancel"
          disabled={vm.saving}
          onPress={vm.closePanel}
        />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function SecondaryButton({
  testID,
  label,
  onPress,
  disabled,
}: {
  testID: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { theme } = useAppTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        styles.secondaryButton,
        { backgroundColor: theme.colors.surfaceHover, borderColor: theme.colors.border },
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.buttonText, { color: theme.colors.textSecondary }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hidden: { height: 0, width: 0, opacity: 0 },
  addGlyph: { fontSize: 24, fontWeight: '500', lineHeight: 26 },
  errorBanner: { borderRadius: 6, padding: 8 },
  errorBannerText: { fontSize: 12 },
  listSection: { gap: 12 },
  input: {
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 13,
  },
  listCard: { borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLast: { borderBottomWidth: 0 },
  rowContent: { flex: 1, minWidth: 0 },
  rowKey: { fontFamily: MONO, fontSize: 14, fontWeight: '500' },
  rowValue: { fontFamily: MONO, fontSize: 12, marginTop: 2 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  rowMetaText: { fontSize: 12 },
  rowDelete: { padding: 6, marginLeft: 8 },
  rowDeleteGlyph: { fontSize: 14 },
  rowChevron: { fontSize: 14 },
  panel: { borderWidth: 1, borderRadius: 8, padding: 12, gap: 8 },
  panelTitle: { fontSize: 13, fontWeight: '600' },
  panelKey: { fontFamily: MONO, fontSize: 14, fontWeight: '600' },
  panelHeader: { fontSize: 12, fontWeight: '600' },
  panelBlock: { gap: 2 },
  panelDescription: { fontSize: 13 },
  panelSource: { fontSize: 12 },
  valueBox: { borderWidth: 1, borderRadius: 6, padding: 8 },
  valueBoxText: { fontFamily: MONO, fontSize: 13 },
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  valueInput: { flex: 1 },
  valueToggle: { fontSize: 12, fontWeight: '500' },
  descriptionToggle: { fontSize: 12, textDecorationLine: 'underline' },
  buttonRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  button: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
  secondaryButton: { borderWidth: 1 },
  buttonText: { fontSize: 12, fontWeight: '500' },
  mono: { fontFamily: MONO },
  disabled: { opacity: 0.5 },
});
