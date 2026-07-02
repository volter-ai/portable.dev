/**
 * RuntimeOverviewScreen — the `/runtime` tab hub (replacing the old flat
 * RuntimeBox monitor). Sandbox metrics + memory
 * banner, a Storage entry, and collapsible Sessions / Tunnels / Processes sections
 * whose cards navigate to the dedicated detail screens (which push over the tab
 * bar). All data is socket-sourced via `useRuntime` → `runtimeStore`; the only
 * actions here are create-session + navigation. Platform split: iOS gets
 * a SINGLE "New browser" create button (no embedded WebView there → the
 * desktop/mobile viewport pair is meaningless), a session-card tap re-signs the
 * live-view URL then opens the SYSTEM browser directly, and a tunnel-card tap
 * opens the tunnel URL the same way — the iOS detail screens for user-URL
 * viewers are dead hops (only an "Open" button). Process/storage navigation is
 * platform-agnostic (no web content).
 *
 * Exported as `RuntimeBox` (back-compat alias) from the feature barrel.
 */

import { router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '../../theme';
import { Icon, type IconName } from '../../theme/icons/Icon';
// FILE import (not the pc-connect barrel) so the Runtime graph stays lean — the
// barrel pulls the QR-scanner/camera component tree this screen never renders.
import { disconnectPc } from '../pc-connect/disconnectPc';
import { useOptionalSocket } from '../socket';
import { ClaudeSessionCard, ProcessCard, TunnelCard } from './cards';
import { runtimeRoutes, type RuntimeNavigate } from './runtimeRoutes';
import { RuntimeMetrics } from './RuntimeMetrics';
import { openSandboxUrlExternal } from './SandboxWebView';
import { useRuntime } from './useRuntime';

export interface RuntimeOverviewProps {
  /** Owning chat for create-session (web ties sessions to a chat). */
  chatId?: string;
  /** Navigate seam (default: Expo Router `router.push`). */
  navigate?: RuntimeNavigate;
  /** Platform override for the iOS direct-open / single-button split. */
  platform?: typeof Platform.OS;
  /** Open the live view in the SYSTEM browser (iOS path). Default: expo-web-browser. */
  openExternal?: (url: string) => void;
  /**
   * Forget this device's PC pairing and return to the QR scanner (the "Disconnect"
   * action). Default: {@link disconnectPc} — clears the stored pcId + the scanned
   * QR's JWT, then signals the PC-connect gate back to the connection page.
   */
  onDisconnect?: () => Promise<void>;
}

function Section({
  title,
  icon,
  count,
  countTestID,
  sectionTestID,
  onViewAll,
  viewAllTestID,
  right,
  children,
}: {
  title: string;
  icon: IconName;
  count: number;
  countTestID: string;
  sectionTestID: string;
  onViewAll?: () => void;
  viewAllTestID?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(true);
  return (
    <View
      style={[
        styles.section,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
      ]}
      testID={sectionTestID}
    >
      <View style={styles.sectionHeader}>
        <Pressable
          testID={`${sectionTestID}-toggle`}
          accessibilityRole="button"
          onPress={() => setOpen((v) => !v)}
          style={styles.sectionTitleRow}
          hitSlop={6}
        >
          <Icon name={icon} size={16} color={theme.colors.textSecondary} />
          <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>{title}</Text>
          <View style={[styles.countBadge, { backgroundColor: theme.colors.hover }]}>
            <Text style={[styles.countBadgeText, { color: theme.colors.textSecondary }]}>
              {count}
            </Text>
          </View>
          <Icon
            name={open ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={theme.colors.textTertiary}
          />
        </Pressable>
        <View style={styles.sectionActions}>
          {right}
          {onViewAll ? (
            <Pressable
              testID={viewAllTestID}
              accessibilityRole="button"
              onPress={onViewAll}
              hitSlop={6}
            >
              <Text style={[styles.viewAll, { color: theme.colors.primary }]}>View all</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {/* Virtualization-proof count (always present, even when collapsed). */}
      <Text style={styles.hidden} testID={countTestID}>
        {count}
      </Text>
      {open ? <View style={styles.sectionBody}>{children}</View> : null}
    </View>
  );
}

export function RuntimeOverviewScreen({
  navigate,
  platform = Platform.OS,
  openExternal,
  onDisconnect,
}: RuntimeOverviewProps) {
  const socket = useOptionalSocket();
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const {
    tunnels,
    processes,
    claudeSessions,
    claudeSessionIdleTtlMs,
    sandboxMetrics,
    killSession,
  } = useRuntime(socket);
  const go = navigate ?? ((p: string) => router.push(p));
  const isIOS = platform === 'ios';
  const openTunnel = (t: (typeof tunnels)[number]) => {
    if (isIOS && t.url) {
      (openExternal ?? openSandboxUrlExternal)(t.url);
      return;
    }
    go(runtimeRoutes.tunnel(t.port));
  };

  // Disconnect ("forget this PC") — clears the stored pcId + scanned QR JWT and
  // returns the app to the connection page (the PC-connect QR scanner). The gate
  // then unmounts this screen, so there is nothing to do on success.
  const doDisconnect = onDisconnect ?? disconnectPc;
  const [disconnectVisible, setDisconnectVisible] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const onConfirmDisconnect = () => {
    setDisconnecting(true);
    // `disconnectPc` is best-effort and never throws; the catch is belt-and-braces
    // so a failure re-enables the button instead of wedging on "Disconnecting…".
    void doDisconnect().catch(() => setDisconnecting(false));
  };

  // Per-chat kill-in-flight tracking for the Claude sessions list. The
  // session disappears via `session:reaped` / the runtime_state rebroadcast, so
  // this only disables the button for the brief round-trip.
  const [killing, setKilling] = useState<Set<string>>(new Set());
  const onKillSession = async (sessionChatId: string) => {
    setKilling((prev) => new Set(prev).add(sessionChatId));
    try {
      await killSession(sessionChatId);
    } finally {
      setKilling((prev) => {
        const next = new Set(prev);
        next.delete(sessionChatId);
        return next;
      });
    }
  };

  return (
    <View
      style={[styles.root, { paddingTop: insets.top, backgroundColor: theme.colors.background }]}
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        testID="runtime-box"
      >
        <RuntimeMetrics metrics={sandboxMetrics} />

        {/* Tunnels */}
        <Section
          title="Tunnels"
          icon="globe"
          count={tunnels.length}
          countTestID="runtime-tunnels-count"
          sectionTestID="runtime-section-tunnels"
          onViewAll={() => go(runtimeRoutes.tunnels)}
          viewAllTestID="runtime-tunnels-link"
        >
          {tunnels.length === 0 ? (
            <Text
              style={[styles.empty, { color: theme.colors.textSecondary }]}
              testID="runtime-tunnels-empty"
            >
              No active tunnels
            </Text>
          ) : (
            tunnels.map((t) => (
              <TunnelCard
                key={t.port}
                tunnel={t}
                testID={`runtime-tunnel-${t.port}`}
                onPress={() => openTunnel(t)}
              />
            ))
          )}
        </Section>

        {/* Background tasks (Claude-SDK run_in_background bash — NOT a machine ps). */}
        <Section
          title="Background tasks"
          icon="terminal"
          count={processes.length}
          countTestID="runtime-processes-count"
          sectionTestID="runtime-section-processes"
          onViewAll={() => go(runtimeRoutes.processes)}
          viewAllTestID="runtime-processes-link"
        >
          {processes.length === 0 ? (
            <Text
              style={[styles.empty, { color: theme.colors.textSecondary }]}
              testID="runtime-processes-empty"
            >
              No background tasks
            </Text>
          ) : (
            processes.map((p) => (
              <ProcessCard
                key={p.id}
                process={p}
                testID={`runtime-process-${p.id}`}
                onPress={() => go(runtimeRoutes.process(p.id))}
              />
            ))
          )}
        </Section>

        {/* Claude sessions — live per-chat subprocesses + manual kill. */}
        <Section
          title="Claude sessions"
          icon="bolt"
          count={claudeSessions.length}
          countTestID="runtime-claude-sessions-count"
          sectionTestID="runtime-section-claude-sessions"
        >
          {claudeSessionIdleTtlMs ? (
            <Text
              style={[styles.ttlCaption, { color: theme.colors.textTertiary }]}
              testID="runtime-claude-ttl"
            >
              Idle sessions auto-stop after {Math.round(claudeSessionIdleTtlMs / 60000)}m
            </Text>
          ) : null}
          {claudeSessions.length === 0 ? (
            <Text
              style={[styles.empty, { color: theme.colors.textSecondary }]}
              testID="runtime-claude-sessions-empty"
            >
              No active Claude sessions
            </Text>
          ) : (
            claudeSessions.map((s) => (
              <ClaudeSessionCard
                key={s.chatId}
                session={s}
                testID={`runtime-claude-session-${s.chatId}`}
                killing={killing.has(s.chatId)}
                // rev12: a TERMINAL session (the user's own `claude` in a PC
                // terminal) is not killable via chat:kill-session — the api
                // doesn't own that subprocess. Stop-on-PC ships in F3.
                onKill={s.origin === 'terminal' ? undefined : () => void onKillSession(s.chatId)}
              />
            ))
          )}
        </Section>

        {/* Disconnect (danger) — forget this PC's pairing + return to the QR
            scanner. Replaced the removed "Restart sandbox" (there is no remote
            sandbox to restart; the PC is the runtime). */}
        <Pressable
          testID="runtime-disconnect-entry"
          accessibilityRole="button"
          onPress={() => setDisconnectVisible(true)}
          style={[
            styles.entryRow,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
          ]}
        >
          <Icon name="power" size={18} color={theme.colors.danger} />
          <Text style={[styles.entryText, { color: theme.colors.danger }]}>Disconnect PC</Text>
        </Pressable>
      </ScrollView>

      {/* Disconnect confirm (StorageScreen / chat-delete confirm pattern). */}
      <Modal
        visible={disconnectVisible}
        transparent
        animationType="fade"
        onRequestClose={() => !disconnecting && setDisconnectVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View
            style={[
              styles.modalCard,
              { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
            ]}
            testID="runtime-disconnect-confirm"
          >
            <Text style={[styles.modalTitle, { color: theme.colors.text }]}>
              Disconnect from PC?
            </Text>
            <Text style={[styles.modalBody, { color: theme.colors.textSecondary }]}>
              This forgets the pairing on this device. You&apos;ll need to scan the QR shown by
              `portable start` again to reconnect. Your PC and its work keep running.
            </Text>
            <View style={styles.modalActions}>
              <Pressable
                testID="runtime-disconnect-cancel"
                accessibilityRole="button"
                onPress={() => setDisconnectVisible(false)}
                disabled={disconnecting}
                style={[styles.modalButton, { borderColor: theme.colors.border }]}
              >
                <Text style={[styles.modalButtonText, { color: theme.colors.textSecondary }]}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                testID="runtime-disconnect-submit"
                accessibilityRole="button"
                onPress={onConfirmDisconnect}
                disabled={disconnecting}
                style={[
                  styles.modalButton,
                  { backgroundColor: theme.colors.danger, opacity: disconnecting ? 0.7 : 1 },
                ]}
              >
                {disconnecting ? (
                  <ActivityIndicator size="small" color="#fff" testID="runtime-disconnect-busy" />
                ) : (
                  <Text style={[styles.modalButtonText, { color: '#fff', fontWeight: '700' }]}>
                    Disconnect
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flex: 1 },
  content: { padding: 12, gap: 14 },
  section: {
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  sectionTitle: { fontSize: 14, fontWeight: '700' },
  sectionActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  countBadge: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 10,
    alignItems: 'center',
  },
  countBadgeText: { fontSize: 11, fontWeight: '700' },
  viewAll: { fontSize: 13, fontWeight: '600' },
  sectionBody: { gap: 8 },
  createRow: { flexDirection: 'row', gap: 8 },
  createButton: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8 },
  createText: { fontSize: 13, fontWeight: '600' },
  empty: { fontSize: 13, paddingVertical: 4 },
  ttlCaption: { fontSize: 11, paddingBottom: 2 },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
  },
  entryText: { fontSize: 14, fontWeight: '600', flex: 1 },
  entrySub: { fontSize: 12 },
  hidden: { width: 0, height: 0, opacity: 0 },
  modalBackdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    gap: 12,
  },
  modalTitle: { fontSize: 17, fontWeight: '700' },
  modalBody: { fontSize: 14, lineHeight: 20 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  modalButton: {
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderWidth: StyleSheet.hairlineWidth,
    minWidth: 104,
    alignItems: 'center',
  },
  modalButtonText: { fontSize: 14, fontWeight: '600' },
});
