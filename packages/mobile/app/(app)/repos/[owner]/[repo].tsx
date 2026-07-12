import { router, useLocalSearchParams } from 'expo-router';

import { RepoPageScreen, useSourceControlFocusRefresh } from '@/features/repo';

// `/repos/:owner/:repo` route — the repository detail page (US-E5-002a). Thin
// shell: reads `owner`/`repo` (+ optional `?tab=`) params and wires back-nav.
export default function RepoRoute() {
  const { owner, repo, tab } = useLocalSearchParams<{
    owner: string;
    repo: string;
    tab?: string;
  }>();

  // Re-kick the source-control reads whenever this route REGAINS focus (e.g.
  // returning from the pushed diff / commit screens). Lives here — the inner
  // tabs have no navigator under test, the route shell always does.
  useSourceControlFocusRefresh(owner ?? '', repo ?? '');

  return (
    <RepoPageScreen
      owner={owner ?? ''}
      repo={repo ?? ''}
      tab={tab ?? null}
      onBack={() => router.back()}
    />
  );
}
