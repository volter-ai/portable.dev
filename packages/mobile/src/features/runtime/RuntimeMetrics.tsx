/**
 * RuntimeMetrics — the host CPU / memory / uptime panel (fed by the PC-side
 * `HostMetricsService` via `sandbox:metrics`). Pure presentational; data comes
 * from the socket-sourced `runtimeStore`. RAM is host free-vs-total (`os.freemem`
 * excludes reclaimable cache, so it reads higher than Activity Monitor).
 */

import { StyleSheet, Text, View } from 'react-native';

import type { SandboxMetrics } from '@vgit2/shared/types';

import { useAppTheme } from '../../theme';
import { Icon } from '../../theme/icons/Icon';
import { formatBytes, formatUptime, usageColor } from './runtimeHelpers';

function MetricsHeader({ color, iconColor }: { color: string; iconColor: string }) {
  return (
    <View style={styles.titleRow}>
      <Icon name="desktop" size={16} color={iconColor} />
      <Text style={[styles.title, { color }]} testID="runtime-metrics-title">
        Pc status
      </Text>
    </View>
  );
}

function Bar({ percent, color, track }: { percent: number; color: string; track: string }) {
  return (
    <View style={[styles.track, { backgroundColor: track }]}>
      <View
        style={[
          styles.fill,
          { width: `${Math.max(0, Math.min(100, percent))}%`, backgroundColor: color },
        ]}
      />
    </View>
  );
}

export function RuntimeMetrics({ metrics }: { metrics: SandboxMetrics | null }) {
  const { theme } = useAppTheme();
  const c = theme.colors;

  if (!metrics) {
    return (
      <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
        <MetricsHeader color={c.text} iconColor={c.textSecondary} />
        <Text style={[styles.empty, { color: c.textSecondary }]} testID="runtime-metrics-empty">
          Loading metrics…
        </Text>
      </View>
    );
  }

  const cpuPct = Math.round(metrics.cpuUsagePercent);
  const memPct = Math.round(metrics.memoryPercent);

  return (
    <View
      style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}
      testID="runtime-metrics"
    >
      {/* Header */}
      <MetricsHeader color={c.text} iconColor={c.textSecondary} />

      {/* CPU */}
      <View style={styles.metricRow}>
        <Text style={[styles.metricLabel, { color: c.text }]} testID="runtime-metric-cpu">
          CPU {cpuPct}% ({metrics.cpuCores.toFixed(2)}/{metrics.cpuLimitCores} cores)
        </Text>
      </View>
      <Bar percent={cpuPct} color={usageColor(cpuPct, c)} track={c.border} />

      {/* Memory */}
      <View style={styles.metricRow}>
        <Text style={[styles.metricLabel, { color: c.text }]} testID="runtime-metric-memory">
          Memory {memPct}% ({metrics.memoryUsedMB}/{metrics.memoryLimitMB} MB)
        </Text>
      </View>
      <Bar percent={memPct} color={usageColor(memPct, c)} track={c.border} />

      {/* Uptime + workspace size */}
      <View style={styles.footerRow}>
        <Text
          style={[styles.footerText, { color: c.textSecondary }]}
          testID="runtime-metric-uptime"
        >
          Uptime {formatUptime(metrics.uptimeSeconds)}
        </Text>
        <Text style={[styles.footerText, { color: c.textSecondary }]}>
          Workspace {formatBytes(metrics.workspaceSizeGB * 1024 * 1024 * 1024)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 14, fontWeight: '700' },
  empty: { fontSize: 13 },
  metricRow: { flexDirection: 'row', justifyContent: 'space-between' },
  metricLabel: { fontSize: 13, fontWeight: '500' },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4 },
  footerRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  footerText: { fontSize: 12 },
  banner: { borderWidth: 1, borderRadius: 8, padding: 8, marginTop: 4 },
  bannerText: { fontSize: 12, fontWeight: '600' },
});
