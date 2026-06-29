/**
 * FileNotFound — the 404 state for the native file viewer.
 *
 * When a file 404s, look it up in git
 * history (`useFileHistory`). If the file existed, show the last commit (short sha,
 * author, relative date, message) and a "Restore last committed version" button
 * that writes the committed content back and reloads the viewer. With no history
 * (repo not cloned locally / never committed) it falls back to a plain
 * "File not found" message — the original behaviour.
 */

import { memo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../theme';
import { Icon } from '../../theme/icons/Icon';
import { useFileHistory } from './useFileHistory';

export interface FileNotFoundProps {
  owner: string;
  repo: string;
  filePath: string;
}

/** Format a date as "today" / "yesterday" / "N days/weeks/months ago". */
function formatRelativeDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  const diffMs = Date.now() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
  }
  if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    return `${months} month${months > 1 ? 's' : ''} ago`;
  }
  const years = Math.floor(diffDays / 365);
  return `${years} year${years > 1 ? 's' : ''} ago`;
}

export const FileNotFound = memo(function FileNotFound({
  owner,
  repo,
  filePath,
}: FileNotFoundProps) {
  const { theme } = useAppTheme();
  const { history, isLoading, restore, isRestoring, restoreError, canRestore } = useFileHistory(
    owner,
    repo,
    filePath,
    true
  );

  const lastCommit = history?.lastCommit;

  return (
    <View style={styles.center} testID="file-viewer-not-found">
      <Icon name="file" size={40} color={theme.colors.textTertiary} />
      <Text style={[styles.title, { color: theme.colors.text }]}>File not found</Text>
      <Text style={[styles.path, { color: theme.colors.textSecondary }]}>{filePath}</Text>

      {isLoading ? (
        <ActivityIndicator color={theme.colors.primary} testID="file-not-found-loading" />
      ) : lastCommit ? (
        <View
          style={[
            styles.historyCard,
            { backgroundColor: theme.colors.backgroundElevated, borderColor: theme.colors.border },
          ]}
          testID="file-not-found-history"
        >
          <Text style={[styles.historyHeading, { color: theme.colors.text }]}>
            Last seen in git history
          </Text>
          <View style={styles.commitRow}>
            <Text
              style={[
                styles.sha,
                { color: theme.colors.primary, backgroundColor: theme.colors.primary + '20' },
              ]}
              testID="file-not-found-commit-sha"
            >
              {lastCommit.sha.slice(0, 7)}
            </Text>
            <Text
              style={[styles.commitDate, { color: theme.colors.textTertiary }]}
              testID="file-not-found-commit-date"
            >
              {formatRelativeDate(lastCommit.date)}
            </Text>
          </View>
          <Text
            style={[styles.commitMessage, { color: theme.colors.text }]}
            testID="file-not-found-commit-message"
          >
            {lastCommit.message}
          </Text>
          <Text
            style={[styles.commitAuthor, { color: theme.colors.textSecondary }]}
            testID="file-not-found-commit-author"
          >
            by {lastCommit.author}
          </Text>

          {canRestore && (
            <Pressable
              testID="file-not-found-restore"
              onPress={() => void restore()}
              disabled={isRestoring}
              accessibilityRole="button"
              style={[
                styles.restoreButton,
                { backgroundColor: theme.colors.primary, opacity: isRestoring ? 0.6 : 1 },
              ]}
            >
              {isRestoring ? (
                <ActivityIndicator
                  color={theme.colors.background}
                  testID="file-not-found-restoring"
                />
              ) : (
                <>
                  <Icon name="refresh" size={15} color={theme.colors.background} />
                  <Text style={[styles.restoreText, { color: theme.colors.background }]}>
                    Restore last committed version
                  </Text>
                </>
              )}
            </Pressable>
          )}
          {restoreError && (
            <Text
              style={[styles.errorText, { color: theme.colors.error }]}
              testID="file-not-found-restore-error"
            >
              Couldn't restore the file.
            </Text>
          )}
        </View>
      ) : (
        <Text
          style={[styles.muted, { color: theme.colors.textTertiary }]}
          testID="file-not-found-message"
        >
          This file doesn't exist and has no git history here.
        </Text>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  title: { fontSize: 17, fontWeight: '600' },
  path: { fontSize: 13, textAlign: 'center', fontFamily: 'monospace' },
  muted: { fontSize: 13, textAlign: 'center', marginTop: 8 },
  historyCard: {
    width: '100%',
    maxWidth: 480,
    marginTop: 12,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 8,
  },
  historyHeading: { fontSize: 13, fontWeight: '700' },
  commitRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sha: {
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '600',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  commitDate: { fontSize: 12 },
  commitMessage: { fontSize: 14 },
  commitAuthor: { fontSize: 12 },
  restoreButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  restoreText: { fontSize: 14, fontWeight: '600' },
  errorText: { fontSize: 12, textAlign: 'center', marginTop: 4 },
});
