/**
 * SettingsTab — the RepoPage Settings tab.
 *
 * Read-only repository settings: the repo's
 * metadata (visibility, default branch, language, stars/forks/issues) plus the
 * collaborator list. Thin view over {@link useRepoSettings}.
 */

import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useAppTheme } from '../../theme';
import { useRepoSettings, type Collaborator, type RepoDetails } from './useRepoSettings';

export interface SettingsTabProps {
  owner: string;
  repo: string;
}

export function SettingsTab({ owner, repo }: SettingsTabProps) {
  const { theme } = useAppTheme();
  const vm = useRepoSettings(owner, repo);

  if (vm.isLoading) {
    return (
      <ActivityIndicator
        testID="repo-settings-loading"
        style={styles.center}
        color={theme.colors.primary}
      />
    );
  }
  if (vm.isError || !vm.details) {
    return (
      <View style={styles.center} testID="repo-settings-error">
        <Text style={[styles.errorText, { color: theme.colors.error }]}>
          No repository details available
        </Text>
      </View>
    );
  }

  const d = vm.details;

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="repo-settings">
      <Pressable
        testID="repo-settings-github-link"
        style={styles.linkRow}
        onPress={() => void Linking.openURL(d.html_url ?? `https://github.com/${owner}/${repo}`)}
      >
        <Text style={[styles.linkText, { color: theme.colors.link }]}>View on GitHub ↗</Text>
      </Pressable>

      {d.description ? (
        <Text
          style={[styles.description, { color: theme.colors.textSecondary }]}
          testID="repo-settings-description"
        >
          {d.description}
        </Text>
      ) : null}

      <View style={styles.grid}>
        <DetailRow label="Visibility" value={d.visibility ?? (d.private ? 'private' : 'public')} />
        <DetailRow label="Default branch" value={d.default_branch} />
        {d.language ? <DetailRow label="Language" value={d.language} /> : null}
        <DetailRow label="Stars" value={String(d.stargazers_count ?? 0)} />
        <DetailRow label="Forks" value={String(d.forks_count ?? 0)} />
        <DetailRow label="Open issues" value={String(d.open_issues_count ?? 0)} />
      </View>

      <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Collaborators</Text>
      <Text style={styles.hidden} testID="repo-settings-collaborators-count">
        {vm.collaborators.length}
      </Text>
      {vm.collaborators.length === 0 ? (
        <Text
          style={[styles.emptyText, { color: theme.colors.textSecondary }]}
          testID="repo-settings-collaborators-empty"
        >
          No collaborators
        </Text>
      ) : (
        vm.collaborators.map((c) => <CollaboratorRow key={c.username} collaborator={c} />)
      )}
    </ScrollView>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const { theme } = useAppTheme();
  return (
    <View
      style={[styles.detailRow, { borderBottomColor: theme.colors.borderLight }]}
      testID={`repo-settings-${label.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <Text style={[styles.detailLabel, { color: theme.colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.detailValue, { color: theme.colors.text }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function CollaboratorRow({ collaborator }: { collaborator: Collaborator }) {
  const { theme } = useAppTheme();
  return (
    <View
      style={[styles.collabRow, { borderBottomColor: theme.colors.borderLight }]}
      testID={`repo-settings-collaborator-${collaborator.username}`}
    >
      <Text style={[styles.collabName, { color: theme.colors.text }]} numberOfLines={1}>
        {collaborator.name || collaborator.username}
      </Text>
      <Text style={[styles.collabHandle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
        @{collaborator.username}
      </Text>
    </View>
  );
}

// Re-export so the tab's view stays self-contained (the types live in the hook).
export type { RepoDetails };

const styles = StyleSheet.create({
  scroll: { paddingBottom: 48, gap: 8 },
  hidden: { height: 0, opacity: 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 24 },
  errorText: { fontSize: 15, fontWeight: '600' },
  emptyText: { paddingVertical: 12, textAlign: 'center' },
  linkRow: { paddingVertical: 8 },
  linkText: { fontWeight: '600', fontSize: 15 },
  description: { fontSize: 14, marginBottom: 4 },
  grid: { gap: 2 },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  detailLabel: { fontSize: 13, fontWeight: '600' },
  detailValue: { fontSize: 13, maxWidth: '60%' },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginTop: 16 },
  collabRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  collabName: { fontSize: 14, fontWeight: '600', flex: 1 },
  collabHandle: { fontSize: 12 },
});
