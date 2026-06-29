/**
 * SettingsConnectPc — the always-available "Connect PC" entry in the settings root.
 *
 * Unlike the boot-time {@link PcConnectGate} (only shown when no PC is linked) and
 * the Home/Repos error cards (only shown on a failed fetch), this entry is ALWAYS
 * reachable from Settings, so a user can re-pair (or switch PCs) at any time — the
 * PC connection is volatile (the gateway's TunnelRegistry is in-memory; a token can
 * be rejected), and there was previously no in-app way back to the scanner.
 *
 * It shows the currently-connected pcId (or "Not connected") and opens the
 * {@link PcConnectModal} re-scan flow. Self-contained + seam-injectable so it
 * unit-tests with no native module; the modal's default scanner lazy-loads
 * `expo-camera` only when actually rendered.
 *
 * testIDs: `settings-connect-pc` (row), `settings-connect-pc-status` (subtitle).
 */

import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, useAppTheme } from '../../theme';

import { getConnectedPcId } from '../pc-connect/connectedPcStore';
import { PcConnectModal, type PcConnectModalProps } from '../pc-connect/PcConnectModal';

export interface SettingsConnectPcProps {
  /** Seam: read the currently-connected PC id (default: SecureStore reader). */
  getPcId?: () => Promise<string | null>;
  /** Seams forwarded to the re-scan modal (tests inject fakes). */
  pcConnect?: Pick<PcConnectModalProps, 'link' | 'connect' | 'renderScanner'>;
}

/** `pc_<hex>` → a recognizable short form for the status line. */
function shortPcId(pcId: string): string {
  return pcId.length > 16 ? `${pcId.slice(0, 14)}…` : pcId;
}

export function SettingsConnectPc({ getPcId, pcConnect }: SettingsConnectPcProps = {}) {
  const { theme } = useAppTheme();
  const readPcId = getPcId ?? getConnectedPcId;
  const [pcId, setPcId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => {
    void readPcId()
      .then(setPcId)
      .catch(() => setPcId(null));
  }, [readPcId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const subtitle = pcId ? `Connected: ${shortPcId(pcId)}` : 'Not connected — scan the pairing QR';

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: theme.colors.textTertiary }]}>Device</Text>
      <Pressable
        testID="settings-connect-pc"
        accessibilityRole="button"
        style={[styles.row, { backgroundColor: theme.colors.surface }]}
        onPress={() => setOpen(true)}
      >
        <Icon name="desktop" size={18} color={theme.colors.textSecondary} />
        <View style={styles.text}>
          <Text style={[styles.rowLabel, { color: theme.colors.text }]}>Connect PC</Text>
          <Text
            testID="settings-connect-pc-status"
            style={[styles.rowSub, { color: theme.colors.textTertiary }]}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        </View>
        <Text style={[styles.chevron, { color: theme.colors.textTertiary }]}>›</Text>
      </Pressable>

      <PcConnectModal
        visible={open}
        link={pcConnect?.link}
        connect={pcConnect?.connect}
        renderScanner={pcConnect?.renderScanner}
        onConnected={refresh}
        onDismiss={() => setOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  label: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  text: { flex: 1, minWidth: 0 },
  rowLabel: { fontSize: 13, fontWeight: '600' },
  rowSub: { fontSize: 12, marginTop: 2 },
  chevron: { fontSize: 16, paddingTop: 2 },
});
