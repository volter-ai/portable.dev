/**
 * Connected Services settings screen (`/settings/connections`).
 *
 * Thin view over `useConnectionsViewModel`: a summary line ("{n} service(s)
 * connected · {total} total connection(s)"), the CONNECTED list (one card per
 * connection: favicon w/ first-letter fallback, displayName + service id —
 * BOTH shown, never swapped — connected date, green Active
 * indicator, and Reconnect / Rename / Remove actions, plus Enable/Disable for
 * exclusive services), then the AVAILABLE catalog grouped by category (enabled
 * services only; already-connected exclusives skipped) with "+ Add" buttons.
 *
 * Connect/Reconnect opens the in-app browser at
 * `${sandboxUrl}/connections?service=X&token=<jwt>` (the sanctioned native v1
 * flow — the sandbox handles the per-service OAuth/credential
 * forms) and refetches the list when the browser closes.
 *
 * testIDs:
 *   - settings-connections                       (root; back = settings-connections-back)
 *   - settings-connections-loading               (initial fetch spinner)
 *   - settings-connections-error                 (+ settings-connections-error-retry)
 *   - settings-connections-count                 (hidden, = connections.length — virtualization-proof)
 *   - settings-connections-summary               (summary line)
 *   - settings-connections-empty                 (no connections — "No services connected")
 *   - settings-connections-connection-<id>       (connection card, id = connectionId)
 *   - settings-connections-active-<id>           (green Active indicator — rendered ONLY when isActive)
 *   - settings-connections-reconnect-<id>        (Reconnect → browser connect flow)
 *   - settings-connections-rename-<id>           (enter rename mode)
 *   - settings-connections-rename-input-<id>     (inline rename TextInput)
 *   - settings-connections-rename-save-<id>      (save → PATCH .../rename)
 *   - settings-connections-rename-cancel-<id>    (cancel rename mode)
 *   - settings-connections-disconnect-<id>       (Remove → confirm step)
 *   - settings-connections-disconnect-confirm-<id> (confirm → DELETE)
 *   - settings-connections-disconnect-cancel-<id>  (dismiss the confirm step)
 *   - settings-connections-toggle-<id>           (Enable/Disable — exclusive services only)
 *   - settings-connections-category-<category>   (available group container)
 *   - settings-connections-service-<service>     (available service card)
 *   - settings-connections-add-<service>         ("+ Add" → browser connect flow)
 *
 * Deliberate gaps:
 *   - No per-service NATIVE OAuth/credential forms (there are 20+ bespoke flows:
 *     OAuth popups, Fly.io SSO, GitHub App install polling, manual credential
 *     fields). Native v1 routes ALL connect/reconnect flows
 *     through the sandbox in the in-app browser (the
 *     `ActiveChatScreen.startConnection` precedent), which already implements
 *     every flow; the list refetches when the browser closes.
 *   - No My/All tabs, search bar, or category filter chips — mobile renders the
 *     connected list and the grouped catalog on one scrollable sub-page (the
 *     sectioned-nav convention); category grouping replaces the filter.
 *   - No expanded-card account-info panel (avatars/workspace/region/installation
 *     metadata from `credentials.accountInfo`) and no "Use for GitHub" activate
 *     button — both need per-service credential plumbing deferred with the
 *     native forms. Exclusive Enable/Disable IS wired (toggle-active).
 *   - Disconnect confirm is an inline two-step (Remove → Confirm), not a browser
 *     confirm dialog (there is no confirm dialog otherwise — it deletes
 *     immediately; the confirm step is a mobile safety affordance for the touch
 *     target).
 */

import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ServiceConfig, ServiceConnection } from '@vgit2/shared/types';
import { getServiceFavicon } from '@vgit2/shared/types';

import { useAppTheme, withAlpha } from '../../../../theme';
import { SectionError, SectionLabel, SectionLoading, SettingsCard } from '../../chrome';
import { SettingsSectionScreen } from '../../chrome';
import {
  useConnectionsViewModel,
  type ConnectionsViewModel,
  type ConnectionsViewModelDeps,
} from './useConnectionsViewModel';

export interface ConnectionsScreenProps {
  /** ViewModel I/O seams (sandbox URL / token / in-app browser) — injectable for tests. */
  deps?: ConnectionsViewModelDeps;
  /** Back action forwarded to the section shell (default: router.back). */
  onBack?: () => void;
}

export function ConnectionsScreen({ deps, onBack }: ConnectionsScreenProps) {
  const { theme } = useAppTheme();
  const vm = useConnectionsViewModel(deps);

  return (
    <SettingsSectionScreen title="Connected Services" testID="settings-connections" onBack={onBack}>
      {vm.isLoading && (
        <SectionLoading testID="settings-connections-loading" caption="Loading connections..." />
      )}

      {!vm.isLoading && vm.error && (
        <SectionError testID="settings-connections-error" message={vm.error} onRetry={vm.retry} />
      )}

      {!vm.isLoading && !vm.error && (
        <>
          {/* Hidden, virtualization-proof connection count. */}
          <Text testID="settings-connections-count" style={styles.hidden}>
            {vm.totalConnections}
          </Text>

          {/* Summary line. */}
          <Text
            testID="settings-connections-summary"
            style={[styles.summary, { color: theme.colors.textSecondary }]}
          >
            {vm.totalConnections === 0
              ? 'No services connected'
              : `${vm.connectedServicesCount} service${vm.connectedServicesCount === 1 ? '' : 's'} connected · ${vm.totalConnections} total connection${vm.totalConnections === 1 ? '' : 's'}`}
          </Text>

          {/* CONNECTED list. */}
          <View>
            <SectionLabel>Connected</SectionLabel>
            {vm.connections.length === 0 ? (
              <SettingsCard testID="settings-connections-empty">
                <Text style={[styles.emptyText, { color: theme.colors.textTertiary }]}>
                  🔌 No connections yet
                </Text>
                <Text style={[styles.emptySubtext, { color: theme.colors.textTertiary }]}>
                  Connect services to enhance AI workflows
                </Text>
              </SettingsCard>
            ) : (
              <View style={styles.list}>
                {vm.connections.map((connection) => (
                  <ConnectionCard key={connection.connectionId} connection={connection} vm={vm} />
                ))}
              </View>
            )}
          </View>

          {/* AVAILABLE catalog, grouped by category. */}
          {vm.availableGroups.map((group) => (
            <View key={group.category} testID={`settings-connections-category-${group.category}`}>
              <SectionLabel>{group.label}</SectionLabel>
              <View style={styles.list}>
                {group.services.map((service) => (
                  <ServiceCard key={service.service} config={service} vm={vm} />
                ))}
              </View>
            </View>
          ))}
        </>
      )}
    </SettingsSectionScreen>
  );
}

// ---------------------------------------------------------------------------
// Service icon — favicon Image with first-letter fallback; emoji icons as Text.
// ---------------------------------------------------------------------------

function ServiceIcon({ name, domain, icon }: { name: string; domain?: string; icon?: string }) {
  const { theme } = useAppTheme();
  const [imgError, setImgError] = useState(false);

  // Legacy emoji icon (non-ASCII short string) renders as Text, not an Image.
  const isEmoji = !!icon && !/^[\x20-\x7e]+$/.test(icon);

  return (
    <View style={[styles.iconBox, { backgroundColor: theme.colors.surface }]}>
      {isEmoji ? (
        <Text style={styles.iconEmoji}>{icon}</Text>
      ) : domain && !imgError ? (
        <Image
          source={{ uri: getServiceFavicon(domain, 128) }}
          style={styles.iconImage}
          onError={() => setImgError(true)}
        />
      ) : (
        <Text style={[styles.iconLetter, { color: theme.colors.textSecondary }]}>
          {(name || '?').charAt(0).toUpperCase()}
        </Text>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Connected connection card
// ---------------------------------------------------------------------------

/** "Mon DD, YYYY". */
function formatConnectedDate(value: Date | string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function ConnectionCard({
  connection,
  vm,
}: {
  connection: ServiceConnection;
  vm: ConnectionsViewModel;
}) {
  const { theme } = useAppTheme();
  const config = vm.serviceConfigFor(connection.service);

  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(connection.displayName);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const id = connection.connectionId;
  const serviceName = config?.name || connection.service;
  // Fall back to `<service>.com`.
  const domain = config?.domain || `${connection.service}.com`;
  const busy = vm.renamingId === id || vm.disconnectingId === id || vm.togglingId === id;

  const saveRename = () => {
    const trimmed = draftName.trim();
    setIsRenaming(false);
    if (!trimmed || trimmed === connection.displayName) return; // no-op
    void vm.rename(id, trimmed);
  };

  return (
    <SettingsCard testID={`settings-connections-connection-${id}`}>
      <View style={styles.cardHeader}>
        <ServiceIcon name={serviceName} domain={domain} icon={config?.icon} />
        <View style={styles.cardText}>
          {/* displayName is the main line, the service id the subtitle — don't swap. */}
          <Text style={[styles.displayName, { color: theme.colors.text }]} numberOfLines={1}>
            {connection.displayName}
          </Text>
          <Text style={[styles.serviceId, { color: theme.colors.textSecondary }]} numberOfLines={1}>
            {connection.service}
          </Text>
        </View>
        {connection.isActive && (
          <View
            testID={`settings-connections-active-${id}`}
            style={[styles.activeBadge, { backgroundColor: withAlpha(theme.colors.success, '20') }]}
          >
            <Text style={[styles.activeBadgeText, { color: theme.colors.success }]}>● Active</Text>
          </View>
        )}
      </View>

      <Text style={[styles.connectedDate, { color: theme.colors.textTertiary }]}>
        Connected {formatConnectedDate(connection.connectedAt)}
      </Text>

      {isRenaming ? (
        <View style={styles.actionsRow}>
          <TextInput
            testID={`settings-connections-rename-input-${id}`}
            value={draftName}
            onChangeText={setDraftName}
            autoFocus
            style={[
              styles.renameInput,
              {
                color: theme.colors.text,
                borderColor: theme.colors.primary,
                backgroundColor: theme.colors.hover,
              },
            ]}
          />
          <ActionButton
            testID={`settings-connections-rename-save-${id}`}
            label="Save"
            color={theme.colors.success}
            onPress={saveRename}
            disabled={busy}
          />
          <ActionButton
            testID={`settings-connections-rename-cancel-${id}`}
            label="Cancel"
            color={theme.colors.textSecondary}
            onPress={() => {
              setDraftName(connection.displayName);
              setIsRenaming(false);
            }}
          />
        </View>
      ) : confirmingRemove ? (
        <View style={styles.actionsRow}>
          <Text style={[styles.confirmText, { color: theme.colors.textSecondary }]}>
            Remove this connection?
          </Text>
          <ActionButton
            testID={`settings-connections-disconnect-confirm-${id}`}
            label={vm.disconnectingId === id ? '...' : 'Confirm'}
            color={theme.colors.error}
            onPress={() => {
              setConfirmingRemove(false);
              void vm.disconnect(id);
            }}
            disabled={busy}
          />
          <ActionButton
            testID={`settings-connections-disconnect-cancel-${id}`}
            label="Cancel"
            color={theme.colors.textSecondary}
            onPress={() => setConfirmingRemove(false)}
          />
        </View>
      ) : (
        <View style={styles.actionsRow}>
          {config?.isExclusive && (
            <ActionButton
              testID={`settings-connections-toggle-${id}`}
              label={vm.togglingId === id ? '...' : connection.isActive ? 'Disable' : 'Enable'}
              color={connection.isActive ? theme.colors.warning : theme.colors.success}
              onPress={() => void vm.toggleActive(id, !connection.isActive)}
              disabled={busy}
            />
          )}
          <ActionButton
            testID={`settings-connections-reconnect-${id}`}
            label={vm.connectingService === connection.service ? '...' : 'Reconnect'}
            color={theme.colors.primary}
            onPress={() => void vm.connect(connection.service)}
            disabled={busy || vm.connectingService !== null}
          />
          <ActionButton
            testID={`settings-connections-rename-${id}`}
            label="Rename"
            color={theme.colors.textSecondary}
            onPress={() => {
              setDraftName(connection.displayName);
              setIsRenaming(true);
            }}
            disabled={busy}
          />
          <ActionButton
            testID={`settings-connections-disconnect-${id}`}
            label="Remove"
            color={theme.colors.error}
            onPress={() => setConfirmingRemove(true)}
            disabled={busy}
          />
        </View>
      )}
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Available service card
// ---------------------------------------------------------------------------

function ServiceCard({ config, vm }: { config: ServiceConfig; vm: ConnectionsViewModel }) {
  const { theme } = useAppTheme();
  const count = vm.connectionCountFor(config.service);
  const busy = vm.connectingService !== null;

  return (
    <SettingsCard testID={`settings-connections-service-${config.service}`}>
      <View style={styles.cardHeader}>
        <ServiceIcon name={config.name} domain={config.domain} icon={config.icon} />
        <View style={styles.cardText}>
          <View style={styles.serviceNameRow}>
            <Text style={[styles.displayName, { color: theme.colors.text }]} numberOfLines={1}>
              {config.name}
            </Text>
            {count > 0 && (
              <Text style={[styles.connectedCount, { color: theme.colors.success }]}>
                {count} connected
              </Text>
            )}
          </View>
          {!!config.description && (
            <Text
              style={[styles.serviceDescription, { color: theme.colors.textTertiary }]}
              numberOfLines={2}
            >
              {config.description}
            </Text>
          )}
        </View>
        <ActionButton
          testID={`settings-connections-add-${config.service}`}
          label={vm.connectingService === config.service ? '...' : '+ Add'}
          color={theme.colors.primary}
          onPress={() => void vm.connect(config.service)}
          disabled={busy}
        />
      </View>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Small bordered action button (transparent-bg + colored-border pattern)
// ---------------------------------------------------------------------------

function ActionButton({
  testID,
  label,
  color,
  onPress,
  disabled,
}: {
  testID: string;
  label: string;
  color: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.actionButton, { borderColor: color }, disabled && styles.disabled]}
    >
      <Text style={[styles.actionButtonText, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The established hidden-testID pattern (chat-directory-count) — NOT
  // `display:'none'`, which RNTL's default query config treats as not-rendered.
  hidden: { fontSize: 12, opacity: 0, height: 0 },
  summary: { fontSize: 13, fontWeight: '500' },
  list: { gap: 8 },
  emptyText: { fontSize: 13, textAlign: 'center' },
  emptySubtext: { fontSize: 11, textAlign: 'center', marginTop: 4 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardText: { flex: 1, minWidth: 0 },
  serviceNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  displayName: { fontSize: 13, fontWeight: '600' },
  serviceId: { fontSize: 11, marginTop: 2 },
  serviceDescription: { fontSize: 11, marginTop: 2, lineHeight: 15 },
  connectedCount: { fontSize: 11, fontWeight: '500' },
  activeBadge: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  activeBadgeText: { fontSize: 11, fontWeight: '600' },
  connectedDate: { fontSize: 11, marginTop: 8 },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  confirmText: { flex: 1, fontSize: 12 },
  renameInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    fontSize: 13,
  },
  actionButton: {
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: 'transparent',
  },
  actionButtonText: { fontSize: 12, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  iconBox: {
    width: 28,
    height: 28,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconImage: { width: 18, height: 18 },
  iconEmoji: { fontSize: 15 },
  iconLetter: { fontSize: 13, fontWeight: '700' },
});
