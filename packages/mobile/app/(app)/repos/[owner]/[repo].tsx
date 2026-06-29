import { router, useLocalSearchParams } from 'expo-router';

import { RepoPageScreen } from '@/features/repo';

// `/repos/:owner/:repo` route — the repository detail page (US-E5-002a). Thin
// shell: reads `owner`/`repo` (+ optional `?tab=`) params and wires back-nav.
export default function RepoRoute() {
  const { owner, repo, tab } = useLocalSearchParams<{
    owner: string;
    repo: string;
    tab?: string;
  }>();

  return (
    <RepoPageScreen
      owner={owner ?? ''}
      repo={repo ?? ''}
      tab={tab ?? null}
      onBack={() => router.back()}
    />
  );
}
