/**
 * Secrets section ViewModel (`/settings/secrets`).
 *
 * Server state:
 *   - List via the shared `useSecrets()` hook (`GET /api/user/secrets` →
 *     `{ secrets: Secret[] }`, values arrive MASKED as '••••••••').
 *   - Create / update / delete are LOCAL `useMutation`s (no shared hook exists):
 *       POST   /api/user/secrets                                { key, value, description? }
 *       PATCH  /api/user/secrets/${encodeURIComponent(key)}     { value?, description? }
 *       DELETE /api/user/secrets/${encodeURIComponent(key)}
 *     each invalidating `queryKeys.secrets()` on success (refetch after every
 *     mutation, no optimistic updates).
 *
 * Client state: one exclusive panel
 * (list | add | view | edit), a single error banner, an instant search filter
 * (key/source/displayName/description, case-insensitive) and updatedAt-DESC
 * sorting. The KEY is auto-uppercased on input (the API expects uppercase keys).
 * Connection-sourced secrets (`source === 'connection'`) are
 * READ-ONLY: they are managed by the connection, so edit/delete are withheld.
 *
 * Every I/O seam is injectable: the HTTP client comes from `useApi()` (the
 * provider-injection seam every screen test uses) and the relative-time clock
 * via `deps.now`.
 */

import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import type {
  CreateUserSecretRequest,
  CreateUserSecretResponse,
  DeleteUserSecretResponse,
  Secret,
  UpdateUserSecretRequest,
  UpdateUserSecretResponse,
} from '@vgit2/shared/types';

import { useApi } from '../../../api/ApiProvider';
import { useSecrets } from '../../../api/hooks';
import { queryKeys } from '../../../api/keys';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Relative-time formatter, parameterized on the clock for determinism. */
export function formatRelativeTime(timestamp: number, now: number): string {
  const seconds = Math.floor((now - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/** The semantic badge tone — the screen maps it to a theme token. */
export type SecretSourceTone = 'info' | 'success' | 'connection' | 'unknown';

/** Source label: Manual (info) / Env Editor (success) / connection name (primary). */
export function formatSecretSource(secret: Secret): { label: string; tone: SecretSourceTone } {
  if (secret.source === 'manual') return { label: 'Manual', tone: 'info' };
  if (secret.source === 'env_editor') return { label: 'Env Editor', tone: 'success' };
  if (secret.source === 'connection') {
    return {
      label: secret.displayName || secret.sourceConnectionId || 'Connection',
      tone: 'connection',
    };
  }
  return { label: 'Unknown', tone: 'unknown' };
}

/** Connection-sourced secrets are managed by the connection. */
export function isReadOnlySecret(secret: Secret): boolean {
  return secret.source === 'connection';
}

/**
 * Filter+sort pipeline: case-insensitive substring match on
 * key/source/displayName/description, then updatedAt (|| createdAt) DESC.
 */
export function filterAndSortSecrets(secrets: Secret[], searchQuery: string): Secret[] {
  let filtered = secrets;
  if (searchQuery.trim()) {
    const query = searchQuery.toLowerCase();
    filtered = secrets.filter(
      (secret) =>
        secret.key.toLowerCase().includes(query) ||
        secret.source.toLowerCase().includes(query) ||
        (secret.displayName && secret.displayName.toLowerCase().includes(query)) ||
        (secret.description && secret.description.toLowerCase().includes(query))
    );
  }
  return [...filtered].sort((a, b) => {
    const aTime = a.updatedAt || a.createdAt;
    const bTime = b.updatedAt || b.createdAt;
    return bTime - aTime;
  });
}

// ---------------------------------------------------------------------------
// ViewModel
// ---------------------------------------------------------------------------

/** The one exclusive panel (the table is hidden while adding/viewing/editing). */
export type SecretsPanel =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'view'; key: string }
  | { kind: 'edit'; key: string };

export interface SecretsViewModelDeps {
  /** Clock for relative-time formatting (injectable for deterministic tests). */
  now?: () => number;
}

export interface AddSecretForm {
  key: string;
  value: string;
  description: string;
}

export interface EditSecretForm {
  value: string;
  description: string;
}

export interface SecretsViewModel {
  // list (server state)
  secrets: Secret[];
  totalCount: number;
  filteredCount: number;
  loading: boolean;
  listError: string | null;
  refetch: () => void;
  // search
  search: string;
  setSearch: (query: string) => void;
  // panel
  panel: SecretsPanel;
  viewedSecret: Secret | null;
  openAdd: () => void;
  openView: (key: string) => void;
  openEdit: (key: string) => void;
  closePanel: () => void;
  // add form
  addForm: AddSecretForm;
  setAddKey: (key: string) => void;
  setAddValue: (value: string) => void;
  setAddDescription: (description: string) => void;
  showAddDescription: boolean;
  revealAddDescription: () => void;
  addValueVisible: boolean;
  toggleAddValueVisible: () => void;
  submitAdd: () => Promise<void>;
  // edit form
  editForm: EditSecretForm;
  setEditValue: (value: string) => void;
  setEditDescription: (description: string) => void;
  submitEdit: () => Promise<void>;
  // delete (confirm step)
  pendingDelete: string | null;
  requestDelete: (key: string) => void;
  cancelDelete: () => void;
  confirmDelete: () => Promise<void>;
  // shared
  saving: boolean;
  formError: string | null;
  formatTime: (timestamp: number) => string;
}

const EMPTY_ADD_FORM: AddSecretForm = { key: '', value: '', description: '' };
const EMPTY_EDIT_FORM: EditSecretForm = { value: '', description: '' };

/** Prefer the server-provided error message, falling back to the default copy. */
function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message && !err.message.startsWith('Request failed')) {
    return err.message;
  }
  return fallback;
}

export function useSecretsViewModel(deps: SecretsViewModelDeps = {}): SecretsViewModel {
  const api = useApi();
  const queryClient = useQueryClient();
  const now = deps.now ?? Date.now;

  const query = useSecrets();
  const allSecrets = useMemo(() => query.data?.secrets ?? [], [query.data]);

  const [search, setSearch] = useState('');
  const [panel, setPanel] = useState<SecretsPanel>({ kind: 'list' });
  const [addForm, setAddForm] = useState<AddSecretForm>(EMPTY_ADD_FORM);
  const [showAddDescription, setShowAddDescription] = useState(false);
  const [addValueVisible, setAddValueVisible] = useState(false);
  const [editForm, setEditForm] = useState<EditSecretForm>(EMPTY_EDIT_FORM);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const secrets = useMemo(() => filterAndSortSecrets(allSecrets, search), [allSecrets, search]);

  const viewedSecret = useMemo(() => {
    if (panel.kind !== 'view') return null;
    return allSecrets.find((s) => s.key === panel.key) ?? null;
  }, [panel, allSecrets]);

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.secrets() }),
    [queryClient]
  );

  // ── Local mutations (no shared hooks exist for the secret writes) ─────────
  const createMutation = useMutation({
    mutationFn: (input: CreateUserSecretRequest) =>
      api.post<CreateUserSecretResponse>('/api/user/secrets', input),
  });
  const updateMutation = useMutation({
    mutationFn: (input: { key: string; body: UpdateUserSecretRequest }) =>
      api.patch<UpdateUserSecretResponse>(
        `/api/user/secrets/${encodeURIComponent(input.key)}`,
        input.body
      ),
  });
  const deleteMutation = useMutation({
    mutationFn: (key: string) =>
      api.del<DeleteUserSecretResponse>(`/api/user/secrets/${encodeURIComponent(key)}`),
  });

  // ── Panel transitions (each clears the error banner) ──────────────────────
  const openAdd = useCallback(() => {
    setFormError(null);
    setAddForm(EMPTY_ADD_FORM);
    setShowAddDescription(false);
    setAddValueVisible(false);
    setPanel({ kind: 'add' });
  }, []);

  const openView = useCallback((key: string) => {
    setFormError(null);
    setPanel({ kind: 'view', key });
  }, []);

  const openEdit = useCallback(
    (key: string) => {
      const secret = allSecrets.find((s) => s.key === key);
      if (!secret) return;
      setFormError(null);
      // The value starts EMPTY: prefilling `secret.value` would prefill the
      // MASKED '••••••••' from the list response — saving it would overwrite the
      // secret with literal dots. A NEW value is
      // therefore REQUIRED to save: the backend PATCH has no "keep current"
      // path (`saveSecretToVault` encrypts the value unconditionally — a
      // value-less PATCH throws server-side), so `submitEdit` validates it.
      setEditForm({ value: '', description: secret.description ?? '' });
      setPanel({ kind: 'edit', key });
    },
    [allSecrets]
  );

  const closePanel = useCallback(() => {
    setFormError(null);
    setAddForm(EMPTY_ADD_FORM);
    setShowAddDescription(false);
    setAddValueVisible(false);
    setEditForm(EMPTY_EDIT_FORM);
    setPanel({ kind: 'list' });
  }, []);

  // ── Add ────────────────────────────────────────────────────────────────────
  const setAddKey = useCallback((key: string) => {
    // The key is auto-uppercased on input (the API expects it).
    setAddForm((f) => ({ ...f, key: key.toUpperCase() }));
  }, []);
  const setAddValue = useCallback((value: string) => setAddForm((f) => ({ ...f, value })), []);
  const setAddDescription = useCallback(
    (description: string) => setAddForm((f) => ({ ...f, description })),
    []
  );
  const revealAddDescription = useCallback(() => setShowAddDescription(true), []);
  const toggleAddValueVisible = useCallback(() => setAddValueVisible((v) => !v), []);

  const submitAdd = useCallback(async () => {
    if (!addForm.key || !addForm.value) {
      setFormError('Key and value are required');
      return;
    }
    setFormError(null);
    try {
      const body: CreateUserSecretRequest = {
        key: addForm.key,
        value: addForm.value,
        ...(addForm.description ? { description: addForm.description } : {}),
      };
      const res = await createMutation.mutateAsync(body);
      if (res.success === false) throw new Error(res.error || 'Failed to create secret');
      await invalidate();
      closePanel();
    } catch (err) {
      setFormError(errorMessage(err, 'Failed to create secret'));
    }
  }, [addForm, createMutation, invalidate, closePanel]);

  // ── Edit ───────────────────────────────────────────────────────────────────
  const setEditValue = useCallback((value: string) => setEditForm((f) => ({ ...f, value })), []);
  const setEditDescription = useCallback(
    (description: string) => setEditForm((f) => ({ ...f, description })),
    []
  );

  const submitEdit = useCallback(async () => {
    if (panel.kind !== 'edit') return;
    // The backend PATCH REQUIRES a value (`saveSecretToVault` encrypts it
    // unconditionally — omitting it crashes the handler into a raw crypto
    // error), so a blank value is a client-side validation error, never a
    // request. NB the backend currently does not persist `description` at all
    // (a silent no-op); it is sent for forward-compat.
    if (!addNonEmpty(editForm.value)) {
      setFormError('Enter a new value');
      return;
    }
    setFormError(null);
    try {
      const body: UpdateUserSecretRequest = {
        value: editForm.value,
        description: editForm.description,
      };
      const res = await updateMutation.mutateAsync({ key: panel.key, body });
      if (res.success === false) throw new Error(res.error || 'Failed to update secret');
      await invalidate();
      closePanel();
    } catch (err) {
      setFormError(errorMessage(err, 'Failed to update secret'));
    }
  }, [panel, editForm, updateMutation, invalidate, closePanel]);

  // ── Delete (confirm step replaces a `confirm()` dialog) ───────────────────
  const requestDelete = useCallback((key: string) => {
    setFormError(null);
    setPendingDelete(key);
  }, []);
  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const key = pendingDelete;
    setFormError(null);
    try {
      const res = await deleteMutation.mutateAsync(key);
      if (res.success === false) throw new Error(res.error || 'Failed to delete secret');
      await invalidate();
      setPendingDelete(null);
      // If the deleted secret was open in a panel, fall back to the list.
      setPanel((p) => (p.kind !== 'list' && 'key' in p && p.key === key ? { kind: 'list' } : p));
    } catch (err) {
      setPendingDelete(null);
      setFormError(errorMessage(err, 'Failed to delete secret'));
    }
  }, [pendingDelete, deleteMutation, invalidate]);

  const saving = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  const formatTime = useCallback(
    (timestamp: number) => formatRelativeTime(timestamp, now()),
    [now]
  );

  return {
    secrets,
    totalCount: allSecrets.length,
    filteredCount: secrets.length,
    // v5: `isPending` (NOT `isLoading`) so a paused offline cold-start shows the
    // spinner instead of a false empty state (the repo's useTasks precedent).
    loading: query.isPending,
    listError: query.isError ? 'Failed to load secrets' : null,
    refetch: () => void query.refetch(),
    search,
    setSearch,
    panel,
    viewedSecret,
    openAdd,
    openView,
    openEdit,
    closePanel,
    addForm,
    setAddKey,
    setAddValue,
    setAddDescription,
    showAddDescription,
    revealAddDescription,
    addValueVisible,
    toggleAddValueVisible,
    submitAdd,
    editForm,
    setEditValue,
    setEditDescription,
    submitEdit,
    pendingDelete,
    requestDelete,
    cancelDelete,
    confirmDelete,
    saving,
    formError,
    formatTime,
  };
}

function addNonEmpty(value: string): boolean {
  return value.length > 0;
}
