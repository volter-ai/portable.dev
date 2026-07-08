/**
 * Claude Account settings screen (`/settings/claude-account`, portable.dev#18) —
 * sign in to Claude from the phone + the AI-credential status card. Thin view
 * over `useClaudeAccountViewModel`.
 *
 * Sign-in is browser + paste-code: "Sign in with Claude" opens the Claude
 * authorization page in the system browser; the callback page displays a code
 * the user copies and pastes back here. A "Paste a token instead" fallback
 * accepts an `sk-ant-oat…` token (from `claude setup-token`) or an Anthropic
 * API key.
 *
 * testIDs:
 *   settings-claude-account                    (root)
 *   settings-claude-account-loading            (initial status fetch)
 *   settings-claude-account-error              (status fetch failed)
 *   settings-claude-account-status             (status card)
 *   settings-claude-account-banner             (mutation error banner)
 *   settings-claude-account-signin             (Sign in with Claude)
 *   settings-claude-account-code-input         (paste-code field)
 *   settings-claude-account-code-submit        (submit the pasted code)
 *   settings-claude-account-code-cancel        (cancel the code entry)
 *   settings-claude-account-token-toggle       (reveal the paste-token fallback)
 *   settings-claude-account-token-input        (token field)
 *   settings-claude-account-token-submit       (save the pasted token)
 *   settings-claude-account-signout            (sign out)
 */

import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import type { AiCredentialsStatusResponse } from '@vgit2/shared/types';

import { useAppTheme } from '../../../../theme';
import {
  OptionButton,
  SectionError,
  SectionLabel,
  SectionLoading,
  SettingsCard,
  SettingsSectionScreen,
} from '../../chrome';
import {
  useClaudeAccountViewModel,
  type ClaudeAccountViewModelDeps,
} from './useClaudeAccountViewModel';

export interface ClaudeAccountScreenProps {
  /** Back action override (default chrome `router.back()`); injectable for tests. */
  onBack?: () => void;
  /** ViewModel seams (browser opener); injectable for tests. */
  vmDeps?: ClaudeAccountViewModelDeps;
}

/** Human status line for the credential card. */
export function describeStatus(status: AiCredentialsStatusResponse): {
  title: string;
  detail: string;
} {
  if (status.mode === 'claude-oauth') {
    const who = status.email ? `Signed in as ${status.email}` : 'Signed in with Claude';
    const detail = status.hasRefreshToken
      ? 'Your session renews automatically.'
      : status.expiresAt
        ? `Token expires ${new Date(status.expiresAt).toLocaleString()}.`
        : 'Using a long-lived Claude token.';
    return { title: who, detail };
  }
  if (status.mode === 'api-key') {
    return {
      title: 'Using an Anthropic API key',
      detail:
        status.source === 'env-api-key'
          ? 'From the ANTHROPIC_API_KEY environment on your PC.'
          : 'Saved from this app.',
    };
  }
  return {
    title: 'Not signed in',
    detail: 'AI will not run until you sign in with Claude or add an API key.',
  };
}

export function ClaudeAccountScreen({ onBack, vmDeps }: ClaudeAccountScreenProps) {
  const { theme } = useAppTheme();
  const vm = useClaudeAccountViewModel(vmDeps);
  const [showTokenFallback, setShowTokenFallback] = useState(false);

  const inputStyle = [
    styles.input,
    {
      backgroundColor: theme.colors.surfaceHover,
      borderColor: theme.colors.border,
      color: theme.colors.text,
    },
  ];

  return (
    <SettingsSectionScreen title="Claude Account" testID="settings-claude-account" onBack={onBack}>
      {vm.loading ? (
        <SectionLoading testID="settings-claude-account-loading" />
      ) : vm.loadError ? (
        <SectionError
          testID="settings-claude-account-error"
          message="Could not load the credential status from your PC."
          onRetry={vm.refetchStatus}
        />
      ) : (
        <>
          {!!vm.error && (
            <View
              testID="settings-claude-account-banner"
              style={[styles.banner, { backgroundColor: theme.colors.surfaceHover }]}
            >
              <Text style={[styles.bannerText, { color: theme.colors.error }]}>{vm.error}</Text>
            </View>
          )}

          <SectionLabel>Claude account</SectionLabel>
          <SettingsCard testID="settings-claude-account-status">
            {(() => {
              const { title, detail } = describeStatus(vm.status!);
              return (
                <>
                  <Text style={[styles.statusTitle, { color: theme.colors.text }]}>{title}</Text>
                  <Text style={[styles.statusDetail, { color: theme.colors.textTertiary }]}>
                    {vm.signedInEmail ? 'Signed in — you are all set.' : detail}
                  </Text>
                </>
              );
            })()}
          </SettingsCard>

          {vm.phase === 'idle' ? (
            <OptionButton
              testID="settings-claude-account-signin"
              label={vm.status?.mode === 'none' ? 'Sign in with Claude' : 'Sign in again'}
              description="Opens claude.ai in your browser; you will paste a code back here."
              selected={false}
              disabled={vm.busy}
              onPress={vm.beginSignIn}
            />
          ) : (
            <>
              <SectionLabel>Finish signing in</SectionLabel>
              <Text style={[styles.instructions, { color: theme.colors.textTertiary }]}>
                Log in on the page that just opened, approve the access, then copy the code it shows
                and paste it below.
              </Text>
              <TextInput
                testID="settings-claude-account-code-input"
                style={inputStyle}
                value={vm.code}
                onChangeText={vm.setCode}
                placeholder="Paste the code here"
                placeholderTextColor={theme.colors.textTertiary}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!vm.busy}
              />
              <OptionButton
                testID="settings-claude-account-code-submit"
                label={vm.busy ? 'Verifying…' : 'Complete sign-in'}
                selected={vm.code.trim().length > 0}
                disabled={vm.busy || vm.code.trim().length === 0}
                onPress={vm.submitCode}
              />
              <OptionButton
                testID="settings-claude-account-code-cancel"
                label="Cancel"
                selected={false}
                disabled={vm.busy}
                onPress={vm.cancelSignIn}
              />
            </>
          )}

          <SectionLabel>Advanced</SectionLabel>
          {!showTokenFallback ? (
            <OptionButton
              testID="settings-claude-account-token-toggle"
              label="Paste a token instead"
              description="Use a token from `claude setup-token` or an Anthropic API key."
              selected={false}
              onPress={() => setShowTokenFallback(true)}
            />
          ) : (
            <>
              <TextInput
                testID="settings-claude-account-token-input"
                style={inputStyle}
                value={vm.tokenInput}
                onChangeText={vm.setTokenInput}
                placeholder="sk-ant-…"
                placeholderTextColor={theme.colors.textTertiary}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                editable={!vm.busy}
              />
              <OptionButton
                testID="settings-claude-account-token-submit"
                label={vm.busy ? 'Saving…' : 'Save token'}
                selected={vm.tokenInput.trim().length > 0}
                disabled={vm.busy || vm.tokenInput.trim().length === 0}
                onPress={vm.submitToken}
              />
            </>
          )}

          {vm.status && vm.status.mode !== 'none' && (
            <OptionButton
              testID="settings-claude-account-signout"
              label="Sign out"
              description="Removes the stored Claude credential from your PC."
              selected={false}
              disabled={vm.busy}
              onPress={vm.signOut}
            />
          )}
        </>
      )}
    </SettingsSectionScreen>
  );
}

const styles = StyleSheet.create({
  banner: { borderRadius: 8, padding: 10 },
  bannerText: { fontSize: 12, lineHeight: 17 },
  statusTitle: { fontSize: 14, fontWeight: '600' },
  statusDetail: { fontSize: 12, lineHeight: 17, marginTop: 4 },
  instructions: { fontSize: 12, lineHeight: 17, paddingHorizontal: 2 },
  input: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 13,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});
