import { router, useLocalSearchParams } from 'expo-router';

import { FileDiffScreen } from '@/features/repo';

// `/repos/:owner/:repo/diff?path=<p>&staged=0|1[&worktree=<p>]` route — the
// source-control per-file diff screen (portable.dev#17). Thin shell: reads
// `owner`/`repo` + the `path` + `staged` query params (+ the optional `worktree`
// scope from the Worktrees tab) and wires back-nav to the repo's tab.
export default function FileDiffRoute() {
  const { owner, repo, path, staged, worktree } = useLocalSearchParams<{
    owner: string;
    repo: string;
    path?: string;
    staged?: string;
    worktree?: string;
  }>();

  return (
    <FileDiffScreen
      owner={owner ?? ''}
      repo={repo ?? ''}
      filePath={path ?? ''}
      staged={staged === '1' || staged === 'true'}
      worktree={worktree || undefined}
      onBack={() => router.back()}
    />
  );
}
