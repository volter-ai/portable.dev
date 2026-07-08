/**
 * Claude Account ViewModel (`/settings/claude-account`, portable.dev#18).
 *
 * Server state: the AI-credential status (`GET /api/ai-credentials/status`,
 * metadata only — token values never reach the app) + four mutations against
 * the PC api:
 *   POST   /api/ai-credentials/login/start     → { authorizeUrl }
 *   POST   /api/ai-credentials/login/complete  { code } → { ok, email? }
 *   POST   /api/ai-credentials/token           { token } → { ok, mode }
 *   DELETE /api/ai-credentials                 → { ok, cleared }
 *
 * The sign-in flow is phone-driven PKCE with a manual paste step: `beginSignIn`
 * asks the PC for the authorize URL, opens it in the system browser (the PC
 * holds the PKCE verifier), and flips the screen to the code-entry phase; the
 * user logs in on claude.ai, copies the displayed code, pastes it here, and
 * `submitCode` completes the exchange on the PC. Every mutation invalidates the
 * status query. The browser opener is an injectable seam (`deps.openUrl`).
 */

import { useCallback, useState } from 'react';
import { Linking } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AiCredentialsLoginCompleteResponse,
  AiCredentialsLoginStartResponse,
  AiCredentialsPasteTokenResponse,
  AiCredentialsSignOutResponse,
  AiCredentialsStatusResponse,
} from '@vgit2/shared/types';

import { useApi } from '../../../api/ApiProvider';
import { queryKeys } from '../../../api/keys';

/** Which panel the screen shows. */
export type ClaudeAccountPhase = 'idle' | 'code-entry';

export interface ClaudeAccountViewModelDeps {
  /** System-browser opener (default `Linking.openURL`); injectable for tests. */
  openUrl?: (url: string) => Promise<unknown>;
}

export interface ClaudeAccountViewModel {
  status: AiCredentialsStatusResponse | undefined;
  /** Initial status fetch in flight (no cached value yet). */
  loading: boolean;
  /** Status fetch failed (screen offers Retry). */
  loadError: boolean;
  refetchStatus: () => void;

  phase: ClaudeAccountPhase;
  /** Any mutation in flight (disables the action buttons). */
  busy: boolean;
  /** Last mutation failure, shown as an inline banner (null = none). */
  error: string | null;
  /** Email confirmed by the last successful sign-in (transient success note). */
  signedInEmail: string | null;

  beginSignIn: () => void;
  cancelSignIn: () => void;
  code: string;
  setCode: (value: string) => void;
  submitCode: () => void;

  tokenInput: string;
  setTokenInput: (value: string) => void;
  submitToken: () => void;

  signOut: () => void;
}

/** Pull the api's error body message out of a failed mutation, if present. */
function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = String((err as Error).message || '').trim();
    if (message) return message;
  }
  return fallback;
}

export function useClaudeAccountViewModel(
  deps: ClaudeAccountViewModelDeps = {}
): ClaudeAccountViewModel {
  const api = useApi();
  const queryClient = useQueryClient();
  const openUrl = deps.openUrl ?? ((url: string) => Linking.openURL(url));

  const [phase, setPhase] = useState<ClaudeAccountPhase>('idle');
  const [code, setCode] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: queryKeys.aiCredentials(),
    queryFn: () => api.get<AiCredentialsStatusResponse>('/api/ai-credentials/status'),
  });

  const invalidateStatus = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.aiCredentials() }),
    [queryClient]
  );

  const startMutation = useMutation({
    mutationFn: () => api.post<AiCredentialsLoginStartResponse>('/api/ai-credentials/login/start'),
    onSuccess: async ({ authorizeUrl }) => {
      setError(null);
      setSignedInEmail(null);
      setPhase('code-entry');
      try {
        await openUrl(authorizeUrl);
      } catch {
        // Browser refused to open — the code-entry panel still shows the retry link.
      }
    },
    onError: (err) => setError(errorMessage(err, 'Could not start the Claude sign-in.')),
  });

  const completeMutation = useMutation({
    mutationFn: (pastedCode: string) =>
      api.post<AiCredentialsLoginCompleteResponse>('/api/ai-credentials/login/complete', {
        code: pastedCode,
      }),
    onSuccess: (result) => {
      setError(null);
      setPhase('idle');
      setCode('');
      setSignedInEmail(result.email ?? null);
      invalidateStatus();
    },
    onError: (err) =>
      setError(errorMessage(err, 'Could not complete the sign-in — paste the newest code.')),
  });

  const tokenMutation = useMutation({
    mutationFn: (token: string) =>
      api.post<AiCredentialsPasteTokenResponse>('/api/ai-credentials/token', { token }),
    onSuccess: () => {
      setError(null);
      setTokenInput('');
      invalidateStatus();
    },
    onError: (err) =>
      setError(errorMessage(err, 'That does not look like an Anthropic credential.')),
  });

  const signOutMutation = useMutation({
    mutationFn: () => api.del<AiCredentialsSignOutResponse>('/api/ai-credentials'),
    onSuccess: () => {
      setError(null);
      setSignedInEmail(null);
      invalidateStatus();
    },
    onError: (err) => setError(errorMessage(err, 'Could not sign out.')),
  });

  const busy =
    startMutation.isPending ||
    completeMutation.isPending ||
    tokenMutation.isPending ||
    signOutMutation.isPending;

  const beginSignIn = useCallback(() => {
    if (!busy) startMutation.mutate();
  }, [busy, startMutation]);

  const cancelSignIn = useCallback(() => {
    setPhase('idle');
    setCode('');
    setError(null);
  }, []);

  const submitCode = useCallback(() => {
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    completeMutation.mutate(trimmed);
  }, [busy, code, completeMutation]);

  const submitToken = useCallback(() => {
    const trimmed = tokenInput.trim();
    if (!trimmed || busy) return;
    tokenMutation.mutate(trimmed);
  }, [busy, tokenInput, tokenMutation]);

  const signOut = useCallback(() => {
    if (!busy) signOutMutation.mutate();
  }, [busy, signOutMutation]);

  return {
    status: statusQuery.data,
    loading: statusQuery.isPending,
    loadError: statusQuery.isError,
    refetchStatus: () => void statusQuery.refetch(),
    phase,
    busy,
    error,
    signedInEmail,
    beginSignIn,
    cancelSignIn,
    code,
    setCode,
    submitCode,
    tokenInput,
    setTokenInput,
    submitToken,
    signOut,
  };
}
