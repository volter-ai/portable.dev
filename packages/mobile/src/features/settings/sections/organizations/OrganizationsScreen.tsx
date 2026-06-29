/**
 * GitHub Organizations settings screen (`/settings/organizations`).
 *
 * Thin view over `useOrganizationsViewModel`: the org list comes from
 * `GET /api/user/organizations`; each org renders avatar + login + single-line
 * description + a checkbox-style toggle (checked = NOT blocked) persisted to
 * MMKV via `useBlockedOrgsStore` (client-side only — no backend call). The
 * grant-access flow POSTs `/auth/github/org-access-url`
 * and opens the returned URL in the in-app system browser, then refetches.
 *
 * testIDs:
 *   - settings-organizations            (root; back = settings-organizations-back)
 *   - settings-organizations-loading    (initial fetch spinner)
 *   - settings-organizations-error      (fetch-failed copy, error color)
 *   - settings-organizations-empty      (no-orgs state container)
 *   - settings-organizations-grant      (grant-access button — empty-state CTA
 *                                        and non-empty inline link; the two
 *                                        states never co-render)
 *   - settings-organizations-list       (org list container)
 *   - settings-organizations-org-<login>    (org row pressable / toggle target)
 *   - settings-organizations-check-<login>  (checkmark — rendered ONLY when visible/checked)
 *   - settings-organizations-avatar-<login> (org avatar Image)
 *
 * Deliberate gaps:
 *   - No expand/collapse header chevron — mobile gives the section a full
 *     sub-page (the settingsSections.ts sectioned-nav convention), so it is
 *     always "expanded".
 *   - No popup window / `postMessage('github-org-access-complete')` /
 *     `refresh-connections` CustomEvent plumbing — those are browser mechanics.
 *     The native `openAuthSessionAsync` promise settling IS the
 *     completion signal; the list refetches once on settle.
 */

import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../../../theme';
import { SectionError, SectionLoading, SettingsCard, SettingsSectionScreen } from '../../chrome';
import {
  useOrganizationsViewModel,
  type Organization,
  type OrganizationsViewModelDeps,
} from './useOrganizationsViewModel';

export interface OrganizationsScreenProps {
  /** ViewModel I/O seams (grant-URL request / in-app browser) — injectable for tests. */
  deps?: OrganizationsViewModelDeps;
  /** Back action forwarded to the section shell (default: router.back). */
  onBack?: () => void;
}

export function OrganizationsScreen({ deps, onBack }: OrganizationsScreenProps) {
  const { theme } = useAppTheme();
  const vm = useOrganizationsViewModel(deps);

  return (
    <SettingsSectionScreen
      title="GitHub Organizations"
      testID="settings-organizations"
      onBack={onBack}
    >
      {vm.isLoading && (
        <SectionLoading
          testID="settings-organizations-loading"
          caption="Loading organizations..."
        />
      )}

      {!vm.isLoading && vm.error && (
        <SectionError testID="settings-organizations-error" message={vm.error} />
      )}

      {!vm.isLoading && !vm.error && vm.organizations.length === 0 && (
        <SettingsCard testID="settings-organizations-empty">
          <View style={styles.empty}>
            <Text style={[styles.emptyTitle, { color: theme.colors.textTertiary }]}>
              No organizations found or you haven't granted access yet
            </Text>
            <Text style={[styles.emptySubtext, { color: theme.colors.textTertiary }]}>
              If you're a member of GitHub organizations, you need to grant this app access to see
              them.
            </Text>
            <Pressable
              testID="settings-organizations-grant"
              accessibilityRole="button"
              accessibilityState={{ disabled: vm.grantBusy }}
              disabled={vm.grantBusy}
              onPress={() => void vm.grantAccess()}
              style={[
                styles.grantButton,
                {
                  backgroundColor: vm.grantBusy ? theme.colors.textTertiary : theme.colors.primary,
                  opacity: vm.grantBusy ? 0.7 : 1,
                },
              ]}
            >
              <Text style={styles.grantButtonText}>
                {vm.grantBusy ? 'Waiting for authorization...' : 'Grant Organization Access'}
              </Text>
            </Pressable>
            <Text style={[styles.emptySubtext, { color: theme.colors.textTertiary }]}>
              During sign-in, GitHub will ask which organizations to grant access to
            </Text>
          </View>
        </SettingsCard>
      )}

      {!vm.isLoading && !vm.error && vm.organizations.length > 0 && (
        <SettingsCard testID="settings-organizations-list">
          <View style={styles.list}>
            <Text style={[styles.headerSubtext, { color: theme.colors.textTertiary }]}>
              Select which organizations you want to see repos from. Missing an organization?{' '}
              <Text
                testID="settings-organizations-grant"
                accessibilityRole="button"
                onPress={vm.grantBusy ? undefined : () => void vm.grantAccess()}
                style={[
                  styles.inlineGrant,
                  { color: vm.grantBusy ? theme.colors.textTertiary : theme.colors.primary },
                ]}
              >
                {vm.grantBusy ? 'Waiting...' : 'Grant access'}
              </Text>
            </Text>
            {vm.organizations.map((org) => (
              <OrgRow
                key={org.id}
                org={org}
                checked={vm.isOrgVisible(org.login)}
                onToggle={() => vm.toggleOrg(org.login)}
              />
            ))}
          </View>
        </SettingsCard>
      )}
    </SettingsSectionScreen>
  );
}

/** One org card: checkbox + avatar + login + single-line description. */
function OrgRow({
  org,
  checked,
  onToggle,
}: {
  org: Organization;
  checked: boolean;
  onToggle: () => void;
}) {
  const { theme } = useAppTheme();
  return (
    <Pressable
      testID={`settings-organizations-org-${org.login}`}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={onToggle}
      style={[styles.orgRow, { backgroundColor: theme.colors.hover }]}
    >
      <View
        style={[
          styles.checkbox,
          {
            borderColor: checked ? theme.colors.primary : theme.colors.border,
            backgroundColor: checked ? theme.colors.primary : 'transparent',
          },
        ]}
      >
        {checked && (
          <Text testID={`settings-organizations-check-${org.login}`} style={styles.checkmark}>
            ✓
          </Text>
        )}
      </View>
      <Image
        testID={`settings-organizations-avatar-${org.login}`}
        source={{ uri: org.avatar_url }}
        style={styles.avatar}
      />
      <View style={styles.orgText}>
        <Text style={[styles.orgLogin, { color: theme.colors.text }]}>{org.login}</Text>
        {!!org.description && (
          <Text
            numberOfLines={1}
            style={[styles.orgDescription, { color: theme.colors.textTertiary }]}
          >
            {org.description}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', gap: 12, paddingVertical: 8 },
  emptyTitle: { fontSize: 12, textAlign: 'center' },
  emptySubtext: { fontSize: 11, textAlign: 'center' },
  grantButton: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 6 },
  grantButtonText: { color: '#fff', fontSize: 12, fontWeight: '500' },
  list: { gap: 8 },
  headerSubtext: { fontSize: 11, marginBottom: 4, paddingLeft: 2 },
  inlineGrant: { fontSize: 11, textDecorationLine: 'underline' },
  orgRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: 3,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkmark: { color: '#fff', fontSize: 11, fontWeight: '700', lineHeight: 13 },
  avatar: { width: 32, height: 32, borderRadius: 4 },
  orgText: { flex: 1, minWidth: 0 },
  orgLogin: { fontSize: 12, fontWeight: '500' },
  orgDescription: { fontSize: 11, marginTop: 2 },
});
