/**
 * Shared runtime resource cards (web `RuntimeOverviewInstance` / list-instance
 * parity) — composed by both the overview sections and the dedicated list
 * screens, so the two never drift. Pure presentational; press handling is the
 * caller's (navigate to detail).
 */

import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import type { ProcessData, TunnelData } from '@vgit2/shared/types';

import { useAppTheme } from '../../theme';
import { Icon } from '../../theme/icons/Icon';
import type { ClaudeSessionData } from '../state/runtimeStore';
import {
  claudeSessionStatusColor,
  claudeSessionStatusLabel,
  formatElapsed,
  ownerAvatarUrl,
  processStatusColor,
  processStatusLabel,
  repoLabel,
  stripProtocol,
  tunnelDotColor,
  tunnelProvider,
} from './runtimeHelpers';

function StatusDot({ color }: { color: string }) {
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

/** GitHub owner avatar for the repo that owns a resource (null when no repo). */
function OwnerAvatar({ repoPath }: { repoPath: string | undefined }) {
  const uri = ownerAvatarUrl(repoPath, 48);
  if (!uri) return null;
  return <Image source={{ uri }} style={styles.avatar} accessibilityIgnoresInvertColors />;
}

function RepoLine({ repoPath }: { repoPath: string | undefined }) {
  const { theme } = useAppTheme();
  const label = repoLabel(repoPath);
  if (!label) return null;
  return (
    <View style={styles.repoLine}>
      <OwnerAvatar repoPath={repoPath} />
      <Text style={[styles.repoText, { color: theme.colors.textTertiary }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

interface CardShellProps {
  testID: string;
  onPress?: () => void;
  children: React.ReactNode;
}

function CardShell({ testID, onPress, children }: CardShellProps) {
  const { theme } = useAppTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole={onPress ? 'button' : undefined}
      onPress={onPress}
      style={[
        styles.card,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
    >
      {children}
    </Pressable>
  );
}

export function TunnelCard({
  tunnel,
  onPress,
  testID,
}: {
  tunnel: TunnelData;
  onPress?: () => void;
  testID: string;
}) {
  const { theme } = useAppTheme();
  const provider = tunnelProvider(tunnel.url);
  return (
    <CardShell testID={testID} onPress={onPress}>
      <View style={styles.row}>
        <StatusDot color={tunnelDotColor(tunnel.active, theme.colors)} />
        <Text style={[styles.cardTitle, { color: theme.colors.text }]} numberOfLines={1}>
          {tunnel.name || `Port ${tunnel.port}`}
        </Text>
        <Text style={[styles.port, { color: theme.colors.textSecondary }]}>:{tunnel.port}</Text>
        {tunnel.main ? <Badge label="MAIN" color={theme.colors.primary} /> : null}
        {provider === 'cloudflare' ? <Badge label="CF" color={theme.colors.info} /> : null}
      </View>
      <Text style={[styles.url, { color: theme.colors.textSecondary }]} numberOfLines={1}>
        {stripProtocol(tunnel.url)}
      </Text>
      <View style={styles.metaRow}>
        <RepoLine repoPath={tunnel.createdByRepoPath} />
        <Text style={[styles.elapsed, { color: theme.colors.textTertiary }]}>
          {formatElapsed(tunnel.createdAt)}
        </Text>
      </View>
    </CardShell>
  );
}

export function ProcessCard({
  process,
  onPress,
  testID,
}: {
  process: ProcessData;
  onPress?: () => void;
  testID: string;
}) {
  const { theme } = useAppTheme();
  const label = process.description || process.command;
  return (
    <CardShell testID={testID} onPress={onPress}>
      <View style={styles.row}>
        <StatusDot color={processStatusColor(process.status, theme.colors)} />
        <Text style={[styles.cardTitle, { color: theme.colors.text }]} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <View style={styles.metaRow}>
        <Text
          style={[styles.statusLabel, { color: processStatusColor(process.status, theme.colors) }]}
        >
          {processStatusLabel(process.status)}
        </Text>
        <RepoLine repoPath={process.repoPath} />
        <Text style={[styles.elapsed, { color: theme.colors.textTertiary }]}>
          {formatElapsed(process.startedAt)}
        </Text>
      </View>
    </CardShell>
  );
}

/**
 * Live Claude session card: status dot/badge, repo, time since
 * last activity, and a Kill button. Surfaced in the runtime panel so the user
 * can see + reclaim the per-chat subprocesses. The card itself is not pressable
 * (the only action is Kill) — killing preserves resume.
 */
export function ClaudeSessionCard({
  session,
  onKill,
  killing,
  testID,
}: {
  session: ClaudeSessionData;
  onKill?: () => void;
  killing?: boolean;
  testID: string;
}) {
  const { theme } = useAppTheme();
  const color = claudeSessionStatusColor(session.status, theme.colors);
  const repo = repoLabel(session.repoPath);
  return (
    <CardShell testID={testID}>
      <View style={styles.row}>
        <StatusDot color={color} />
        <Text style={[styles.claudeTitle, { color: theme.colors.text }]} numberOfLines={1}>
          {repo ?? 'Claude session'}
        </Text>
        <Badge label={claudeSessionStatusLabel(session.status)} color={color} />
        {/* rev12: the user's own terminal `claude` on the PC (not api-spawned). */}
        {session.origin === 'terminal' ? (
          <Badge label="Terminal" color={theme.colors.textTertiary} />
        ) : null}
        {onKill ? (
          <Pressable
            testID={`${testID}-kill`}
            accessibilityRole="button"
            disabled={killing}
            onPress={onKill}
            hitSlop={8}
            style={[
              styles.killButton,
              { borderColor: theme.colors.danger, opacity: killing ? 0.5 : 1 },
            ]}
          >
            <Icon name="stop" size={11} color={theme.colors.danger} />
            <Text style={[styles.killText, { color: theme.colors.danger }]}>Kill</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.metaRow}>
        <OwnerAvatar repoPath={session.repoPath} />
        <Text
          style={[styles.elapsed, { color: theme.colors.textTertiary }]}
          testID={`${testID}-age`}
        >
          {session.status === 'idle' ? 'idle ' : ''}
          {formatElapsed(session.lastActivityAt)}
        </Text>
      </View>
    </CardShell>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  cardTitle: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  port: { fontSize: 13, fontWeight: '500' },
  url: { fontSize: 12 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  statusLabel: { fontSize: 12, fontWeight: '600' },
  elapsed: { fontSize: 11, marginLeft: 'auto' },
  repoLine: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  avatar: { width: 16, height: 16, borderRadius: 8, backgroundColor: '#0000001a' },
  repoText: { fontSize: 11, maxWidth: 160 },
  deviceEmoji: { fontSize: 14 },
  badge: { borderWidth: 1, borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1 },
  badgeText: { fontSize: 10, fontWeight: '700' },
  claudeTitle: { fontSize: 14, fontWeight: '600', flex: 1 },
  killButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  killText: { fontSize: 11, fontWeight: '700' },
});
