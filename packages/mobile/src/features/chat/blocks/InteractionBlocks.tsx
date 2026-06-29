/**
 * Interaction blocks — the permission / secrets / connection-request prompts.
 *
 * The submit/response flows: each component accepts an explicit callback
 * (`onRespond` / `onSubmit` / `onConnect`) — when omitted it falls back to the
 * `ChatInteractionContext` (`useChatInteraction()`), so the block renderer needs
 * to thread no callbacks: the active-chat screen mounts a `ChatInteractionProvider`
 * and the blocks reach the socket through it. Outside a provider with no callback
 * the buttons are inert. None of these ever dumps raw JSON.
 *
 * testIDs: `block-permission` (+ `-approve` / `-deny`), `block-secrets`
 * (+ `-input-<key>` / `-submit` / `-submitted`), `block-connection-request`
 * (+ `-connect`).
 */

import { memo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

import { useAppTheme, withAlpha } from '../../../theme';
import { useChatInteraction } from '../interactions/ChatInteractionContext';
import { useInteractionStore } from '../interactions/interactionStore';
import { fileName, getToolResultText, permissionRequestId, toolInput } from './blockHelpers';
import type { ToolResult } from './blockHelpers';

/**
 * Permission gate that WRAPS the underlying tool block: when `needsPermission` and
 * the user hasn't responded, it shows an approve/deny prompt ABOVE the tool block;
 * once responded (or after a non-timeout `tool_result`) it just renders the
 * children. The actual emit is `onRespond`, wired separately.
 */
export interface PermissionBlockProps {
  block: ClaudeStreamBlock;
  result?: ToolResult;
  children: ReactNode;
  /**
   * Emit the approve/deny decision. When omitted, falls back to the chat
   * interaction context's `respondToPermission`.
   */
  onRespond?: (approved: boolean, requestId: string | undefined) => void;
}

export const PermissionBlock = memo(function PermissionBlock({
  block,
  result,
  children,
  onRespond,
}: PermissionBlockProps) {
  const { theme } = useAppTheme();
  const interaction = useChatInteraction();
  // A non-timeout tool_result means the user already responded.
  const resultText = getToolResultText(result?.content);
  const isTimeoutError = result?.is_error === true && resultText.includes('timed out');
  const hasResult = !!result && !isTimeoutError;

  const [responded, setResponded] = useState(hasResult);
  const requestId = permissionRequestId(block);

  const respond = (approved: boolean) => {
    if (responded) return;
    setResponded(true);
    if (onRespond) onRespond(approved, requestId);
    else interaction?.respondToPermission(requestId, approved);
  };

  if (responded) {
    return <>{children}</>;
  }

  const input = toolInput(block);
  const commandPreview =
    typeof input.command === 'string' ? input.command : Object.keys(input).join(', ');

  return (
    <View
      testID="block-permission"
      style={[
        styles.permWrapper,
        {
          borderColor: withAlpha(theme.colors.warning, '66'),
          backgroundColor: withAlpha(theme.colors.warning, '14'),
        },
      ]}
    >
      <View style={styles.permHeader}>
        <Text style={styles.permGlyph}>🔒</Text>
        <Text style={[styles.permTitle, { color: theme.colors.warning }]}>Permission required</Text>
      </View>
      <Text style={[styles.permTool, { color: theme.colors.text }]}>
        {block.toolName ?? 'Tool'}
      </Text>
      {commandPreview ? (
        <Text
          style={[
            styles.permPreview,
            { color: theme.colors.textSecondary, fontFamily: theme.typography.fontFamilyMono },
          ]}
          numberOfLines={3}
        >
          {commandPreview}
        </Text>
      ) : null}
      <View style={styles.permButtons}>
        <Pressable
          testID="block-permission-approve"
          accessibilityRole="button"
          style={[styles.permButton, { backgroundColor: theme.colors.success }]}
          onPress={() => respond(true)}
        >
          <Text style={[styles.permApproveText, { color: theme.colors.textInverse }]}>Approve</Text>
        </Pressable>
        <Pressable
          testID="block-permission-deny"
          accessibilityRole="button"
          style={[styles.permButton, { backgroundColor: theme.colors.error }]}
          onPress={() => respond(false)}
        >
          <Text style={[styles.permDenyText, { color: theme.colors.textInverse }]}>Deny</Text>
        </Pressable>
      </View>
      <View style={styles.permChildren}>{children}</View>
    </View>
  );
});

interface RequestedSecret {
  key?: string;
  description?: string;
}

/**
 * `request_user_secrets` block — an inline form for the env vars the agent needs.
 * Captures a value per requested key and submits via `secrets:submit`, resolving
 * on the `secrets:submitted` confirmation (status driven through the interaction
 * context). When `onSubmit` is provided it is used instead of the context (test
 * seam / explicit override).
 */
export interface SecretsBlockProps {
  block: ClaudeStreamBlock;
  /**
   * Submit the captured secrets. When omitted, falls back to the chat interaction
   * context's `submitSecrets`.
   */
  onSubmit?: (secrets: Record<string, string>) => void | Promise<unknown>;
}

export const SecretsBlock = memo(function SecretsBlock({ block, onSubmit }: SecretsBlockProps) {
  const { theme } = useAppTheme();
  const interaction = useChatInteraction();
  const chatId = interaction?.chatId;
  const status =
    useInteractionStore((s) => (chatId ? s.secretsStatus[chatId] : undefined)) ?? 'idle';

  const input = toolInput(block);
  const secrets = Array.isArray(input.secrets) ? (input.secrets as RequestedSecret[]) : [];
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
  const displayName = filePath ? fileName(filePath) : '.env';

  const [values, setValues] = useState<Record<string, string>>({});

  const submit = () => {
    if (onSubmit) void onSubmit(values);
    else void interaction?.submitSecrets(values);
  };

  const secretsWrapperStyle = [
    styles.secretsWrapper,
    {
      borderColor: withAlpha(theme.colors.warning, '66'),
      backgroundColor: withAlpha(theme.colors.warning, '14'),
    },
  ];

  if (status === 'submitted') {
    return (
      <View testID="block-secrets" style={secretsWrapperStyle}>
        <View testID="block-secrets-submitted" style={styles.secretsHeader}>
          <Text style={[styles.secretsSubmittedGlyph, { color: theme.colors.success }]}>✓</Text>
          <Text style={[styles.secretsTitle, { color: theme.colors.warning }]}>Secrets saved</Text>
        </View>
      </View>
    );
  }

  return (
    <View testID="block-secrets" style={secretsWrapperStyle}>
      <View style={styles.secretsHeader}>
        <Text style={styles.secretsGlyph}>🔑</Text>
        <Text style={[styles.secretsTitle, { color: theme.colors.warning }]}>
          Environment Variables Required
        </Text>
      </View>
      {filePath ? (
        <Text
          style={[
            styles.secretsFile,
            { color: theme.colors.textSecondary, fontFamily: theme.typography.fontFamilyMono },
          ]}
        >
          {filePath}
        </Text>
      ) : null}
      <View style={styles.secretsList}>
        {secrets.map((secret, i) => {
          const key = secret.key ?? `secret-${i}`;
          return (
            <View key={key} style={styles.secretsField}>
              <Text
                style={[
                  styles.secretsKey,
                  { color: theme.colors.warning, fontFamily: theme.typography.fontFamilyMono },
                ]}
              >
                {secret.key}
              </Text>
              {secret.description ? (
                <Text style={[styles.secretsDesc, { color: theme.colors.textSecondary }]}>
                  {secret.description}
                </Text>
              ) : null}
              <TextInput
                testID={`block-secrets-input-${secret.key ?? i}`}
                style={[
                  styles.secretsInput,
                  {
                    borderColor: withAlpha(theme.colors.warning, '66'),
                    backgroundColor: theme.colors.backgroundElevated,
                    color: theme.colors.text,
                    fontFamily: theme.typography.fontFamilyMono,
                  },
                ]}
                placeholder={secret.key}
                placeholderTextColor={theme.colors.textTertiary}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                value={values[key] ?? ''}
                onChangeText={(t) => setValues((prev) => ({ ...prev, [key]: t }))}
              />
            </View>
          );
        })}
      </View>
      <Pressable
        testID="block-secrets-submit"
        accessibilityRole="button"
        disabled={status === 'submitting'}
        style={[
          styles.secretsButton,
          { backgroundColor: theme.colors.primary },
          status === 'submitting' && styles.secretsButtonDisabled,
        ]}
        onPress={submit}
      >
        <Text style={[styles.secretsButtonText, { color: theme.colors.textInverse }]}>
          {status === 'submitting' ? 'Saving…' : `Save ${displayName}`}
        </Text>
      </Pressable>
    </View>
  );
});

/**
 * `request_user_connection` block — prompts the user to connect a third-party
 * service. The OAuth round-trip (open `ConnectionModal`, then notify the chat) is
 * wired separately; here the "Connect" button just calls `onConnect`.
 */
export interface ConnectionRequestBlockProps {
  block: ClaudeStreamBlock;
  /**
   * Open the connection flow. When omitted, falls back to the chat interaction
   * context's `startConnection`.
   */
  onConnect?: (service: string) => void;
}

export const ConnectionRequestBlock = memo(function ConnectionRequestBlock({
  block,
  onConnect,
}: ConnectionRequestBlockProps) {
  const { theme } = useAppTheme();
  const interaction = useChatInteraction();
  const input = toolInput(block);
  const service = typeof input.service === 'string' ? input.service : 'unknown';
  const reason =
    typeof input.reason === 'string' ? input.reason : 'This connection is required to proceed';
  const required = input.required !== false;

  return (
    <View
      testID="block-connection-request"
      style={[
        styles.connWrapper,
        {
          borderColor: theme.colors.accentSoft,
          backgroundColor: withAlpha(theme.colors.link, '14'),
        },
      ]}
    >
      <View style={styles.connHeader}>
        <Text style={styles.connGlyph}>🔌</Text>
        <Text style={[styles.connTitle, { color: theme.colors.link }]}>Connection Required</Text>
      </View>
      <Text style={[styles.connService, { color: theme.colors.text }]}>{service}</Text>
      <Text style={[styles.connReason, { color: theme.colors.textSecondary }]}>{reason}</Text>
      {required ? (
        <View style={[styles.connBadge, { backgroundColor: withAlpha(theme.colors.error, '22') }]}>
          <Text style={[styles.connBadgeText, { color: theme.colors.error }]}>Required</Text>
        </View>
      ) : null}
      <Pressable
        testID="block-connection-request-connect"
        accessibilityRole="button"
        style={[styles.connButton, { backgroundColor: theme.colors.primary }]}
        onPress={() => (onConnect ?? interaction?.startConnection)?.(service)}
      >
        <Text style={[styles.connButtonText, { color: theme.colors.textInverse }]}>
          Connect {service}
        </Text>
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  // Permission
  permWrapper: {
    marginVertical: 6,
    padding: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  permHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  permGlyph: { fontSize: 14 },
  permTitle: { fontWeight: '700', fontSize: 14 },
  permTool: { fontWeight: '600', fontSize: 13 },
  permPreview: { fontSize: 12 },
  permButtons: { flexDirection: 'row', gap: 8 },
  permButton: { flex: 1, paddingVertical: 8, borderRadius: 6, alignItems: 'center' },
  permApproveText: { fontWeight: '600', fontSize: 13 },
  permDenyText: { fontWeight: '600', fontSize: 13 },
  permChildren: { marginTop: 4 },
  // Secrets
  secretsWrapper: {
    marginVertical: 6,
    padding: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  secretsHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  secretsGlyph: { fontSize: 14 },
  secretsTitle: { fontWeight: '700', fontSize: 14 },
  secretsFile: { fontSize: 12 },
  secretsList: { gap: 10 },
  secretsField: { gap: 4 },
  secretsKey: { fontWeight: '600', fontSize: 13 },
  secretsDesc: { fontSize: 12 },
  secretsInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 13,
  },
  secretsSubmittedGlyph: { fontWeight: '700', fontSize: 14 },
  secretsButton: {
    marginTop: 4,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
  },
  secretsButtonDisabled: { opacity: 0.6 },
  secretsButtonText: { fontWeight: '600', fontSize: 13 },
  // Connection
  connWrapper: {
    marginVertical: 6,
    padding: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  connHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  connGlyph: { fontSize: 14 },
  connTitle: { fontWeight: '700', fontSize: 14 },
  connService: { fontWeight: '600', fontSize: 14 },
  connReason: { fontSize: 13, lineHeight: 18 },
  connBadge: {
    alignSelf: 'flex-start',
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 4,
  },
  connBadgeText: { fontSize: 11, fontWeight: '600' },
  connButton: {
    marginTop: 4,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
  },
  connButtonText: { fontWeight: '600', fontSize: 13 },
});
