import { router, useLocalSearchParams } from 'expo-router';

import { CommitDetailScreen } from '@/features/repo';

// `/repos/:owner/:repo/commit?sha=<sha>` route — the source-control commit-detail
// screen (portable.dev#17). Thin shell: reads `owner`/`repo` + the `sha` query
// param and wires back-nav to the repo's Source Control Graph tab.
export default function CommitDetailRoute() {
  const { owner, repo, sha } = useLocalSearchParams<{
    owner: string;
    repo: string;
    sha?: string;
  }>();

  return (
    <CommitDetailScreen
      owner={owner ?? ''}
      repo={repo ?? ''}
      sha={sha ?? ''}
      onBack={() => router.back()}
    />
  );
}
